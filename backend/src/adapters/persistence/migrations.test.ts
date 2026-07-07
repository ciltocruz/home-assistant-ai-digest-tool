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
      expect.arrayContaining(['deliveries', 'digest_jobs', 'ignore_rules', 'notes', 'reports', 'secrets', 'settings'])
    );
    expect(db.prepare('select version from schema_migrations').all().map((row) => ({ ...(row as { version: number }) }))).toEqual([
      { version: 1 }
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
      { version: 1 }
    ]);
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
