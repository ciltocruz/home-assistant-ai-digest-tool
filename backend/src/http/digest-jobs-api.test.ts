import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type BackendApiServices } from './app.js';

describe('durable digest job API', () => {
  let app: ReturnType<typeof createApp> | undefined;
  afterEach(async () => { await app?.close(); });

  it('returns 202 with a persisted job and exposes safe progress instead of pretending completion', async () => {
    const services = servicesForJobs();
    app = createApp({ services, auth: authOptions() });
    const { cookie, csrfToken } = await login(app);

    const run = await app.inject({ method: 'POST', url: '/api/digests/run', headers: { cookie, 'x-csrf-token': csrfToken }, payload: { kind: 'manual' } });
    const status = await app.inject({ method: 'GET', url: '/api/digests/jobs/job-1', headers: { cookie } });

    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ jobId: 'job-1', status: 'queued' });
    expect(status.json()).toEqual(expect.objectContaining({ id: 'job-1', status: 'running', stage: 'generating' }));
  });

  it('requeues a failed job only once and keeps the failure copy safe', async () => {
    const services = servicesForJobs();
    app = createApp({ services, auth: authOptions() });
    const { cookie, csrfToken } = await login(app);

    const response = await app.inject({ method: 'POST', url: '/api/digests/jobs/job-1/retry', headers: { cookie, 'x-csrf-token': csrfToken } });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(expect.objectContaining({ id: 'job-1', status: 'queued', stage: 'queued' }));
    expect(JSON.stringify(response.json())).not.toContain('raw-provider-token');
  });

  it('redacts unsafe failure details supplied by the job service at the API boundary', async () => {
    const rawFailure = 'Gemini 404: model retired; Bearer bearer-fixture token=token-fixture api_key=api-key-fixture https://provider.test/generate?token=query-token-fixture';
    const services = servicesForJobs({
      status: 'failed',
      stage: 'failed',
      retryAvailable: true,
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      errorMessage: rawFailure
    });
    app = createApp({ services, auth: authOptions() });
    const { cookie } = await login(app);

    const response = await app.inject({ method: 'GET', url: '/api/digests/jobs/job-1', headers: { cookie } });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.errorMessage).toContain('model retired');
    for (const secret of ['bearer-fixture', 'token-fixture', 'api-key-fixture', 'query-token-fixture']) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
  });
});

function authOptions() { return { sessionTtlMs: 60_000 }; }
async function login(app: ReturnType<typeof createApp>) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'digest-job-test-password', language: 'en' } });
  return { cookie: response.headers['set-cookie'], csrfToken: response.json<{ csrfToken: string }>().csrfToken };
}
function servicesForJobs(overrides: Partial<{ status: 'running' | 'failed'; stage: 'generating' | 'failed'; retryAvailable: boolean; errorCode: string; errorMessage: string }> = {}): BackendApiServices {
  let password = ''; const sessions = new Map<string, { csrfToken: string; expiresAtMs: number }>();
  const state = { id: 'job-1', triggerWindowId: 'manual:window', kind: 'manual' as const, status: 'running' as const, stage: 'generating' as const, attempts: 0, retryCount: 0, retryAvailable: false, availableAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', ...overrides };
  return {
    setup: { complete: async () => ({ haUrl: 'http://homeassistant.local:8123', ai: { provider: 'gemini', keyMask: 'masked', ref: 'ref' }, notifiers: [] }) },
    auth: { hasAdmin: async () => Boolean(password), createAdmin: async (value) => { if (password) return false; password = value; return true; }, verifyPassword: async (value) => value === password, changePassword: async (current, next) => { if (current !== password) return false; password = next; sessions.clear(); return true; }, createSession: async (ttl) => { const id = `session-${sessions.size}`; const csrfToken = `csrf-${sessions.size}`; const expiresAtMs = Date.now() + ttl; sessions.set(id, { csrfToken, expiresAtMs }); return { id, csrfToken, expiresAtMs }; }, readSession: async (id, csrf) => { const session = sessions.get(id); return session && session.expiresAtMs > Date.now() && (!csrf || csrf === session.csrfToken) ? { id, ...session } : null; }, removeSession: async (id) => { sessions.delete(id); }, issueCsrf: async () => null, loginAllowed: async () => true, recordFailedLogin: async () => undefined, clearFailedLogins: async () => undefined, language: async () => 'en' },
    settings: { get: async () => ({ homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true } }, ai: { provider: 'gemini', key: { configured: true } }, notifications: { channel: 'none' }, schedules: [], privacyLevel: 'balanced', retentionDays: 30 }), update: async () => { throw new Error('unused'); } },
    digestJobs: { enqueue: async () => ({ status: 'queued', jobId: 'job-1' }), get: async () => state, retryFailed: async () => ({ ...state, status: 'queued' as const, stage: 'queued' as const, retryCount: 1 }) }, digestWorker: { wake: () => undefined },
    reports: { list: async () => [], get: async () => null, remove: async () => false }, notes: { add: async () => { throw new Error('unused'); }, listWindow: async () => [] }, ignores: { add: async () => { throw new Error('unused'); }, remove: async () => undefined, listActive: async () => [] }, notifiers: { test: async () => ({ status: 'success', message: 'ok', checkedAt: '2026-08-01T10:00:00.000Z' }), send: async () => ({ status: 'skipped', targetRef: 'ref' }) }
  };
}
