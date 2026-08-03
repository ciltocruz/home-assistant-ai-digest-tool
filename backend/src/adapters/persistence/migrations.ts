import type { DatabaseSync } from 'node:sqlite';

const MIGRATION_VERSION = 5;

export function runMigrations(db: DatabaseSync): void {
  db.exec('pragma foreign_keys = on');

  if (db.isTransaction) {
    db.exec('savepoint app_migrations');
    try {
      applyMigrations(db);
      db.exec('release savepoint app_migrations');
    } catch (error) {
      db.exec('rollback to savepoint app_migrations');
      db.exec('release savepoint app_migrations');
      throw error;
    }
    return;
  }

  db.exec('begin immediate');
  try {
    applyMigrations(db);
    db.exec('commit');
  } catch (error) {
    if (db.isTransaction) db.exec('rollback');
    throw error;
  }
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    create table if not exists settings (
      key text primary key,
      value_json text not null,
     updated_at text not null
    );

    create table if not exists onboarding_state (
      singleton integer primary key check (singleton = 1),
      current_step text not null,
      completed_steps_json text not null,
      draft_json text not null,
      secret_refs_json text not null,
      secret_metadata_json text not null,
      completed integer not null default 0,
      updated_at text not null
    );

    create table if not exists secrets (
      id text primary key,
      kind text not null,
      encrypted_value text not null,
      iv text not null,
      auth_tag text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists digest_jobs (
      id text primary key,
      trigger_window_id text not null unique,
      kind text not null,
      status text not null,
      attempts integer not null default 0,
      available_at text not null,
      lease_until text,
      last_error text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists idx_digest_jobs_available on digest_jobs(status, available_at, created_at);
    create index if not exists idx_digest_jobs_lease on digest_jobs(status, lease_until, created_at);

    create table if not exists reports (
      id text primary key,
      window_from text not null,
      window_to text not null,
      severity_counts_json text not null,
      rendered_markdown text not null,
      compressed_payload blob,
      created_at text not null
    );

    create table if not exists notes (
      id text primary key,
      text text not null,
      occurred_at text not null,
      created_at text not null,
      tags_json text not null default '[]'
    );
    create index if not exists idx_notes_window on notes(occurred_at);

    create table if not exists ignore_rules (
      id text primary key,
      match text not null,
      type text,
      reason text,
      expires_at text,
      created_at text not null,
      removed_at text
    );
    create unique index if not exists idx_ignore_rules_unique_active
      on ignore_rules(match, coalesce(type, ''), coalesce(expires_at, ''))
      where removed_at is null;

    create table if not exists deliveries (
      id text primary key,
      digest_id text not null,
      target_ref text not null,
      status text not null,
      delivered_at text,
      error_code text,
      message text,
      created_at text not null
    );
  `);
  addDigestJobColumns(db);
  addV2BatchTables(db);
  addAuthenticationTables(db);
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(1);
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(2);
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(3);
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(4);
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(MIGRATION_VERSION);
  db.prepare(
    `insert or ignore into onboarding_state(singleton, current_step, completed_steps_json, draft_json, secret_refs_json, secret_metadata_json, completed, updated_at)
     select 1,
       case when exists(select 1 from settings where key = 'runtime' and value_json not like '%unconfigured%') then 'first_report' else 'home_assistant' end,
       case when exists(select 1 from settings where key = 'runtime' and value_json not like '%unconfigured%') then '["home_assistant","ai_provider","notifications","schedule","privacy"]' else '[]' end,
       '{}', '{}', '{}',
       case when exists(select 1 from settings where key = 'runtime' and value_json not like '%unconfigured%') then 1 else 0 end,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run();
}

function addAuthenticationTables(db: DatabaseSync): void {
  db.exec(`
    create table if not exists admin_accounts (
      id text primary key,
      password_hash text not null,
      language text not null default 'en',
      created_at text not null,
      updated_at text not null
    );
    create table if not exists auth_sessions (
      id_hash text primary key,
      csrf_hash text not null,
      account_id text not null references admin_accounts(id) on delete cascade,
      expires_at text not null,
      created_at text not null
    );
    create index if not exists idx_auth_sessions_expiry on auth_sessions(expires_at);
    create table if not exists login_attempts (
      id integer primary key,
      subject text not null,
      attempted_at text not null
    );
    create index if not exists idx_login_attempts_subject on login_attempts(subject, attempted_at);
  `);
}

function addDigestJobColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare('pragma table_info(digest_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
  const additions = [
    ['stage', "text not null default 'queued'"], ['error_code', 'text'], ['error_message', 'text'],
    ['correlation_id', 'text'], ['settings_snapshot_json', 'text'], ['report_id', 'text'], ['retry_count', 'integer not null default 0']
  ] as const;
  for (const [name, definition] of additions) if (!columns.has(name)) db.exec(`alter table digest_jobs add column ${name} ${definition}`);
  db.exec("update digest_jobs set stage = case when status = 'completed' then 'completed' when status = 'failed' then 'failed' else 'queued' end where stage is null or stage = '' or (stage = 'queued' and status in ('completed', 'failed'))");
  db.exec('create index if not exists idx_digest_jobs_report on digest_jobs(report_id)');
}

function addV2BatchTables(db: DatabaseSync): void {
  db.exec(`
    create table if not exists v2_log_cursor (
      singleton integer primary key check (singleton = 1),
      dev integer not null,
      ino integer not null,
      size integer not null,
      offset integer not null,
      updated_at text not null
    );

    create table if not exists v2_signatures (
      signature text primary key,
      component text not null,
      level text not null,
      normalized_message text not null,
      first_seen_at text not null,
      last_seen_at text not null,
      total_count integer not null,
      previous_period_count integer not null default 0
    );

    create table if not exists v2_runs (
      id text primary key,
      slot_id text not null unique,
      status text not null,
      error_code text,
      created_at text not null
    );

    create table if not exists v2_reports (
      id text primary key,
      run_id text not null unique references v2_runs(id) on delete cascade,
      status text not null,
      payload_json text not null,
      created_at text not null
    );

    create table if not exists v2_report_signatures (
      report_id text not null references v2_reports(id) on delete cascade,
      signature text not null references v2_signatures(signature),
      summary text not null,
      recommendation text not null,
      primary key(report_id, signature)
    );

    create table if not exists schedule_state (
      schedule_id text primary key,
      first_run_enqueued_at text,
      last_scheduled_at text,
      updated_at text not null
    );

  `);
}
