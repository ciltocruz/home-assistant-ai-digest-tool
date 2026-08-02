import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SQLiteDigestJobStore } from './sqlite-digest-job-store.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('SQLiteDigestJobStore', () => {
  it('deduplicates concurrent enqueue calls by triggerWindowId', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const store = new SQLiteDigestJobStore(db, { now: () => new Date('2026-07-07T08:00:00.000Z') });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.enqueue({ triggerWindowId: 'daily:2026-07-07', kind: 'daily' }))
    );

    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(results.filter((result) => result.status === 'queued')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'already_queued')).toHaveLength(7);
    expect({ ...(db.prepare('select count(*) as count from digest_jobs').get() as { count: number }) }).toEqual({ count: 1 });
  });

  it('leases, completes, and retries jobs without creating duplicate trigger windows', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const store = new SQLiteDigestJobStore(db, { now: () => new Date('2026-07-07T08:00:00.000Z') });

    const first = await store.enqueue({ triggerWindowId: 'manual:unique-window', kind: 'manual' });
    const leased = await store.leaseNext({ leaseSeconds: 60 });
    expect(leased?.id).toBe(first.jobId);
    expect(leased?.status).toBe('running');

    await store.retry(first.jobId, 'provider unavailable');
    const retryable = db.prepare('select status, attempts, last_error from digest_jobs where id = ?').get(first.jobId);
    expect({ ...(retryable as { status: string; attempts: number; last_error: string }) }).toEqual({
      status: 'queued',
      attempts: 1,
      last_error: 'provider unavailable'
    });

    await store.leaseNext({ leaseSeconds: 60 });
    await store.complete(first.jobId);
    expect({ ...(db.prepare('select status from digest_jobs where id = ?').get(first.jobId) as { status: string }) }).toEqual({
      status: 'completed'
    });
  });

  it('reclaims running jobs whose lease expired', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    let now = new Date('2026-07-07T08:00:00.000Z');
    const store = new SQLiteDigestJobStore(db, { now: () => now });

    const first = await store.enqueue({ triggerWindowId: 'daily:expired-lease', kind: 'daily' });
    const firstLease = await store.leaseNext({ leaseSeconds: 30 });
    expect(firstLease?.id).toBe(first.jobId);

    now = new Date('2026-07-07T08:00:31.000Z');
    const reclaimed = await store.leaseNext({ leaseSeconds: 60 });

    expect(reclaimed?.id).toBe(first.jobId);
    expect(reclaimed?.status).toBe('running');
    expect(reclaimed?.leaseUntil).toBe('2026-07-07T08:01:31.000Z');
  });

  it('leases a queued job atomically across competing workers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ha-digest-jobs-'));
    const firstDb = await openTestDatabase(join(directory, 'app.db'));
    const secondDb = await openTestDatabase(join(directory, 'app.db'));
    const clock = { now: () => new Date('2026-07-07T08:00:00.000Z') };
    runMigrations(firstDb);
    const firstWorker = new SQLiteDigestJobStore(firstDb, clock);
    const secondWorker = new SQLiteDigestJobStore(secondDb, clock);

    try {
      await firstWorker.enqueue({ triggerWindowId: 'daily:competing-workers', kind: 'daily' });

      const [firstLease, secondLease] = await Promise.all([
        firstWorker.leaseNext({ leaseSeconds: 60 }),
        secondWorker.leaseNext({ leaseSeconds: 60 })
      ]);

      expect([firstLease, secondLease].filter(Boolean)).toHaveLength(1);
      expect(readLeaseState(firstDb, 'daily:competing-workers')).toEqual({
        status: 'running',
        lease_until: '2026-07-07T08:01:00.000Z'
      });
    } finally {
      firstDb.close();
      secondDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies deterministic retry backoff and marks exhausted jobs as failed', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    let now = new Date('2026-07-07T08:00:00.000Z');
    const store = new SQLiteDigestJobStore(db, { now: () => now }, { maxAttempts: 3, baseDelaySeconds: 10, backoffMultiplier: 2 });

    const first = await store.enqueue({ triggerWindowId: 'daily:retry-policy', kind: 'daily' });
    await store.leaseNext({ leaseSeconds: 60 });

    await store.retry(first.jobId, 'first failure');
    expect(readJobRetryState(db, first.jobId)).toEqual({
      status: 'queued',
      attempts: 1,
      available_at: '2026-07-07T08:00:10.000Z',
      last_error: 'first failure'
    });

    now = new Date('2026-07-07T08:00:10.000Z');
    await store.leaseNext({ leaseSeconds: 60 });
    await store.retry(first.jobId, 'second failure');
    expect(readJobRetryState(db, first.jobId)).toEqual({
      status: 'queued',
      attempts: 2,
      available_at: '2026-07-07T08:00:30.000Z',
      last_error: 'second failure'
    });

    now = new Date('2026-07-07T08:00:30.000Z');
    await store.leaseNext({ leaseSeconds: 60 });
    await store.retry(first.jobId, 'third failure');

    expect(readJobRetryState(db, first.jobId)).toEqual({
      status: 'failed',
      attempts: 3,
      available_at: '2026-07-07T08:00:30.000Z',
      last_error: 'third failure'
    });
    expect(await store.leaseNext({ leaseSeconds: 60 })).toBeNull();
  });

  it('persists stages, report linkage, recovery, and one manual retry across a reopened database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ha-digest-job-lifecycle-'));
    const databasePath = join(directory, 'app.db');
    let now = new Date('2026-08-01T10:00:00.000Z');
    const firstDb = await openTestDatabase(databasePath);
    runMigrations(firstDb);
    const first = new SQLiteDigestJobStore(firstDb, { now: () => now });
    const queued = await first.enqueue({ triggerWindowId: 'manual:restart-window', kind: 'manual', settingsSnapshot: { privacyLevel: 'balanced' } });
    await first.leaseNext({ leaseSeconds: 30 });
    await first.setStage(queued.jobId, 'generating');
    firstDb.close();

    now = new Date('2026-08-01T10:00:31.000Z');
    const reopenedDb = await openTestDatabase(databasePath);
    const reopened = new SQLiteDigestJobStore(reopenedDb, { now: () => now });
    const recovered = await reopened.leaseNext({ leaseSeconds: 30 });
    expect(recovered).toMatchObject({ id: queued.jobId, status: 'running', stage: 'generating' });

    await reopened.fail(queued.jobId, 'HOME_ASSISTANT_UNAVAILABLE', 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.');
    expect(await reopened.get(queued.jobId)).toMatchObject({ status: 'failed', stage: 'failed', errorCode: 'HOME_ASSISTANT_UNAVAILABLE', retryAvailable: true });
    expect(await reopened.retryFailed(queued.jobId)).toMatchObject({ id: queued.jobId, status: 'queued', stage: 'queued', retryCount: 1 });
    expect(await reopened.retryFailed(queued.jobId)).toMatchObject({ id: queued.jobId, status: 'queued', retryCount: 1 });

    await reopened.leaseNext({ leaseSeconds: 30 });
    await reopened.complete(queued.jobId, 'report-1');
    expect(await reopened.get(queued.jobId)).toMatchObject({ status: 'completed', stage: 'completed', reportId: 'report-1', retryAvailable: false });
    reopenedDb.close();
    await rm(directory, { recursive: true, force: true });
  });
});

function readJobRetryState(db: Awaited<ReturnType<typeof openTestDatabase>>, id: string) {
  return {
    ...(db.prepare('select status, attempts, available_at, last_error from digest_jobs where id = ?').get(id) as {
      status: string;
      attempts: number;
      available_at: string;
      last_error: string;
    })
  };
}

function readLeaseState(db: Awaited<ReturnType<typeof openTestDatabase>>, triggerWindowId: string) {
  return {
    ...(db.prepare('select status, lease_until from digest_jobs where trigger_window_id = ?').get(triggerWindowId) as {
      status: string;
      lease_until: string;
    })
  };
}

async function openTestDatabase(path = ':memory:') {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path);
}
