import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SetupValidationResponseSchema, type DigestSummary, type MaskedSettings, type NoteCreate, type RedactedSettingsDto } from '@ha-digest/shared';
import { createApp, type BackendApiServices } from './app.js';

const NOW = '2026-07-08T10:00:00.000Z';
const SECRET_HA_TOKEN = 'sentinel-ha-credential-value';
const SECRET_AI_KEY = 'sentinel-ai-credential-value';
const SECRET_TELEGRAM_TOKEN = 'sentinel-telegram-credential-value';

describe('backend API auth, CSRF, and protected routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('blocks protected routes without an authenticated session', async () => {
    app = createApp({ services: createServices(), auth: authOptions() });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('requires CSRF tokens for authenticated mutations but not reads', async () => {
    app = createApp({ services: createServices(), auth: authOptions(), now: () => NOW });
    const { cookie, csrfToken } = await authenticated(app);

    const read = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    const denied = await app.inject({ method: 'POST', url: '/api/notes', headers: { cookie }, payload: validNoteCreate() });
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: validNoteCreate()
    });

    expect([read.statusCode, denied.statusCode, allowed.statusCode]).toEqual([200, 403, 201]);
    expect(denied.json()).toMatchObject({ code: 'CSRF_REQUIRED' });
  });

  it('invalidates the server-side session and clears the cookie on logout', async () => {
    app = createApp({ services: createServices(), auth: authOptions(), now: () => NOW });
    const { cookie, csrfToken } = await authenticated(app);

    const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie, 'x-csrf-token': csrfToken } });
    const afterLogout = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });

    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects expired sessions before protected routes can run', async () => {
    let nowMs = Date.parse(NOW);
    const services = createServices();
    app = createApp({ services, auth: { ...authOptions(), sessionTtlMs: 1_000 }, now: () => new Date(nowMs).toISOString() });
    const { cookie } = await authenticated(app);
    nowMs += 1_001;

    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(services.calls).toEqual([]);
  });

  it('returns VALIDATION_FAILED for invalid protected mutation input', async () => {
    app = createApp({ services: createServices(), auth: authOptions(), now: () => NOW });
    const { cookie, csrfToken } = await authenticated(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { text: '', occurredAt: NOW, tags: [] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { text: expect.any(Array) } });
  });

  it('records redacted operational events for service failures without leaking secrets in responses', async () => {
    const SECRET_IN_FAILURE = 'sentinel-provider-failure-credential';
    const operationalEvents: unknown[] = [];
    const services = createServices();
    services.settings.get = async () => {
      throw new Error(`provider failed with ${SECRET_IN_FAILURE}`);
    };
    app = createApp({
      services,
      auth: authOptions(),
      now: () => NOW,
      failureReporter: (event) => operationalEvents.push(event)
    });
    const { cookie } = await authenticated(app);

    const response = await app.inject({ method: 'GET', url: '/api/settings?providerKey=sentinel-provider-query-credential', headers: { cookie } });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(SECRET_IN_FAILURE);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Request failed. Check server logs with redaction enabled.' });
    expect(JSON.stringify(operationalEvents)).not.toContain(SECRET_IN_FAILURE);
    expect(JSON.stringify(operationalEvents)).not.toContain('sentinel-provider-query-credential');
    expect(operationalEvents).toEqual([
      expect.objectContaining({ method: 'GET', url: '/api/settings', statusCode: 500, code: 'INTERNAL_ERROR', errorName: 'Error' })
    ]);
  });

  it('can mark auth cookies Secure for HTTPS production deployments', async () => {
    app = createApp({ services: createServices(), auth: { ...authOptions(), secureCookies: true }, now: () => NOW });

    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { adminToken: 'admin-token' } });

    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Lax');
    expect(login.headers['set-cookie']).toContain('Secure');
  });

  it('uses forwarded client IP headers only when the controlled proxy is trusted', async () => {
    const trustedApp = createApp({
      services: createServices(),
      auth: authOptions(),
      trustProxy: true,
      publicRequest: (request) => request.url === '/request-ip'
    });
    trustedApp.get('/request-ip', async (request) => ({ ip: request.ip }));
    app = trustedApp;

    const trusted = await trustedApp.inject({ method: 'GET', url: '/request-ip', headers: { 'x-forwarded-for': '203.0.113.9' } });
    await trustedApp.close();
    app = createApp({
      services: createServices(),
      auth: authOptions(),
      trustProxy: false,
      publicRequest: (request) => request.url === '/request-ip'
    });
    app.get('/request-ip', async (request) => ({ ip: request.ip }));
    const untrusted = await app.inject({ method: 'GET', url: '/request-ip', headers: { 'x-forwarded-for': '203.0.113.9' } });

    expect(trusted.json()).toEqual({ ip: '203.0.113.9' });
    expect(untrusted.json()).not.toEqual({ ip: '203.0.113.9' });
  });

  it('bootstraps setup with a bearer setup token, creates a session, and never returns raw secrets', async () => {
    app = createApp({ services: createServices(), auth: authOptions(), now: () => NOW });

    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { authorization: 'Bearer setup-token' },
      payload: {
        haUrl: 'http://homeassistant.local:8123',
        haToken: SECRET_HA_TOKEN,
        aiProvider: 'gemini',
        aiKey: SECRET_AI_KEY,
        telegram: { botToken: SECRET_TELEGRAM_TOKEN, chatId: '123456' }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('ha_digest_session=');
    expect(response.body).not.toContain(SECRET_HA_TOKEN);
    expect(response.body).not.toContain(SECRET_AI_KEY);
    expect(response.body).not.toContain(SECRET_TELEGRAM_TOKEN);
    expect(response.json()).toMatchObject({
      csrfToken: expect.any(String),
      settings: {
        ai: { provider: 'gemini', keyMask: '••••-key', ref: 'secret:ai' },
        notifiers: [{ channel: 'telegram', targetRef: 'secret:telegram', secretMask: '••••-gram' }]
      }
    });
    expect(() => SetupValidationResponseSchema.parse(response.json())).not.toThrow();
  });

  it('registers protected API routes using injected stores and fake notifier services', async () => {
    const services = createServices();
    app = createApp({ services, auth: authOptions(), now: () => NOW });
    const { cookie, csrfToken } = await authenticated(app);
    const mutationHeaders = { cookie, 'x-csrf-token': csrfToken };

    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    const run = await app.inject({ method: 'POST', url: '/api/digests/run', headers: mutationHeaders, payload: { kind: 'manual' } });
    const history = await app.inject({ method: 'GET', url: '/api/digests/history', headers: { cookie } });
    const note = await app.inject({ method: 'POST', url: '/api/notes', headers: mutationHeaders, payload: validNoteCreate() });
    const notes = await app.inject({
      method: 'GET',
      url: '/api/notes?from=2026-07-08T00:00:00.000Z&to=2026-07-09T00:00:00.000Z',
      headers: { cookie }
    });
    const ignore = await app.inject({ method: 'POST', url: '/api/ignores', headers: mutationHeaders, payload: { match: 'sensor.noisy', type: 'entity' } });
    const ignores = await app.inject({ method: 'GET', url: '/api/ignores', headers: { cookie } });
    const notifierTest = await app.inject({
      method: 'POST',
      url: '/api/notifiers/test',
      headers: mutationHeaders,
      payload: { channel: 'telegram', targetRef: 'secret:telegram', message: 'test' }
    });
    const notifierSend = await app.inject({
      method: 'POST',
      url: '/api/notifiers/send',
      headers: mutationHeaders,
      payload: { digestId: 'digest-1', targetRef: 'secret:telegram' }
    });

    expect([settings.statusCode, note.statusCode, ignore.statusCode]).toEqual([200, 201, 201]);
    expect([history.json(), notes.json(), ignores.json()].map((rows) => rows.length)).toEqual([1, 1, 1]);
    expect(run.json()).toEqual({ jobId: 'job-1', status: 'queued' });
    expect(notifierTest.json()).toMatchObject({ status: 'success' });
    expect(notifierSend.json()).toMatchObject({ status: 'sent', targetRef: 'secret:telegram' });
    expect(JSON.stringify(services.calls)).not.toContain(SECRET_TELEGRAM_TOKEN);
  });
});

