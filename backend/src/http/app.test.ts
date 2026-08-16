import { afterEach, describe, expect, it } from 'vitest';
import { DigestDetailSchema, DigestHistoryResponseSchema, StaleEntitiesResponseSchema, type DigestDetail } from '@ha-digest/shared';
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

  it('re-sanitizes trace excerpts and manual attempts at the final HTTP detail seam', async () => {
    const privateValues = ['owner@example.test', '192.0.2.10', 'private-token', 'private-response-body'];
    const detail = {
      id: 'v2-http-safe-evidence', source: 'v2',
      summary: { id: 'v2-http-safe-evidence', window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'partial' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_UNAVAILABLE'], signatures: [{
        signature: 'safe-evidence-signature', component: 'mqtt', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1,
        safeExcerpt: { lines: ['Traceback (redacted)', 'token=private-token owner@example.test 192.0.2.10', 'ConnectionError: private-response-body'], truncated: false, redacted: true }
      }] },
      manualTelegram: { configured: true, attempts: [{ actionId: '11111111-1111-4111-8111-111111111111', status: 'sent', requestedAt: '2026-08-14T12:00:00.000Z', completedAt: '2026-08-14T12:00:01.000Z', responseBody: privateValues[3] }] }
    } as never;
    const runtimeServices = services();
    runtimeServices.reports.get = async () => detail;
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });

    const response = await app.inject({ method: 'GET', url: '/api/digests/v2-http-safe-evidence', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(200);
    expect(DigestDetailSchema.parse(response.json())).toMatchObject({ presentation: { signatures: [{ safeExcerpt: { lines: ['Traceback (redacted)', 'ConnectionError'], redacted: true } }] }, manualTelegram: { attempts: [] } });
    for (const value of privateValues) expect(response.body).not.toContain(value);
    expect(response.body).not.toContain('responseBody');
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

  it('creates only a report-owned exact signature ignore with authentication, CSRF, and idempotency', async () => {
    const runtimeServices = services();
    const rules = new Map<string, { id: string; match: string; type: 'signature'; createdAt: string }>();
    runtimeServices.reports.get = async (id) => id === 'report-with-signature' ? {
      id,
      source: 'v2',
      summary: { id, window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 2, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'reported' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [
        { signature: 'signature-one', component: 'homeassistant.components.demo', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1 },
        { signature: 'signature-two', component: 'homeassistant.components.demo', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1 }
      ] }
    } : null;
    runtimeServices.ignores.add = async (input) => {
      const existing = rules.get(input.match);
      if (existing) return existing;
      const rule = { id: `rule-${rules.size + 1}`, match: input.match, type: 'signature' as const, createdAt: '2026-08-14T12:30:00.000Z' };
      rules.set(input.match, rule);
      return rule;
    };
    runtimeServices.ignores.listActive = async () => [...rules.values()];
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;
    const url = '/api/digests/report-with-signature/problems/signature-one/ignore';

    expect((await app.inject({ method: 'POST', url, headers: { 'x-csrf-token': csrfToken }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/digests/missing/problems/signature-one/ignore', headers: { cookie, 'x-csrf-token': csrfToken }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/digests/report-with-signature/problems/not-in-report/ignore', headers: { cookie, 'x-csrf-token': csrfToken }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { match: 'signature-two' } })).statusCode).toBe(400);

    const created = await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: {} });
    const duplicate = await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ rule: { match: 'signature-one', type: 'signature' }, alreadyIgnored: false });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ rule: { id: created.json<{ rule: { id: string } }>().rule.id }, alreadyIgnored: true });
    expect([...rules.values()]).toHaveLength(1);
  });

  it('accepts only confirmed manual Telegram actions behind authentication and CSRF', async () => {
    const runtimeServices = services();
    const calls: Array<{ reportId: string; actionId: string }> = [];
    const actionId = '11111111-1111-4111-8111-111111111111';
    runtimeServices.manualTelegram = { send: async (reportId, requestedActionId) => {
      calls.push({ reportId, actionId: requestedActionId });
      return { attempt: { actionId: requestedActionId, status: 'sent', requestedAt: '2026-08-14T12:00:00.000Z', completedAt: '2026-08-14T12:00:01.000Z' }, alreadyRequested: calls.length > 1 };
    } };
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;
    const url = '/api/digests/v2-report%3Areport-1/manual-telegram-sends';

    expect((await app.inject({ method: 'POST', url, payload: { actionId, confirmed: true } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { actionId, confirmed: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { actionId, confirmed: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { actionId, confirmed: true, targetRef: 'private-target' } })).statusCode).toBe(400);

    const sent = await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { actionId, confirmed: true } });
    const duplicate = await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrfToken }, payload: { actionId, confirmed: true } });
    expect(sent.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(calls).toEqual([{ reportId: 'v2-report:report-1', actionId }, { reportId: 'v2-report:report-1', actionId }]);
    expect(sent.body).not.toMatch(/target|token|chat|secret|message/i);
  });

  it('deletes multiple reports in batch with POST /api/digests/batch-delete and enforces authentication, CSRF, and validation', async () => {
    const deleted: string[][] = [];
    const runtimeServices = services();
    runtimeServices.reports.removeBatch = async (ids) => {
      deleted.push(ids);
      return ids.length;
    };
    app = createApp({ services: runtimeServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'long-enough-password', language: 'en' } });
    const cookie = registered.headers['set-cookie'];
    const csrfToken = registered.json<{ csrfToken: string }>().csrfToken;

    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/digests/batch-delete',
      headers: { 'x-csrf-token': csrfToken },
      payload: { ids: ['report-1'] }
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/digests/batch-delete',
      headers: { cookie },
      payload: { ids: ['report-1'] }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/digests/batch-delete',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {}
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/digests/batch-delete',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { ids: ['report-1', 'report-2'] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deletedCount: 2 });
    expect(deleted).toEqual([['report-1', 'report-2']]);
  });
});

