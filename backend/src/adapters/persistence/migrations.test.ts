import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('SQLite migrations', () => {
  it('creates the persistence tables required by the backend core', async () => {
    const db = await openTestDatabase();

    runMigrations(db);
    runMigrations(db);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining(['admin_accounts', 'auth_sessions', 'deliveries', 'digest_jobs', 'ignore_rules', 'login_attempts', 'manual_telegram_sends', 'notes', 'onboarding_state', 'reports', 'schedule_state', 'secrets', 'settings', 'v2_log_cursor', 'v2_reports', 'v2_report_delivery_attempts', 'v2_runs', 'v2_signatures'])
    );
      expect(db.prepare('select version from schema_migrations').all().map((row) => ({ ...(row as { version: number }) }))).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }
    ]);
  });

  it('rolls back migration-created tables when a migration statement fails', async () => {
    const db = await openTestDatabase();
    db.exec('create table schema_migrations (wrong_column integer primary key)');

    expect(() => runMigrations(db)).toThrow();

    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).not.toContain('settings');
    expect(tables).not.toContain('secrets');
    expect(tables).not.toContain('digest_jobs');
    expect(tables).toEqual(['schema_migrations']);

    db.exec('drop table schema_migrations');
    runMigrations(db);

    expect(db.prepare('select version from schema_migrations').all().map((row) => ({ ...(row as { version: number }) }))).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }
    ]);
  });

  it('backfills completed onboarding for an existing configured runtime', async () => {
    const db = await openTestDatabase();
    db.exec('create table settings (key text primary key, value_json text not null, updated_at text not null)');
    db.prepare('insert into settings(key, value_json, updated_at) values (?, ?, ?)').run('runtime', JSON.stringify({ secretRefs: { haTokenRef: 'secret_ha', aiKeyRef: 'secret_ai' } }), '2026-08-01T00:00:00.000Z');

    runMigrations(db);

    expect(db.prepare('select current_step, completed from onboarding_state where singleton = 1').get()).toEqual({ current_step: 'first_report', completed: 1 });
  });

  it('upgrades completed legacy jobs with durable lifecycle columns and a completed stage', async () => {
    const db = await openTestDatabase();
    db.exec(`create table digest_jobs (
      id text primary key, trigger_window_id text not null unique, kind text not null, status text not null,
      attempts integer not null default 0, available_at text not null, lease_until text, last_error text,
      created_at text not null, updated_at text not null
    )`);
    db.prepare(`insert into digest_jobs(id, trigger_window_id, kind, status, attempts, available_at, created_at, updated_at)
      values ('legacy-job', 'manual:legacy', 'manual', 'completed', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`).run();

    runMigrations(db);

    expect(db.prepare('select stage, retry_count, report_id from digest_jobs where id = ?').get('legacy-job')).toEqual({ stage: 'completed', retry_count: 0, report_id: null });
  });

  it('adds the v2 failure message column to an existing run table without changing its data', async () => {
    const db = await openTestDatabase();
    db.exec(`create table v2_runs (
      id text primary key, slot_id text not null unique, status text not null, error_code text, created_at text not null
    )`);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('legacy-run', 'legacy-slot', 'failed', 'AI_ANALYSIS_UNAVAILABLE', '2026-08-01T00:00:00.000Z');

    runMigrations(db);

    expect((db.prepare('pragma table_info(v2_runs)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('error_message');
    const firstRun = db.prepare('select id, slot_id, status, error_code, error_message, created_at from v2_runs where id = ?').get('legacy-run');
    expect(firstRun).toEqual({ id: 'legacy-run', slot_id: 'legacy-slot', status: 'failed', error_code: 'AI_ANALYSIS_UNAVAILABLE', error_message: null, created_at: '2026-08-01T00:00:00.000Z' });

    runMigrations(db);

    expect((db.prepare('pragma table_info(v2_runs)').all() as Array<{ name: string }>).filter((column) => column.name === 'error_message')).toHaveLength(1);
    expect(db.prepare('select id, slot_id, status, error_code, error_message, created_at from v2_runs where id = ?').get('legacy-run')).toEqual(firstRun);
  });

  it('backfills one safe, idempotent delivery attempt for every pre-v9 v2 report', async () => {
    const db = await openTestDatabase();
    db.exec(`
      create table v2_runs (
        id text primary key, slot_id text not null unique, status text not null,
        error_code text, created_at text not null
      );
      create table v2_reports (
        id text primary key, run_id text not null unique, status text not null,
        payload_json text not null, created_at text not null
      );
    `);
    const reports = [
      ['sent-run', 'sent'],
      ['failed-run', 'failed'],
      ['pending-run', 'pending'],
      ['unknown-run', undefined],
      ['quiet-run', 'skipped']
    ] as const;
    for (const [runId, deliveryStatus] of reports) {
      db.prepare('insert into v2_runs(id, slot_id, status, created_at) values (?, ?, ?, ?)')
        .run(runId, `slot-${runId}`, runId === 'quiet-run' ? 'quiet' : 'reported', '2026-08-05T19:00:00.000Z');
      db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
        .run(`v2-report:${runId}`, runId, runId === 'quiet-run' ? 'quiet' : 'reported', JSON.stringify({ report: { status: runId === 'quiet-run' ? 'quiet' : 'reported', ...(deliveryStatus ? { deliveryStatus } : {}) } }), '2026-08-05T19:00:00.000Z');
    }

    runMigrations(db);

    expect(db.prepare('select report_id, status from v2_report_delivery_attempts order by report_id').all()).toEqual([
      { report_id: 'v2-report:failed-run', status: 'failed' },
      { report_id: 'v2-report:pending-run', status: 'pending' },
      { report_id: 'v2-report:quiet-run', status: 'skipped' },
      { report_id: 'v2-report:sent-run', status: 'sent' },
      { report_id: 'v2-report:unknown-run', status: 'pending' }
    ]);
    expect(db.prepare('select id, delivery_status from v2_runs order by id').all()).toEqual([
      { id: 'failed-run', delivery_status: 'failed' },
      { id: 'pending-run', delivery_status: 'pending' },
      { id: 'quiet-run', delivery_status: 'skipped' },
      { id: 'sent-run', delivery_status: 'sent' },
      { id: 'unknown-run', delivery_status: 'pending' }
    ]);
    const firstState = db.prepare('select report_id, status, created_at, updated_at from v2_report_delivery_attempts order by report_id').all();
    const firstRunState = db.prepare('select id, delivery_status from v2_runs order by id').all();

    runMigrations(db);

    expect(db.prepare('select report_id, status, created_at, updated_at from v2_report_delivery_attempts order by report_id').all()).toEqual(firstState);
    expect(db.prepare('select id, delivery_status from v2_runs order by id').all()).toEqual(firstRunState);
  });

  it('adds nullable bounded diagnostic columns without changing old delivery attempts', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.prepare('insert into v2_runs(id, slot_id, status, delivery_status, created_at) values (?, ?, ?, ?, ?)').run('old-diag', 'old-diag-slot', 'reported', 'failed', '2026-08-13T10:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)').run('v2-report:old-diag', 'old-diag', 'reported', '{"report":{"status":"reported","deliveryStatus":"failed"}}', '2026-08-13T10:00:00.000Z');
    db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)').run('v2-report:old-diag', 'failed', '2026-08-13T10:00:00.000Z', '2026-08-13T10:00:00.000Z');

    runMigrations(db);
    runMigrations(db);

    const columns = (db.prepare('pragma table_info(v2_report_delivery_attempts)').all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining(['diagnostic_error_code', 'diagnostic_message_key', 'diagnostic_stage', 'diagnostic_at']));
    expect(db.prepare('select status, diagnostic_error_code, diagnostic_message_key, diagnostic_stage, diagnostic_at from v2_report_delivery_attempts where report_id = ?').get('v2-report:old-diag')).toEqual({ status: 'failed', diagnostic_error_code: null, diagnostic_message_key: null, diagnostic_stage: null, diagnostic_at: null });
  });

  it('adds nullable log read columns to v2 reports without changing existing data', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.prepare('insert into v2_runs(id, slot_id, status, created_at) values (?, ?, ?, ?)')
      .run('log-read-legacy-run', 'log-read-legacy-slot', 'reported', '2026-08-17T13:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:log-read-legacy-run', 'log-read-legacy-run', 'reported', '{"report":{"status":"reported"}}', '2026-08-17T13:00:00.000Z');

    runMigrations(db);

    expect((db.prepare('pragma table_info(v2_reports)').all() as Array<{ name: string }>).map((column) => column.name)).toEqual(expect.arrayContaining(['log_read_from', 'log_read_to']));
    expect(db.prepare('select log_read_from, log_read_to from v2_reports where id = ?').get('v2-report:log-read-legacy-run')).toEqual({ log_read_from: null, log_read_to: null });

    runMigrations(db);

    expect((db.prepare('pragma table_info(v2_reports)').all() as Array<{ name: string }>).filter((column) => column.name === 'log_read_from' || column.name === 'log_read_to')).toHaveLength(2);
    expect(db.prepare('select id, run_id, status, payload_json, created_at from v2_reports where id = ?').get('v2-report:log-read-legacy-run')).toEqual({ id: 'v2-report:log-read-legacy-run', run_id: 'log-read-legacy-run', status: 'reported', payload_json: '{"report":{"status":"reported"}}', created_at: '2026-08-17T13:00:00.000Z' });
  });

  it('repairs only an orphaned completed v2 job and makes it retryable once', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('orphan-run', 'orphan-slot', 'failed', 'AI_PROVIDER_UNAVAILABLE', '2026-08-05T19:00:00.000Z');
    db.prepare(`insert into digest_jobs(
      id, trigger_window_id, kind, status, stage, attempts, retry_count, available_at, report_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'orphan-job', 'orphan-window', 'manual', 'completed', 'completed', 1, 1,
      '2026-08-05T19:00:00.000Z', 'v2-report:orphan-run', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z'
    );
    db.prepare(`insert into digest_jobs(
      id, trigger_window_id, kind, status, stage, attempts, retry_count, available_at, report_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'unrelated-job', 'unrelated-window', 'manual', 'completed', 'completed', 1, 1,
      '2026-08-05T19:00:00.000Z', 'legacy-report:unrelated', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z'
    );

    runMigrations(db);
    const repaired = db.prepare('select status, stage, retry_count, report_id, error_code from digest_jobs where id = ?').get('orphan-job');
    expect(repaired).toMatchObject({ status: 'failed', stage: 'failed', retry_count: 0, report_id: null, error_code: 'REPORT_MISSING' });
    expect(db.prepare('select status, stage, retry_count, report_id from digest_jobs where id = ?').get('unrelated-job')).toEqual({ status: 'completed', stage: 'completed', retry_count: 1, report_id: 'legacy-report:unrelated' });

    const firstRepairState = { ...repaired as Record<string, unknown> };
    runMigrations(db);
    expect(db.prepare('select status, stage, retry_count, report_id, error_code from digest_jobs where id = ?').get('orphan-job')).toEqual(firstRepairState);

    const { SQLiteDigestJobStore } = await import('./sqlite-digest-job-store.js');
    const jobs = new SQLiteDigestJobStore(db, { now: () => new Date('2026-08-05T20:00:00.000Z') });
    await expect(jobs.get('orphan-job')).resolves.toMatchObject({ status: 'failed', retryCount: 0, retryAvailable: true });
    await expect(jobs.retryFailed('orphan-job')).resolves.toMatchObject({ status: 'queued', retryCount: 1, retryAvailable: false });
    await expect(jobs.retryFailed('orphan-job')).resolves.toMatchObject({ status: 'queued', retryCount: 1, retryAvailable: false });
  });

  it('repairs invalid legacy report windows without changing payload fields and remains idempotent', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.prepare(`insert into reports(
      id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`).run(
      'equal-window',
      '2026-07-31T21:46:10.471Z',
      '2026-07-31T21:46:10.471Z',
      '{"critical":1,"warning":2,"info":3}',
      '# Equal window',
      Buffer.from('equal-payload'),
      '2026-07-31T21:46:10.471Z'
    );
    db.prepare(`insert into reports(
      id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`).run(
      'reversed-window',
      '2026-07-31T21:46:10.472Z',
      '2026-07-31T21:46:10.471Z',
      '{"critical":3,"warning":2,"info":1}',
      '# Reversed window',
      Buffer.from('reversed-payload'),
      '2026-07-31T21:46:10.472Z'
    );
    db.prepare(`insert into reports(
      id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`).run(
      'valid-window',
      '2026-07-31T21:46:10.470Z',
      '2026-07-31T21:46:10.471Z',
      '{"critical":0,"warning":0,"info":1}',
      '# Valid window',
      Buffer.from('valid-payload'),
      '2026-07-31T21:46:10.473Z'
    );

    runMigrations(db);
    const firstRepair = reportRows(db);
    expect(firstRepair).toEqual([
      {
        id: 'equal-window',
        window_from: '2026-07-31T21:46:10.470Z',
        window_to: '2026-07-31T21:46:10.471Z',
        severity_counts_json: '{"critical":1,"warning":2,"info":3}',
        rendered_markdown: '# Equal window',
        compressed_payload: 'equal-payload',
        created_at: '2026-07-31T21:46:10.471Z'
      },
      {
        id: 'reversed-window',
        window_from: '2026-07-31T21:46:10.470Z',
        window_to: '2026-07-31T21:46:10.471Z',
        severity_counts_json: '{"critical":3,"warning":2,"info":1}',
        rendered_markdown: '# Reversed window',
        compressed_payload: 'reversed-payload',
        created_at: '2026-07-31T21:46:10.472Z'
      },
      {
        id: 'valid-window',
        window_from: '2026-07-31T21:46:10.470Z',
        window_to: '2026-07-31T21:46:10.471Z',
        severity_counts_json: '{"critical":0,"warning":0,"info":1}',
        rendered_markdown: '# Valid window',
        compressed_payload: 'valid-payload',
        created_at: '2026-07-31T21:46:10.473Z'
      }
    ]);

    runMigrations(db);
    expect(reportRows(db)).toEqual(firstRepair);
  });

  it('creates privacy-safe manual Telegram attempts with cleanup for legacy and v2 parents', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const columns = (db.prepare('pragma table_info(manual_telegram_sends)').all() as Array<{ name: string }>).map(({ name }) => name);

    expect(columns).toEqual(['report_id', 'report_source', 'action_id', 'status', 'diagnostic_error_code', 'diagnostic_message_key', 'diagnostic_stage', 'requested_at', 'completed_at']);
    expect(columns).not.toEqual(expect.arrayContaining(['target_ref', 'token', 'chat_id', 'message', 'response_body', 'request_url', 'ip']));

    db.prepare('insert into reports(id, window_from, window_to, severity_counts_json, rendered_markdown, created_at) values (?, ?, ?, ?, ?, ?)')
      .run('legacy-parent', '2026-08-14T11:00:00.000Z', '2026-08-14T12:00:00.000Z', '{}', '', '2026-08-14T12:00:00.000Z');
    db.prepare('insert into v2_runs(id, slot_id, status, created_at) values (?, ?, ?, ?)').run('v2-parent-run', 'v2-parent-slot', 'reported', '2026-08-14T12:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)').run('v2-report:v2-parent-run', 'v2-parent-run', 'reported', '{}', '2026-08-14T12:00:00.000Z');
    db.prepare('insert into manual_telegram_sends(report_id, report_source, action_id, status, requested_at) values (?, ?, ?, ?, ?)')
      .run('legacy-parent', 'legacy', '11111111-1111-4111-8111-111111111111', 'pending', '2026-08-14T12:01:00.000Z');
    db.prepare('insert into manual_telegram_sends(report_id, report_source, action_id, status, requested_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:v2-parent-run', 'v2', '22222222-2222-4222-8222-222222222222', 'sent', '2026-08-14T12:01:00.000Z');

    db.prepare('delete from reports where id = ?').run('legacy-parent');
    db.prepare('delete from v2_reports where id = ?').run('v2-report:v2-parent-run');

    expect(db.prepare('select count(*) as count from manual_telegram_sends').get()).toEqual({ count: 0 });
  });
});

function reportRows(db: { prepare(sql: string): { all(): unknown[] } }) {
  return db
    .prepare('select id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at from reports order by id')
    .all()
    .map((row) => {
      const value = row as {
        id: string;
        window_from: string;
        window_to: string;
        severity_counts_json: string;
        rendered_markdown: string;
        compressed_payload: Buffer;
        created_at: string;
      };
      return { ...value, compressed_payload: Buffer.from(value.compressed_payload).toString('utf8') };
    });
}

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
