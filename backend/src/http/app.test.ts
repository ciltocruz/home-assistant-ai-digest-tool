import { afterEach, describe, expect, it } from 'vitest';
import { DigestDetailSchema, DigestHistoryResponseSchema, type DigestDetail } from '@ha-digest/shared';
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
    const setCookies = Array.isArray(created.headers['set-cookie']) ? created.headers['set-cookie'] : [created.headers['set-cookie'] ?? ''];
    const cookies = setCookies.join('; ');
    const sessionCookie = setCookies.find((cookie) => cookie.startsWith('ha_digest_session=')) ?? '';
    const csrfCookie = setCookies.find((cookie) => cookie.startsWith('ha_digest_csrf=')) ?? '';

    expect(created.statusCode).toBe(200);
    expect(cookies).toContain('ha_digest_session=');
    expect(sessionCookie).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('ha_digest_csrf=');
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(legacy.statusCode).toBe(401);
  });

  it('returns a fresh CSRF token and the stored language when a browser session is resumed', async () => {
    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'es' } });
    const resumed = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: registered.headers['set-cookie'] } });
    const body = resumed.json<{ csrfToken: string; language: string }>();

    expect(resumed.statusCode).toBe(200);
    expect(body.csrfToken).toMatch(/\S+/);
    expect(body.language).toBe('es');
  });

  it('uses eight characters as the password minimum for registration and changes', async () => {
    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000 } });
    const tooShort = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: '1234567', language: 'en' } });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json<{ message: string }>().message).toContain('8 characters');

    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: '12345678', language: 'en' } });
    expect(registered.statusCode).toBe(200);
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { currentPassword: '12345678', nextPassword: '87654321' }
    });
    expect(changed.statusCode).toBe(204);
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

  it('returns v2 detail without provider credentials in the HTTP-facing projection', async () => {
    const rawSecrets = [
      'http-route-bearer-fixture',
      'http-route-token-fixture',
      'http-route-api-key-fixture',
      'http-route-query-token-fixture',
      '123456:ABCdefGHIjklMNOpqr',
      '987654:ZYXwvUTSrqponMLK'
    ];
    const detail: DigestDetail = {
      id: 'v2-http-detail',
      source: 'v2',
      summary: { id: 'v2-http-detail', window: { from: '2026-08-03T10:00:00.000Z', to: '2026-08-03T11:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-03T11:00:00.000Z', deliveryStatus: 'pending', source: 'v2' },
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'reported',
        warnings: [],
        signatures: [{
          signature: 'sig-http',
          component: 'mqtt',
          level: 'WARNING',
          classification: 'new',
          trend: 'new',
          occurrences: 1,
          analysis: {
            summary: `Incident: Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api_key=${rawSecrets[2]} https://provider.test/?token=${rawSecrets[3]} botToken=${rawSecrets[4]}. Token budget is stable.`,
            recommendation: `Restart after bot_token: ${rawSecrets[5]}; keep API key rotation documented.`
          }
        }]
      }
    };
    const runtimeServices = services();
    runtimeServices.reports.get = async () => detail;
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/v2-http-detail', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(200);
    for (const secret of rawSecrets) expect(response.body).not.toContain(secret);
    expect(response.body).toContain('Token budget is stable');
    expect(response.body).toContain('API key rotation documented');
  });

  it('returns only aggregate status for old v2 integration fields at the HTTP detail seam', async () => {
    const rawSecrets = ['http-old-warning-token-fixture', 'http-old-integration-secret-fixture'];
    const privateIntegrationValues = ['owner@example.test', '192.0.2.10', 'https://private.example.test/account', 'Bedroom private device', 'private_service_domain'];
    const detail: DigestDetail = {
      id: 'v2-http-old-detail',
      source: 'v2',
      summary: { id: 'v2-http-old-detail', window: { from: '2026-08-03T10:00:00.000Z', to: '2026-08-03T11:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-03T11:00:00.000Z', deliveryStatus: 'pending', source: 'v2' },
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'reported',
        warnings: [`Bearer ${rawSecrets[0]}`],
        integrationStatus: {
          available: true,
          providerControlled: rawSecrets[1],
          integrations: [
            { domain: privateIntegrationValues[4], title: privateIntegrationValues[0], state: 'loaded' },
            { domain: 'private_ip', title: privateIntegrationValues[1], state: 'not_loaded' },
            { domain: 'private_setup', title: 'Private setup', state: 'setup_in_progress' },
            { domain: 'private_unload', title: 'Private unload', state: 'unload_in_progress' },
            { domain: 'private_retry', title: 'Private retry', state: 'setup_retry' },
            { domain: 'private_url', title: privateIntegrationValues[2], state: 'setup_error', reason: 'invalid_auth' },
            { domain: 'private_migration', title: 'Private migration', state: 'migration_error' },
            { domain: 'private_device', title: privateIntegrationValues[3], state: 'failed_unload' },
            { domain: 'private_future', title: 'Private future', state: 'future_state' },
            { domain: 'private_malformed', title: 'Private malformed' }
          ]
        },
        signatures: []
      } as never
    };
    const runtimeServices = services();
    runtimeServices.reports.get = async () => detail;
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/v2-http-old-detail', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(200);
    DigestDetailSchema.parse(response.json());
    expect(response.json()).toMatchObject({
      presentation: {
        warnings: ['Bearer [REDACTED]'],
        integrationStatus: {
          available: true,
          total: 10,
          loaded: 1,
          notLoaded: 1,
          inProgress: 2,
          retrying: 1,
          errors: 3,
          unknown: 2
        }
      }
    });
    for (const secret of rawSecrets) expect(response.body).not.toContain(secret);
    for (const value of privateIntegrationValues) expect(response.body).not.toContain(value);
    expect(response.body).not.toContain('providerControlled');
    expect(response.body).not.toContain('opaque');
  });

  it('drops unknown top-level, batch presentation, and signature fields at the HTTP detail seam', async () => {
    const detail: DigestDetail = {
      id: 'v2-http-allowlist-detail',
      source: 'v2',
      summary: { id: 'v2-http-allowlist-detail', window: { from: '2026-08-03T10:00:00.000Z', to: '2026-08-03T11:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-03T11:00:00.000Z', deliveryStatus: 'pending', source: 'v2' },
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'reported',
        warnings: [],
        signatures: [{
          signature: 'sig-http-allowlist',
          component: 'mqtt',
          level: 'WARNING',
          classification: 'new',
          trend: 'new',
          occurrences: 1,
          providerControlled: 'drop-signature-field'
        } as never],
        providerControlled: 'drop-presentation-field'
      } as never,
      providerControlled: 'drop-top-level-field'
    } as never;
    const runtimeServices = services();
    runtimeServices.reports.get = async () => detail;
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/v2-http-allowlist-detail', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(200);
    expect(DigestDetailSchema.parse(response.json())).toMatchObject({ id: 'v2-http-allowlist-detail', presentation: { mode: 'batch', signatures: [{ signature: 'sig-http-allowlist' }] } });
    expect(response.body).not.toContain('providerControlled');
    expect(response.body).not.toContain('drop-signature-field');
    expect(response.body).not.toContain('drop-presentation-field');
    expect(response.body).not.toContain('drop-top-level-field');
  });

  it('returns a schema-valid corrupt v2 detail when status, timestamps, and notes are malformed', async () => {
    const detail = {
      id: 'v2-http-corrupt-detail',
      source: 'v2',
      summary: {
        id: 'v2-http-corrupt-detail',
        window: { from: 'not-a-window', to: 'also-not-a-window' },
        severityCounts: { critical: 0, warning: 0, info: 0 },
        createdAt: 'not-a-created-at',
        deliveryStatus: 'not-a-delivery-status',
        source: 'v2',
        runStatus: 'not-a-run-status',
        warningCodes: []
      },
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'not-a-status',
        warnings: [],
        signatures: [{
          signature: 'sig-http-corrupt',
          component: 'mqtt',
          level: 'WARNING',
          classification: 'new',
          trend: 'new',
          occurrences: 1,
          notes: [
            { id: 'invalid-note', text: 'Discard me', occurredAt: 'not-a-date', createdAt: 'not-a-date', tags: ['sig-http-corrupt'] },
            { id: 'valid-note', text: 'Keep me', occurredAt: '2026-08-05T21:00:00+02:00', createdAt: '2026-08-05T19:00:00Z', tags: ['sig-http-corrupt'] }
          ]
        }]
      }
    } as never;
    const runtimeServices = services();
    runtimeServices.reports.get = async () => detail;
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/v2-http-corrupt-detail', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(200);
    const parsed = DigestDetailSchema.parse(response.json());
    expect(parsed).toMatchObject({
      summary: { createdAt: '1970-01-01T00:00:00.000Z', runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] },
      presentation: { mode: 'batch', status: 'failed', warnings: ['REPORT_CORRUPT'], signatures: [{ notes: [{ id: 'valid-note', occurredAt: '2026-08-05T19:00:00.000Z', createdAt: '2026-08-05T19:00:00.000Z' }] }] }
    });
  });

  it('fails closed when the history service returns data outside the shared response schema', async () => {
    const runtimeServices = services();
    runtimeServices.reports.list = async () => [{
      id: 'invalid-history',
      window: { from: '2026-08-03T10:00:00.000Z', to: '2026-08-03T11:00:00.000Z' },
      severityCounts: { critical: 0, warning: 0, info: 0 },
      createdAt: '2026-08-03T11:00:00.000Z',
      deliveryStatus: 'corrupt' as never
    }];
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/history', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('deletes exactly one authenticated report with CSRF and returns 404 when it is absent', async () => {
    const runtimeServices = services();
    const removed: string[] = [];
    runtimeServices.reports.remove = async (id) => { removed.push(id); return id === 'report-to-delete'; };
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;

    const unauthenticated = await app.inject({ method: 'DELETE', url: '/api/digests/report-to-delete', headers: { 'x-csrf-token': csrfToken } });
    const missingCsrf = await app.inject({ method: 'DELETE', url: '/api/digests/report-to-delete', headers: { cookie } });
    const invalidCsrf = await app.inject({ method: 'DELETE', url: '/api/digests/report-to-delete', headers: { cookie, 'x-csrf-token': 'wrong-token' } });
    const removedResponse = await app.inject({ method: 'DELETE', url: '/api/digests/report-to-delete', headers: { cookie, 'x-csrf-token': csrfToken } });
    const absentResponse = await app.inject({ method: 'DELETE', url: '/api/digests/missing-report', headers: { cookie, 'x-csrf-token': csrfToken } });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missingCsrf.statusCode).toBe(403);
    expect(invalidCsrf.statusCode).toBe(403);
    expect(removedResponse.statusCode).toBe(204);
    expect(absentResponse.statusCode).toBe(404);
    expect(removed).toEqual(['report-to-delete', 'missing-report']);
  });
});