describe('GET /api/entities/stale endpoint', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('rejects unauthenticated requests with 401', async () => {
    app = createApp({ services: services(), auth: { sessionTtlMs: 60_000 } });
    const response = await app.inject({ method: 'GET', url: '/api/entities/stale' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 OK with audited stale and unavailable entities for authenticated sessions', async () => {
    const mockServices: BackendApiServices = {
      ...services(),
      ha: {
        async getStates() {
          return [
            {
              entity_id: 'sensor.living_room_temp',
              state: 'unavailable',
              last_updated: '2026-08-16T10:00:00.000Z',
              attributes: { friendly_name: 'Living Room Temp' }
            },
            {
              entity_id: 'light.kitchen_light',
              state: 'on',
              last_updated: '2026-08-10T10:00:00.000Z',
              attributes: { friendly_name: 'Kitchen Light' }
            },
            {
              entity_id: 'sun.sun',
              state: 'above_horizon'
            }
          ];
        }
      }
    };
    app = createApp({ services: mockServices, auth: { sessionTtlMs: 60_000 } });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { password: 'long-enough-password', language: 'en' }
    });
    const cookie = registered.headers['set-cookie'];

    const response = await app.inject({
      method: 'GET',
      url: '/api/entities/stale',
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    const parsed = StaleEntitiesResponseSchema.parse(response.json());
    expect(parsed.totalAudited).toBe(2);
    expect(parsed.unavailableCount).toBe(1);
    expect(parsed.staleCount).toBe(1);
    expect(parsed.entities).toHaveLength(2);
    expect(parsed.entities[0].entityId).toBe('sensor.living_room_temp');
    expect(parsed.entities[0].issueType).toBe('unavailable');
    expect(parsed.entities[1].entityId).toBe('light.kitchen_light');
    expect(parsed.entities[1].issueType).toBe('stale');
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
    settings: { get: async () => settings, update: async () => settings }, digestJobs: { enqueue: async () => ({ status: 'queued' as const, jobId: 'job' }), get: async () => null, retryFailed: async () => null }, reports: { list: async () => [], get: async () => null, remove: async () => false, removeBatch: async () => 0 }, notes: { add: async (input) => ({ id: 'note', ...input, createdAt: new Date(now()).toISOString() }), listWindow: async () => [] }, ignores: { add: async (input) => ({ id: 'ignore', ...input, createdAt: new Date(now()).toISOString() }), remove: async () => undefined, listActive: async () => [] }, notifiers: { test: async () => ({ status: 'success' as const, message: 'ok', checkedAt: new Date(now()).toISOString() }), send: async (input) => ({ status: 'skipped' as const, targetRef: input.targetRef }) }
  };
}
function note() { return { text: 'Operator note', occurredAt: '2026-08-03T10:00:00.000Z', tags: [] }; }
