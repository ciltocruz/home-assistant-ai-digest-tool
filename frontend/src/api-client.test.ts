import { describe, expect, test } from 'vitest';
import { createApiClient, ApiClientError } from './api-client.js';

const setupRequest = {
  haUrl: 'http://homeassistant.local:8123',
  haToken: 'sample home assistant private value',
  aiProvider: 'gemini' as const,
  aiKey: 'sample ai private value',
  telegram: { botToken: 'sample telegram private value', chatId: 'sample chat reference' }
};

const settingsResponse = {
  homeAssistant: { url: setupRequest.haUrl, token: { configured: true, mask: '••••ha' } },
  ai: { provider: 'gemini' as const, key: { configured: true, mask: '••••ai' } },
  notifications: { channel: 'telegram' as const, chatId: '123456', botToken: { configured: true, mask: '••••telegram' } },
  schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced' as const,
  retentionDays: 90
};

describe('createApiClient', () => {
  test('loads and saves authenticated onboarding progress through the session boundary', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({ fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, { currentStep: 'ai_provider', completedSteps: ['home_assistant'], draft: { haUrl: setupRequest.haUrl }, secretMetadata: { haToken: { configured: true, mask: 'se…et' } }, completed: false });
    } });

    const onboarding = client as typeof client & { getOnboarding(): Promise<unknown>; saveOnboarding(input: unknown): Promise<unknown> };
    const loaded = await onboarding.getOnboarding();
    const saved = await onboarding.saveOnboarding({ step: 'home_assistant', draft: { haUrl: setupRequest.haUrl }, secrets: { haToken: setupRequest.haToken } });

    expect(calls.map(({ url, init }) => [url, init.method])).toEqual([['/api/onboarding', 'GET'], ['/api/onboarding', 'PATCH']]);
    expect(calls.every(({ init }) => new Headers(init.headers).get('authorization') === null)).toBe(true);
    expect(JSON.stringify([loaded, saved])).not.toContain(setupRequest.haToken);
  });
  test('creates an administrator account through the session boundary and stores the CSRF token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, { csrfToken: 'csrf sample value', language: 'en' });
      }
    });

    await client.register('a-long-enough-password', 'en');

    expect(client.getCsrfToken()).toBe('csrf sample value');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/auth/register');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ password: 'a-long-enough-password', language: 'en' });
  });

  test('reuses the current CSRF token when the authenticated session is bootstrapped again', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      csrfToken: 'csrf sample value',
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, { csrfToken: 'csrf sample value', language: 'en' });
      }
    });

    await client.getSession();

    expect(calls[0]?.url).toBe('/api/session');
    expect(calls[0]?.init.headers).toMatchObject({ 'x-csrf-token': 'csrf sample value' });
  });

  test('uses endpoint contracts for settings, digest history, notes, ignores, and notifier actions', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: 'http://ui.test',
      csrfToken: 'csrf sample value',
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return routeResponse(String(url), init);
      }
    });

    await client.getSettings();
    await client.updateSettings({
      homeAssistant: { url: setupRequest.haUrl, token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '123456', botToken: { operation: 'keep_current' } },
      schedules: settingsResponse.schedules,
      privacyLevel: settingsResponse.privacyLevel,
      retentionDays: settingsResponse.retentionDays
    });
    await client.runDigest({ kind: 'manual' });
    await client.listHistory();
    await client.addNote({ text: 'Observed restart', occurredAt: '2026-07-10T10:00:00.000Z', tags: ['maintenance'] });
    await client.listNotes({ from: '2026-07-10T00:00:00.000Z', to: '2026-07-11T00:00:00.000Z' });
    await client.listIgnores();
    await client.addIgnore({ match: 'sensor.noisy', type: 'entity', reason: 'Known noisy fixture' });
    await client.removeIgnore('ignore/id with spaces');
    await client.testNotifier({ channel: 'telegram', targetRef: 'ref-telegram', message: 'Synthetic test message' });
    await client.sendDigest('digest-1', 'ref-telegram');

    expect(calls.map((call) => [call.url, call.init.method ?? 'GET'])).toEqual([
      ['http://ui.test/api/settings', 'GET'],
      ['http://ui.test/api/settings', 'PUT'],
      ['http://ui.test/api/digests/run', 'POST'],
      ['http://ui.test/api/digests/history', 'GET'],
      ['http://ui.test/api/notes', 'POST'],
      ['http://ui.test/api/notes?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z', 'GET'],
      ['http://ui.test/api/ignores', 'GET'],
      ['http://ui.test/api/ignores', 'POST'],
      ['http://ui.test/api/ignores/ignore%2Fid%20with%20spaces', 'DELETE'],
      ['http://ui.test/api/notifiers/test', 'POST'],
      ['http://ui.test/api/notifiers/send', 'POST']
    ]);
    expect(calls[0]?.init.headers).not.toMatchObject({ 'x-csrf-token': 'csrf sample value' });
    for (const call of calls.filter((entry) => (entry.init.method ?? 'GET') !== 'GET')) {
      expect(call.init.headers).toMatchObject({ 'x-csrf-token': 'csrf sample value', 'content-type': 'application/json' });
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      homeAssistant: { url: setupRequest.haUrl, token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '123456', botToken: { operation: 'keep_current' } },
      schedules: settingsResponse.schedules,
      privacyLevel: settingsResponse.privacyLevel,
      retentionDays: settingsResponse.retentionDays
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ kind: 'manual' });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ text: 'Observed restart', occurredAt: '2026-07-10T10:00:00.000Z', tags: ['maintenance'] });
    expect(JSON.parse(String(calls[7]?.init.body))).toEqual({ match: 'sensor.noisy', type: 'entity', reason: 'Known noisy fixture' });
    expect(calls[8]?.init.body).toBeUndefined();
    expect(JSON.parse(String(calls[9]?.init.body))).toEqual({ channel: 'telegram', targetRef: 'ref-telegram', message: 'Synthetic test message' });
    expect(JSON.parse(String(calls[10]?.init.body))).toEqual({ digestId: 'digest-1', targetRef: 'ref-telegram' });
  });

  test('rejects unexpected response shapes before UI state can consume them', async () => {
    const client = createApiClient({
      fetch: async () => jsonResponse(200, { haUrl: 'not a url' })
    });

    await expect(client.getSettings()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      requestId: 'client'
    });
  });

  test('accepts queued manual jobs and keeps report detail validation separate', async () => {
    const client = createApiClient({ fetch: async (url, init = {}) => url.endsWith('/api/digests/run')
      ? jsonResponse(202, { status: 'queued', jobId: 'job-1' })
      : routeResponse(String(url), init) });
    const result = await client.runDigest({ kind: 'manual' });
    expect(result).toEqual({ status: 'queued', jobId: 'job-1' });
    await expect(client.getDigest('digest-1')).resolves.toMatchObject({ id: 'digest-1', rendered: { format: 'markdown' } });
  });

  test('reads durable job progress and submits a bounded retry through the safe API contract', async () => {
    const calls: string[] = [];
    const job = { id: 'job-1', status: 'failed', stage: 'failed', attempts: 1, retryCount: 0, retryAvailable: true, errorCode: 'HOME_ASSISTANT_UNAVAILABLE', errorMessage: 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' };
    const client = createApiClient({ csrfToken: 'csrf-token', fetch: async (url, init = {}) => {
      calls.push(`${String(url)}:${init.method ?? 'GET'}`);
      return jsonResponse(200, String(url).endsWith('/retry') ? { ...job, status: 'queued', stage: 'queued', retryCount: 1, retryAvailable: false } : job);
    } });

    await expect(client.getDigestJob('job-1')).resolves.toMatchObject({ stage: 'failed', retryAvailable: true });
    await expect(client.retryDigestJob('job-1')).resolves.toMatchObject({ status: 'queued', retryCount: 1, retryAvailable: false });
    expect(calls).toEqual(['/api/digests/jobs/job-1:GET', '/api/digests/jobs/job-1/retry:POST']);
  });

  test('keeps a safe contract diagnostic for malformed manual report details', async () => {
    const client = createApiClient({ fetch: async (url) => url.endsWith('/api/digests/bad') ? jsonResponse(200, { id: 'bad' }) : jsonResponse(404, { code: 'NOT_FOUND', message: 'Not found.', requestId: 'missing' }) });
    await expect(client.getDigest('bad')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: expect.stringContaining('invalid') });
  });

  test('validates sendDigest input through the shared DTO contract before sending', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, deliveryResultResponse);
      }
    });

    expect(() => client.sendDigest('', 'ref-telegram')).toThrow();

    expect(calls).toHaveLength(0);
  });

  test('redacts secret-like values from server errors before exposing them to UI state', async () => {
    const bearerScheme = ['Bea', 'rer'].join('');
    const jwtLikeValue = [jsonBase64UrlSentinel('header'), jsonBase64UrlSentinel('payload'), 'signature_value'].join('.');
    const opaqueBearerValue = 'opaque-setup-sample';
    const longLivedAccessValue = [jsonBase64UrlSentinel('home-assistant-access'), 'longBase64UrlValue'].join('');
    const client = createApiClient({
      csrfToken: 'csrf sample value',
      fetch: async () => jsonResponse(500, {
        code: 'INTERNAL_ERROR',
        message: `Provider failed with ${bearerScheme} ${jwtLikeValue}, legacy credential ${bearerScheme} ${opaqueBearerValue}, and Home Assistant access ${longLivedAccessValue}`,
        requestId: 'req-1'
      })
    });

    await expect(client.runDigest({ kind: 'manual' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      requestId: 'req-1'
    });

    try {
      await client.runDigest({ kind: 'manual' });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect(String(error)).not.toContain(`${bearerScheme} ${jwtLikeValue.slice(0, 10)}`);
      expect(String(error)).not.toContain(`${bearerScheme} ${opaqueBearerValue}`);
      expect(String(error)).not.toContain(longLivedAccessValue.slice(0, 10));
      expect(String(error)).toContain('[redacted]');
    }
  });

  test('redacts secret-like values from field errors before storing them on ApiClientError', async () => {
    const bearerScheme = ['Bea', 'rer'].join('');
    const fieldSecret = `${bearerScheme} ${jsonBase64UrlSentinel('field')}.${jsonBase64UrlSentinel('payload')}.signature_value`;
    const opaqueFieldSecret = `${bearerScheme} opaque-setup-sample`;
    const client = createApiClient({
      fetch: async () => jsonResponse(400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed.',
        requestId: 'req-field-errors',
        fieldErrors: {
          haToken: [`Invalid Home Assistant token ${fieldSecret}`],
          legacyCredential: [`Invalid legacy credential ${opaqueFieldSecret}`],
          nested: [`Provider key ${['sk', '_field_secret_value'].join('')} is not allowed`]
        }
      })
    });

    try {
      await client.getSettings();
      throw new Error('Expected getSettings to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      const apiError = error as ApiClientError;
      expect(apiError.fieldErrors?.haToken?.[0]).toBe('Invalid Home Assistant token Bearer [redacted]');
      expect(apiError.fieldErrors?.legacyCredential?.[0]).toBe('Invalid legacy credential Bearer [redacted]');
      expect(apiError.fieldErrors?.nested?.[0]).toBe('Provider key [redacted] is not allowed');
      expect(JSON.stringify(apiError.fieldErrors)).not.toContain(fieldSecret);
      expect(JSON.stringify(apiError.fieldErrors)).not.toContain(opaqueFieldSecret);
    }
  });

  test('wraps fetch rejections in a deterministic safe ApiClientError', async () => {
    const rawNetworkSecret = `${['gh', 'p'].join('')}_network_secret_value`;
    const client = createApiClient({
      fetch: async () => {
        throw new Error(`socket failure leaked ${rawNetworkSecret}`);
      }
    });

    try {
      await client.getSettings();
      throw new Error('Expected getSettings to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error).toMatchObject({ code: 'NETWORK_ERROR', requestId: 'client' });
      expect(String(error)).toContain('Network request failed');
      expect(String(error)).not.toContain(rawNetworkSecret);
      expect(String(error)).not.toContain('socket failure');
    }
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function jsonBase64UrlSentinel(label: string): string {
  return `${String.fromCharCode(101, 121, 74)}${Buffer.from(`sentinel-${label}`).toString('base64url')}`;
}

const digestSummaryResponse = {
  id: 'digest-1',
  window: { from: '2026-07-10T09:00:00.000Z', to: '2026-07-10T10:00:00.000Z' },
  severityCounts: { critical: 0, warning: 1, info: 2 },
  createdAt: '2026-07-10T10:00:00.000Z',
  deliveryStatus: 'sent'
};

const noteResponse = { id: 'note-1', text: 'Observed restart', occurredAt: '2026-07-10T10:00:00.000Z', createdAt: '2026-07-10T10:01:00.000Z', tags: ['maintenance'] };
const ignoreResponse = { id: 'ignore-1', match: 'sensor.noisy', type: 'entity', createdAt: '2026-07-10T10:00:00.000Z', reason: 'Known noisy fixture' };
const testResultResponse = { status: 'success', message: 'Delivered synthetic test notification', checkedAt: '2026-07-10T10:00:00.000Z' };
const deliveryResultResponse = { status: 'sent', targetRef: 'ref-telegram', deliveredAt: '2026-07-10T10:00:00.000Z' };

function routeResponse(url: string, init: RequestInit): Response {
  const method = init.method ?? 'GET';
  if (url.endsWith('/api/settings') && method === 'GET') return jsonResponse(200, settingsResponse);
  if (url.endsWith('/api/settings') && method === 'PUT') return jsonResponse(200, settingsResponse);
  if (url.endsWith('/api/digests/run') && method === 'POST') return jsonResponse(200, { jobId: 'job-1', status: 'queued' });
  if (url.endsWith('/api/digests/history') && method === 'GET') return jsonResponse(200, [digestSummaryResponse]);
  if (url.endsWith('/api/digests/digest-1') && method === 'GET') return jsonResponse(200, { id: 'digest-1', summary: digestSummaryResponse, rendered: { format: 'markdown', body: '# Synthetic report' } });
  if (url.endsWith('/api/notes') && method === 'POST') return jsonResponse(200, noteResponse);
  if (url.endsWith('/api/notes?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z') && method === 'GET') return jsonResponse(200, [noteResponse]);
  if (url.endsWith('/api/ignores') && method === 'GET') return jsonResponse(200, [ignoreResponse]);
  if (url.endsWith('/api/ignores') && method === 'POST') return jsonResponse(200, ignoreResponse);
  if (url.endsWith('/api/ignores/ignore%2Fid%20with%20spaces') && method === 'DELETE') return emptyResponse(204);
  if (url.endsWith('/api/notifiers/test') && method === 'POST') return jsonResponse(200, testResultResponse);
  if (url.endsWith('/api/notifiers/send') && method === 'POST') return jsonResponse(200, deliveryResultResponse);
  return jsonResponse(404, { code: 'NOT_FOUND', message: 'No fixture route matched.', requestId: 'fixture' });
}
