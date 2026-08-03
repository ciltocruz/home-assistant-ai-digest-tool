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
      expect.arrayContaining(['admin_accounts', 'auth_sessions', 'deliveries', 'digest_jobs', 'ignore_rules', 'login_attempts', 'notes', 'onboarding_state', 'reports', 'schedule_state', 'secrets', 'settings', 'v2_log_cursor', 'v2_reports', 'v2_runs', 'v2_signatures'])
    );
    expect(db.prepare('select version from schema_migrations').all().map((row) => ({ ...(row as { version: number }) }))).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }
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
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }
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
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
