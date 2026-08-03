import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { DatabaseSync } from 'node:sqlite';

export type AuthSession = { id: string; csrfToken: string; expiresAtMs: number };

/** Persistent credential boundary. Raw passwords, session IDs, and CSRF tokens never reach SQLite. */
export class SQLiteAuthStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  async hasAdmin(): Promise<boolean> {
    return Boolean(this.db.prepare('select 1 from admin_accounts limit 1').get());
  }

  async createAdmin(password: string, language: 'en' | 'es'): Promise<boolean> {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const result = this.db.prepare(
      'insert into admin_accounts(id, password_hash, language, created_at, updated_at) select ?, ?, ?, ?, ? where not exists(select 1 from admin_accounts)'
    ).run('admin', hash, language, iso(this.now()), iso(this.now()));
    return result.changes === 1;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const row = this.db.prepare('select password_hash from admin_accounts where id = ?').get('admin') as { password_hash: string } | undefined;
    return row ? argon2.verify(row.password_hash, password) : false;
  }

  async language(): Promise<'en' | 'es'> {
    const row = this.db.prepare('select language from admin_accounts where id = ?').get('admin') as { language: string } | undefined;
    return row?.language === 'es' ? 'es' : 'en';
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<boolean> {
    if (!await this.verifyPassword(currentPassword)) return false;
    const hash = await argon2.hash(nextPassword, { type: argon2.argon2id });
    this.db.prepare('update admin_accounts set password_hash = ?, updated_at = ? where id = ?').run(hash, iso(this.now()), 'admin');
    this.db.prepare('delete from auth_sessions where account_id = ?').run('admin');
    return true;
  }

  async createSession(ttlMs: number): Promise<AuthSession> {
    const id = token();
    const csrfToken = token();
    const expiresAtMs = this.now() + ttlMs;
    this.db.prepare('insert into auth_sessions(id_hash, csrf_hash, account_id, expires_at, created_at) values (?, ?, ?, ?, ?)')
      .run(hash(id), hash(csrfToken), 'admin', iso(expiresAtMs), iso(this.now()));
    return { id, csrfToken, expiresAtMs };
  }

  async readSession(id: string, csrfToken?: string): Promise<AuthSession | null> {
    const row = this.db.prepare('select expires_at, csrf_hash from auth_sessions where id_hash = ? and account_id = ?').get(hash(id), 'admin') as { expires_at: string; csrf_hash: string } | undefined;
    if (!row || Date.parse(row.expires_at) <= this.now()) {
      if (row) this.db.prepare('delete from auth_sessions where id_hash = ?').run(hash(id));
      return null;
    }
    if (csrfToken !== undefined && !safeHashEqual(row.csrf_hash, hash(csrfToken))) return null;
    return { id, csrfToken: csrfToken ?? '', expiresAtMs: Date.parse(row.expires_at) };
  }

  async removeSession(id: string): Promise<void> {
    this.db.prepare('delete from auth_sessions where id_hash = ?').run(hash(id));
  }

  async issueCsrf(id: string): Promise<string | null> {
    const session = await this.readSession(id);
    if (!session) return null;
    const csrfToken = token();
    this.db.prepare('update auth_sessions set csrf_hash = ? where id_hash = ?').run(hash(csrfToken), hash(id));
    return csrfToken;
  }

  async loginAllowed(subject: string, limit = 5, windowMs = 15 * 60_000): Promise<boolean> {
    const cutoff = iso(this.now() - windowMs);
    const row = this.db.prepare('select count(*) as count from login_attempts where subject = ? and attempted_at >= ?').get(subject, cutoff) as { count: number };
    return row.count < limit;
  }

  async recordFailedLogin(subject: string): Promise<void> {
    this.db.prepare('insert into login_attempts(subject, attempted_at) values (?, ?)').run(subject, iso(this.now()));
  }

  async clearFailedLogins(subject: string): Promise<void> {
    this.db.prepare('delete from login_attempts where subject = ?').run(subject);
  }
}

function token(): string { return crypto.randomBytes(32).toString('base64url'); }
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function iso(value: number): string { return new Date(value).toISOString(); }
function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
