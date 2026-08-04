import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackendApiServices } from './app.js';
import { createApp } from './app.js';

describe('account authentication boundary', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('creates the first administrator, uses an httpOnly session and never accepts bootstrap tokens', async () => {
    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000, secureCookies: true } });
    const created = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const legacy = await app.inject({ method: 'POST', url: '/api/setup', payload: {} });

    expect(created.statusCode).toBe(200);
    expect(created.headers['set-cookie']).toContain('HttpOnly');
    expect(created.headers['set-cookie']).toContain('SameSite=Lax');
    expect(created.headers['set-cookie']).toContain('Secure');
    expect(legacy.statusCode).toBe(401);
  });

  it('requires a valid CSRF token for mutations, expires sessions, and throttles bad passwords', async () => {
    let now = Date.parse('2026-08-03T10:00:00.000Z');
    const runtime = services(() => now);
    app = createApp({ services: runtime, auth: { sessionTtlMs: 1_000 }, now: () => new Date(now).toISOString() });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const bad = await Promise.all(Array.from({ length: 6 }, () => app!.inject({ method: 'POST', url: '/api/session', payload: { password: 'wrong-password' } })));
    expect(bad.at(-1)?.statusCode).toBe(429);

    // A fresh app/client IP makes the expiration and CSRF guarantees explicit.
    const clean = services(() => now);
    app = createApp({ services: clean, auth: { sessionTtlMs: 1_000 }, now: () => new Date(now).toISOString() });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'another-long-password', language: 'en' } });
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/notes', headers: { cookie }, payload: note() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/notes', headers: { cookie, 'x-csrf-token': csrfToken }, payload: note() })).statusCode).toBe(201);
    now += 1_001;
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).statusCode).toBe(401);
  });

  it('changes a password only after CSRF and current-password verification', async () => {
    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const cookie = registered.headers['set-cookie']; const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/account/password', headers: { cookie }, payload: { currentPassword: 'long-enough-password', nextPassword: 'changed-long-password' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/account/password', headers: { cookie, 'x-csrf-token': csrfToken }, payload: { currentPassword: 'wrong', nextPassword: 'changed-long-password' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/account/password', headers: { cookie, 'x-csrf-token': csrfToken }, payload: { currentPassword: 'long-enough-password', nextPassword: 'changed-long-password' } })).statusCode).toBe(204);
  });
});

function services(now = Date.now): BackendApiServices {
  let password = ''; let admin = false; let attempts = 0; const sessions = new Map<string, { csrfToken: string; expiresAtMs: number }>();
  const settings = { homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: '••••ha' } }, ai: { provider: 'gemini' as const, key: { configured: true, mask: '••••ai' } }, notifications: { channel: 'none' as const }, schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'UTC' }], privacyLevel: 'balanced' as const, retentionDays: 10 };
  return {
    setup: { complete: async () => { throw new Error('removed'); } },
    auth: {
      hasAdmin: async () => admin, createAdmin: async (value) => { if (admin) return false; admin = true; password = value; return true; }, verifyPassword: async (value) => value === password,
      changePassword: async (current, next) => { if (current !== password) return false; password = next; sessions.clear(); return true; },
      createSession: async (ttlMs) => { const id = `session-${sessions.size}`; const csrfToken = `csrf-${sessions.size}`; const expiresAtMs = now() + ttlMs; sessions.set(id, { csrfToken, expiresAtMs }); return { id, csrfToken, expiresAtMs }; },
      readSession: async (id, csrf) => { const item = sessions.get(id); return item && item.expiresAtMs > now() && (csrf === undefined || csrf === item.csrfToken) ? { id, ...item } : null; },
      removeSession: async (id) => { sessions.delete(id); }, issueCsrf: async () => null,
      loginAllowed: async () => attempts < 5, recordFailedLogin: async () => { attempts += 1; }, clearFailedLogins: async () => { attempts = 0; }, language: async () => 'en' as const
    },
    onboarding: { get: async () => ({ currentStep: 'home_assistant', completedSteps: [], draft: {}, secretMetadata: {}, completed: false }), save: async () => ({ currentStep: 'home_assistant', completedSteps: [], draft: {}, secretMetadata: {}, completed: false }), complete: async () => ({ haUrl: settings.homeAssistant.url, ai: { provider: 'gemini', keyMask: '••••ai', ref: 'ai' }, notifiers: [] }) },
    settings: { get: async () => settings, update: async () => settings }, digestJobs: { enqueue: async () => ({ status: 'queued' as const, jobId: 'job' }), get: async () => null, retryFailed: async () => null }, reports: { list: async () => [], get: async () => null }, notes: { add: async (input) => ({ id: 'note', ...input, createdAt: new Date(now()).toISOString() }), listWindow: async () => [] }, ignores: { add: async (input) => ({ id: 'ignore', ...input, createdAt: new Date(now()).toISOString() }), remove: async () => undefined, listActive: async () => [] }, notifiers: { test: async () => ({ status: 'success' as const, message: 'ok', checkedAt: new Date(now()).toISOString() }), send: async (input) => ({ status: 'skipped' as const, targetRef: input.targetRef }) }
  };
}
function note() { return { text: 'Operator note', occurredAt: '2026-08-03T10:00:00.000Z', tags: [] }; }