function authOptions() {
  return { adminToken: 'admin-token', setupToken: 'setup-token', sessionTtlMs: 60_000 };
}

async function authenticated(app: FastifyInstance) {
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { adminToken: 'admin-token' } });
  return { cookie: login.headers['set-cookie'], csrfToken: login.json<{ csrfToken: string }>().csrfToken };
}

function createServices(): BackendApiServices & { calls: unknown[] } {
  const calls: unknown[] = [];
  const settingsDto: RedactedSettingsDto = {
    haUrl: 'http://homeassistant.local:8123',
    aiProvider: 'gemini',
    secretRefs: { haTokenRef: 'secret:ha', aiKeyRef: 'secret:ai', notifierRefs: { telegram: 'secret:telegram' } },
    schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'UTC' }],
    privacyLevel: 'balanced',
    retentionDays: 30
  };
  const maskedSettings: MaskedSettings = {
    haUrl: settingsDto.haUrl,
    ai: { provider: 'gemini', keyMask: '••••-key', ref: 'secret:ai' },
    notifiers: [{ id: 'telegram-default', channel: 'telegram', targetRef: 'secret:telegram', label: 'Telegram', secretMask: '••••-gram' }]
  };
  const digestSummary: DigestSummary = {
    id: 'digest-1',
    window: { from: '2026-07-08T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z' },
    severityCounts: { critical: 0, warning: 1, info: 2 },
    createdAt: NOW,
    deliveryStatus: 'sent'
  };
  const noteDto = { id: 'note-1', text: 'Door maintenance', occurredAt: NOW, createdAt: NOW, tags: ['maintenance'] };
  const ignoreDto = { id: 'ignore-1', match: 'sensor.noisy', type: 'entity' as const, createdAt: NOW };
  const testResult = { status: 'success' as const, message: 'Fake notifier accepted test.', checkedAt: NOW };
  const deliveryResult = { status: 'sent' as const, targetRef: 'secret:telegram', deliveredAt: NOW };

  return {
    calls,
    setup: { complete: async () => maskedSettings },
    settings: { get: async () => settingsDto, update: async (input) => input },
    digestJobs: { enqueue: async () => ({ status: 'queued', jobId: 'job-1' }) },
    reports: { list: async () => [digestSummary] },
    notes: { add: async () => noteDto, listWindow: async () => [noteDto] },
    ignores: { add: async () => ignoreDto, remove: async () => undefined, listActive: async () => [ignoreDto] },
    notifiers: {
      test: async (input) => {
        calls.push(input);
        return testResult;
      },
      send: async (input) => {
        calls.push(input);
        return deliveryResult;
      }
    }
  };
}

function validNoteCreate(): NoteCreate {
  return { text: 'Door maintenance', occurredAt: NOW, tags: ['maintenance'] };
}
