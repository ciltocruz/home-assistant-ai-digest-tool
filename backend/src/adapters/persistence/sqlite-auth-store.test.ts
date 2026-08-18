import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';
import { SQLiteAuthStore } from './sqlite-auth-store.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

function openTestDatabase(): DatabaseSync {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function insertAdminRow(db: DatabaseSync, language = 'en'): void {
  db.prepare('insert into admin_accounts(id, password_hash, language, created_at, updated_at) values (?, ?, ?, ?, ?)')
    .run('admin', 'not-a-real-hash', language, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z');
}

describe('SQLiteAuthStore', () => {
  it('creates the first admin account with a hashed password and stored language', async () => {
    const db = openTestDatabase();
    const store = new SQLiteAuthStore(db, () => Date.parse('2026-08-01T10:00:00.000Z'));

    expect(await store.hasAdmin()).toBe(false);
    await expect(store.createAdmin('strong-password-123', 'es')).resolves.toBe(true);
    expect(await store.hasAdmin()).toBe(true);
    expect(await store.language()).toBe('es');
    await expect(store.verifyPassword('strong-password-123')).resolves.toBe(true);
    await expect(store.verifyPassword('wrong-password')).resolves.toBe(false);

    const row = db.prepare('select password_hash from admin_accounts where id = ?').get('admin') as { password_hash: string } | undefined;
    expect(row?.password_hash).toMatch(/^\$argon2/);
    expect(row?.password_hash).not.toContain('strong-password-123');
  });

  it('rejects a second admin and defaults to English when no language is stored', async () => {
    const db = openTestDatabase();
    const store = new SQLiteAuthStore(db, () => Date.parse('2026-08-01T10:00:00.000Z'));

    await store.createAdmin('first-password-123', 'en');
    await expect(store.createAdmin('second-password-123', 'es')).resolves.toBe(false);
    await expect(store.language()).resolves.toBe('en');
    await expect(store.verifyPassword('first-password-123')).resolves.toBe(true);
  });

  it('changes the password only after the current password verifies and invalidates sessions', async () => {
    const db = openTestDatabase();
    const store = new SQLiteAuthStore(db, () => Date.parse('2026-08-01T10:00:00.000Z'));

    await store.createAdmin('current-password-1', 'en');
    await expect(store.changePassword('wrong-password', 'next-password-1')).resolves.toBe(false);
    const session = await store.createSession(60_000);
    await expect(store.changePassword('current-password-1', 'next-password-1')).resolves.toBe(true);

    await expect(store.verifyPassword('next-password-1')).resolves.toBe(true);
    await expect(store.verifyPassword('current-password-1')).resolves.toBe(false);
    await expect(store.readSession(session.id)).resolves.toBeNull();
    expect(db.prepare('select count(*) as count from auth_sessions').get()).toEqual({ count: 0 });
  });

  it('round-trips sessions, expires and removes them, and enforces CSRF matching', async () => {
    const db = openTestDatabase();
    insertAdminRow(db);
    let now = Date.parse('2026-08-01T10:00:00.000Z');
    const store = new SQLiteAuthStore(db, () => now);

    const session = await store.createSession(60_000);
    expect(session.id).toMatch(/\S+/);
    expect(session.csrfToken).toMatch(/\S+/);
    expect(session.expiresAtMs).toBe(now + 60_000);

    await expect(store.readSession(session.id)).resolves.toEqual({ id: session.id, csrfToken: '', expiresAtMs: now + 60_000 });
    await expect(store.readSession(session.id, session.csrfToken)).resolves.toMatchObject({ csrfToken: session.csrfToken });
    await expect(store.readSession(session.id, 'wrong-csrf')).resolves.toBeNull();
    await expect(store.readSession('unknown-session')).resolves.toBeNull();

    const freshCsrf = await store.issueCsrf(session.id);
    expect(freshCsrf).not.toBeNull();
    await expect(store.readSession(session.id, freshCsrf as string)).resolves.toMatchObject({ csrfToken: freshCsrf });
    await expect(store.readSession(session.id, session.csrfToken)).resolves.toBeNull();
    await expect(store.issueCsrf('unknown-session')).resolves.toBeNull();

    now += 60_001;
    await expect(store.readSession(session.id)).resolves.toBeNull();
    expect(db.prepare('select count(*) as count from auth_sessions').get()).toEqual({ count: 0 });

    const removable = await store.createSession(60_000);
    await store.removeSession(removable.id);
    await expect(store.readSession(removable.id)).resolves.toBeNull();
  });

  it('throttles logins per subject within the window and clears attempts after success', async () => {
    const db = openTestDatabase();
    insertAdminRow(db);
    let now = Date.parse('2026-08-01T10:00:00.000Z');
    const store = new SQLiteAuthStore(db, () => now);

    for (let i = 0; i < 5; i += 1) {
      await expect(store.loginAllowed('192.0.2.10')).resolves.toBe(true);
      await store.recordFailedLogin('192.0.2.10');
    }
    await expect(store.loginAllowed('192.0.2.10')).resolves.toBe(false);
    await expect(store.loginAllowed('other-subject')).resolves.toBe(true);

    now += 15 * 60_000 + 1;
    await expect(store.loginAllowed('192.0.2.10')).resolves.toBe(true);

    for (let i = 0; i < 4; i += 1) await store.recordFailedLogin('192.0.2.10');
    await store.clearFailedLogins('192.0.2.10');
    await expect(store.loginAllowed('192.0.2.10')).resolves.toBe(true);
  });
});