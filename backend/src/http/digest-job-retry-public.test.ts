import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigestWorker } from '../application/digest-worker.js';
import { SQLiteAuthStore } from '../adapters/persistence/sqlite-auth-store.js';
import { runMigrations } from '../adapters/persistence/migrations.js';
import { SQLiteDigestJobStore } from '../adapters/persistence/sqlite-digest-job-store.js';
import { createApp, type BackendApiServices } from './app.js';

let testDb: DatabaseSync | undefined;

describe('public digest job retry seam', () => {
  let app: ReturnType<typeof createApp> | undefined;

  afterEach(async () => {
    await app?.close();
    testDb?.close();
    app = undefined;
    testDb = undefined;
  });

  it('retries a failed job through an authenticated session and preserves a detailed provider failure on the next worker run', async () => {
    const fixture = await createFixture();
    const originalFailure = 'Gemini 404: model gemini-flash-latest was unavailable during the first run.';
    const jobId = await seedFailedJob(fixture.jobs, originalFailure);
    app = createApp({ services: fixture.services, auth: { sessionTtlMs: 60_000 } });
    const session = await register(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/digests/jobs/${jobId}/retry`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({ id: jobId, status: 'queued', stage: 'queued', retryCount: 1, retryAvailable: false }));
    expect(fixture.wake).toHaveBeenCalledTimes(1);
    expect(await fixture.jobs.get(jobId)).toMatchObject({ status: 'queued', retryCount: 1 });

    const worker = new DigestWorker({
      jobs: fixture.jobs,
      analysis: { runWithStages: async () => { throw new Error(`AI_ANALYSIS_UNAVAILABLE: ${originalFailure}`); } }
    });
    await worker.runOnce();

    expect(await fixture.jobs.get(jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      errorMessage: expect.stringContaining(originalFailure)
    });
  });

  it('keeps one CSRF token valid across duplicate session bootstrap and lets that tab retry the job', async () => {
    const fixture = await createFixture();
    const jobId = await seedFailedJob(fixture.jobs, 'Gemini 404: initial provider failure.');
    app = createApp({ services: fixture.services, auth: { sessionTtlMs: 60_000 } });
    const session = await register(app);

    const resumed = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ csrfToken: string }>().csrfToken).toBe(session.csrfToken);

    const retry = await app.inject({
      method: 'POST',
      url: `/api/digests/jobs/${jobId}/retry`,
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
    });

    expect(retry.statusCode).toBe(202);
    expect(await fixture.jobs.get(jobId)).toMatchObject({ status: 'queued', retryCount: 1 });
  });

  it('keeps the CSRF token stable across reload-style session resumes in multiple tabs', async () => {
    const fixture = await createFixture();
    app = createApp({ services: fixture.services, auth: { sessionTtlMs: 60_000 } });
    const session = await register(app);

    const firstResume = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: session.cookie } });
    const secondResume = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: session.cookie } });

    expect(firstResume.statusCode).toBe(200);
    expect(secondResume.statusCode).toBe(200);
    expect(secondResume.json<{ csrfToken: string }>().csrfToken).toBe(firstResume.json<{ csrfToken: string }>().csrfToken);
  });

  it('rejects missing and stale CSRF tokens without committing the retry transition', async () => {
    const fixture = await createFixture();
    const jobId = await seedFailedJob(fixture.jobs, 'Gemini 404: initial provider failure.');
    app = createApp({ services: fixture.services, auth: { sessionTtlMs: 60_000 } });
    const session = await register(app);

    const missing = await app.inject({ method: 'POST', url: `/api/digests/jobs/${jobId}/retry`, headers: { cookie: session.cookie } });
    const stale = await app.inject({ method: 'POST', url: `/api/digests/jobs/${jobId}/retry`, headers: { cookie: session.cookie, 'x-csrf-token': 'stale-csrf-token' } });

    expect(missing.statusCode).toBe(403);
    expect(stale.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'CSRF_REQUIRED' });
    expect(stale.json()).toMatchObject({ code: 'CSRF_REQUIRED' });
    expect(await fixture.jobs.get(jobId)).toMatchObject({ status: 'failed', retryCount: 0, retryAvailable: true });
  });
});

async function createFixture() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  testDb = new DatabaseSync(':memory:');
  runMigrations(testDb);
  const auth = new SQLiteAuthStore(testDb, () => Date.parse('2026-08-05T19:00:00.000Z'));
  const jobs = new SQLiteDigestJobStore(testDb, { now: () => new Date('2026-08-05T19:00:00.000Z') });
  const wake = vi.fn();
  const services: BackendApiServices = {
    setup: { complete: async () => ({ haUrl: 'http://ha.test:8123', ai: { provider: 'gemini', keyMask: 'masked', ref: 'ref' }, notifiers: [] }) },
    auth,
    settings: { get: async () => ({ homeAssistant: { url: 'http://ha.test:8123', token: { configured: true } }, ai: { provider: 'gemini', key: { configured: true } }, notifications: { channel: 'none' }, schedules: [], privacyLevel: 'balanced', retentionDays: 30 }), update: async () => { throw new Error('unused'); } },
    digestJobs: { enqueue: jobs.enqueue.bind(jobs), get: jobs.get.bind(jobs), retryFailed: jobs.retryFailed.bind(jobs) },
    digestWorker: { wake },
    reports: { list: async () => [], get: async () => null },
    notes: { add: async () => { throw new Error('unused'); }, listWindow: async () => [] },
    ignores: { add: async () => { throw new Error('unused'); }, remove: async () => undefined, listActive: async () => [] },
    notifiers: { test: async () => ({ status: 'success', message: 'ok', checkedAt: '2026-08-05T19:00:00.000Z' }), send: async () => ({ status: 'skipped', targetRef: 'ref' }) }
  };
  return { jobs, services, wake };
}

async function seedFailedJob(jobs: SQLiteDigestJobStore, errorMessage: string): Promise<string> {
  const queued = await jobs.enqueue({ kind: 'manual', triggerWindowId: `manual:${errorMessage}` });
  await jobs.leaseNext();
  await jobs.fail(queued.jobId, 'AI_PROVIDER_UNAVAILABLE', errorMessage);
  return queued.jobId;
}

async function register(app: ReturnType<typeof createApp>) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'retry-test-password', language: 'es' } });
  return { cookie: cookieHeader(response.headers['set-cookie']), csrfToken: response.json<{ csrfToken: string }>().csrfToken };
}

function cookieHeader(value: string | string[] | undefined): string {
  const cookies = Array.isArray(value) ? value : value ? [value] : [];
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}
