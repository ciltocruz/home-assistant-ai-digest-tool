import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/persistence/migrations.js';
import { SQLiteDigestJobStore } from '../adapters/persistence/sqlite-digest-job-store.js';
import { SQLiteScheduleStateStore } from '../adapters/persistence/sqlite-v2-stores.js';
import { dueSlots, Scheduler, type ScheduleDefinition } from './scheduler.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('Scheduler', () => {
  it('requires a schedule and supports default-timezone custom weekday schedules', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const clock = fakeClock('2026-08-03T09:00:00.000Z');
    const jobs = new SQLiteDigestJobStore(db, { now: () => new Date(clock.now()) });
    const state = new SQLiteScheduleStateStore(db, clock.now);

    expect(() => new Scheduler({ schedules: [], jobs, state, clock })).toThrow('SCHEDULE_REQUIRED');
    const scheduler = new Scheduler({ schedules: [{ id: 'custom', mode: 'custom', enabled: true, weekdays: [1], time: '08:00' }], jobs, state, clock });

    await expect(scheduler.runDue()).resolves.toEqual({ queued: ['v2:custom:1785744000000'], failures: [] });
  });

  it('shifts spring DST gaps forward and uses the earlier instant for autumn overlaps', () => {
    const schedule: ScheduleDefinition = { id: 'madrid', mode: 'preset', preset: 'daily', enabled: true, time: '02:30', timezone: 'Europe/Madrid' };

    expect(dueSlots(schedule, null, '2025-03-30T04:00:00.000Z')).toMatchObject([{ at: '2025-03-30T01:30:00Z' }]);
    expect(dueSlots(schedule, null, '2025-10-26T03:00:00.000Z')).toMatchObject([{ at: '2025-10-26T00:30:00Z' }]);
  });

  it('queues an immediate first run and durable missed slots once across restart, then leases each job once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ha-digest-scheduler-'));
    const databasePath = join(directory, 'app.db');
    const db = await openTestDatabase(databasePath);
    runMigrations(db);
    const clock = fakeClock('2026-08-03T09:00:00.000Z');
    const jobs = new SQLiteDigestJobStore(db, { now: () => new Date(clock.now()) });
    const state = new SQLiteScheduleStateStore(db, clock.now);
    const schedules: ScheduleDefinition[] = [{ id: 'daily', mode: 'preset', preset: 'daily', enabled: true, time: '08:00', timezone: 'UTC' }];
    const first = new Scheduler({ schedules, jobs, state, clock });

    expect(await first.runImmediateFirst()).toEqual({ queued: ['v2:initial'], failures: [] });
    expect(await first.runDue()).toEqual({ queued: ['v2:daily:1785744000000'], failures: [] });

    db.close();
    clock.set('2026-08-04T10:00:00.000Z');
    const reopenedDb = await openTestDatabase(databasePath);
    runMigrations(reopenedDb);
    const reopenedJobs = new SQLiteDigestJobStore(reopenedDb, { now: () => new Date(clock.now()) });
    const restarted = new Scheduler({ schedules, jobs: reopenedJobs, state: new SQLiteScheduleStateStore(reopenedDb, clock.now), clock });
    try {
      expect(await restarted.runImmediateFirst()).toEqual({ queued: [], failures: [] });
      expect(await restarted.runDue()).toEqual({ queued: ['v2:daily:1785830400000'], failures: [] });
      expect(await restarted.runDue()).toEqual({ queued: [], failures: [] });

      expect((await reopenedJobs.leaseNext())?.triggerWindowId).toBe('v2:initial');
      expect((await reopenedJobs.leaseNext())?.triggerWindowId).toBe('v2:daily:1785744000000');
      expect((await reopenedJobs.leaseNext())?.triggerWindowId).toBe('v2:daily:1785830400000');
      expect(await reopenedJobs.leaseNext()).toBeNull();
    } finally {
      reopenedDb.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a due slot unstaged and reports a web-visible failure when persistence fails', async () => {
    const marks: string[] = [];
    const scheduler = new Scheduler({
      schedules: [{ id: 'daily', mode: 'preset', preset: 'daily', enabled: true, time: '08:00', timezone: 'UTC' }],
      jobs: { enqueue: async () => { throw new Error('disk full'); } },
      state: {
        firstRunEnqueuedAt: async () => null,
        lastScheduledAt: async () => null,
        markFirstRunEnqueued: async (at) => { marks.push(at); },
        markScheduled: async (_id, at) => { marks.push(at); }
      },
      clock: fakeClock('2026-08-03T09:00:00.000Z')
    });

    await expect(scheduler.runDue()).resolves.toEqual({ queued: [], failures: [{ scheduleId: 'daily', reason: 'STORAGE_FAILED' }] });
    expect(marks).toEqual([]);
  });
});

function fakeClock(initial: string) {
  let value = initial;
  return { now: () => value, set: (next: string) => { value = next; } };
}

async function openTestDatabase(path = ':memory:') {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path);
}
