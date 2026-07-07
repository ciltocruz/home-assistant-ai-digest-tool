import type { DatabaseSync } from 'node:sqlite';

const MIGRATION_VERSION = 1;

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
  db.prepare('insert or ignore into schema_migrations(version) values (?)').run(MIGRATION_VERSION);
}