function services(now = Date.now): BackendApiServices {
  let password = ''; let admin = false; let language: 'en' | 'es' = 'en'; let attempts = 0; const sessions = new Map<string, { csrfToken: string; expiresAtMs: number }>();
  const settings = { homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: '••••ha' } }, ai: { provider: 'gemini' as const, key: { configured: true, mask: '••••ai' } }, notifications: { channel: 'none' as const }, schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'UTC' }], privacyLevel: 'balanced' as const, retentionDays: 10 };
  return {
    setup: { complete: async () => { throw new Error('removed'); } },
    auth: {
      hasAdmin: async () => admin, createAdmin: async (value, selectedLanguage) => { if (admin) return false; admin = true; password = value; language = selectedLanguage; return true; }, verifyPassword: async (value) => value === password,
      changePassword: async (current, next) => { if (current !== password) return false; password = next; sessions.clear(); return true; },
      createSession: async (ttlMs) => { const id = `session-${sessions.size}`; const csrfToken = `csrf-${sessions.size}`; const expiresAtMs = now() + ttlMs; sessions.set(id, { csrfToken, expiresAtMs }); return { id, csrfToken, expiresAtMs }; },
      readSession: async (id, csrf) => { const item = sessions.get(id); return item && item.expiresAtMs > now() && (csrf === undefined || csrf === item.csrfToken) ? { id, csrfToken: csrf ?? '', expiresAtMs: item.expiresAtMs } : null; },
      removeSession: async (id) => { sessions.delete(id); }, issueCsrf: async (id) => sessions.get(id)?.csrfToken ?? null,
      loginAllowed: async () => attempts < 5, recordFailedLogin: async () => { attempts += 1; }, clearFailedLogins: async () => { attempts = 0; }, language: async () => language
    },
    onboarding: { get: async () => ({ currentStep: 'home_assistant', completedSteps: [], draft: {}, secretMetadata: {}, completed: false }), save: async () => ({ currentStep: 'home_assistant', completedSteps: [], draft: {}, secretMetadata: {}, completed: false }), complete: async () => ({ haUrl: settings.homeAssistant.url, ai: { provider: 'gemini', keyMask: '••••ai', ref: 'ai' }, notifiers: [] }) },
    settings: { get: async () => settings, update: async () => settings }, digestJobs: { enqueue: async () => ({ status: 'queued' as const, jobId: 'job' }), get: async () => null, retryFailed: async () => null }, reports: { list: async () => [], get: async () => null, remove: async () => false }, notes: { add: async (input) => ({ id: 'note', ...input, createdAt: new Date(now()).toISOString() }), listWindow: async () => [] }, ignores: { add: async (input) => ({ id: 'ignore', ...input, createdAt: new Date(now()).toISOString() }), remove: async () => undefined, listActive: async () => [] }, notifiers: { test: async () => ({ status: 'success' as const, message: 'ok', checkedAt: new Date(now()).toISOString() }), send: async (input) => ({ status: 'skipped' as const, targetRef: input.targetRef }) }
  };
}
function note() { return { text: 'Operator note', occurredAt: '2026-08-03T10:00:00.000Z', tags: [] }; }
