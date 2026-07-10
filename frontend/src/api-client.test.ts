import { describe, expect, test } from 'vitest';
import { createApiClient, ApiClientError } from './api-client.js';

const setupRequest = {
  haUrl: 'http://homeassistant.local:8123',
  haToken: 'SENTINEL_HA_ACCESS_VALUE',
  aiProvider: 'gemini' as const,
  aiKey: 'SENTINEL_AI_PROVIDER_VALUE',
  telegram: { botToken: 'SENTINEL_TELEGRAM_BOT_VALUE', chatId: 'SENTINEL_CHAT_ID' }
};

const settingsResponse = {
  haUrl: setupRequest.haUrl,
  aiProvider: 'gemini' as const,
  secretRefs: {
    haTokenRef: 'ref-home-assistant-access',
    aiKeyRef: 'ref-ai-provider',
    notifierRefs: { telegram: 'ref-telegram' }
  },
  schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced' as const,
  retentionDays: 90
};

describe('createApiClient', () => {
  test('validates setup through the shared DTO contract and stores the CSRF token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      setupToken: 'SETUP_ACCESS_SENTINEL',
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, {
          settings: {
            haUrl: setupRequest.haUrl,
            ai: { provider: 'gemini', keyMask: '••••-sentinel', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          },
          csrfToken: 'CSRF_SENTINEL'
        });
      }
    });

    const response = await client.validateSetup(setupRequest);

    expect(response.settings.ai.ref).toBe('ref-ai');
    expect(client.getCsrfToken()).toBe('CSRF_SENTINEL');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/setup');
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer SETUP_ACCESS_SENTINEL' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(setupRequest);
  });

  test('uses endpoint contracts for settings, digest history, notes, ignores, and notifier actions', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: 'http://ui.test',
      csrfToken: 'CSRF_SENTINEL',
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return routeResponse(String(url), init);
      }
    });

    await client.getSettings();
    await client.updateSettings(settingsResponse);
    await client.runDigest({ kind: 'manual' });
    await client.listHistory();
    await client.addNote({ text: 'Observed restart', occurredAt: '2026-07-10T10:00:00.000Z', tags: ['maintenance'] });
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
      ['http://ui.test/api/ignores', 'GET'],
      ['http://ui.test/api/ignores', 'POST'],
      ['http://ui.test/api/ignores/ignore%2Fid%20with%20spaces', 'DELETE'],
      ['http://ui.test/api/notifiers/test', 'POST'],
      ['http://ui.test/api/notifiers/send', 'POST']
    ]);
    expect(calls[0]?.init.headers).not.toMatchObject({ 'x-csrf-token': 'CSRF_SENTINEL' });
    for (const call of calls.filter((entry) => (entry.init.method ?? 'GET') !== 'GET')) {
      expect(call.init.headers).toMatchObject({ 'x-csrf-token': 'CSRF_SENTINEL', 'content-type': 'application/json' });
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(settingsResponse);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ kind: 'manual' });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ text: 'Observed restart', occurredAt: '2026-07-10T10:00:00.000Z', tags: ['maintenance'] });
    expect(JSON.parse(String(calls[6]?.init.body))).toEqual({ match: 'sensor.noisy', type: 'entity', reason: 'Known noisy fixture' });
    expect(calls[7]?.init.body).toBeUndefined();
    expect(JSON.parse(String(calls[8]?.init.body))).toEqual({ channel: 'telegram', targetRef: 'ref-telegram', message: 'Synthetic test message' });
    expect(JSON.parse(String(calls[9]?.init.body))).toEqual({ digestId: 'digest-1', targetRef: 'ref-telegram' });
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
    const opaqueBearerValue = 'SETUP_ACCESS_SENTINEL';
    const longLivedAccessValue = [jsonBase64UrlSentinel('home-assistant-access'), 'longBase64UrlValue'].join('');
    const client = createApiClient({
      csrfToken: 'CSRF_SENTINEL',
      fetch: async () => jsonResponse(500, {
        code: 'INTERNAL_ERROR',
        message: `Provider failed with ${bearerScheme} ${jwtLikeValue}, setup token ${bearerScheme} ${opaqueBearerValue}, and Home Assistant access ${longLivedAccessValue}`,
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
    const opaqueFieldSecret = `${bearerScheme} SETUP_ACCESS_SENTINEL`;
    const client = createApiClient({
      fetch: async () => jsonResponse(400, {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed.',
        requestId: 'req-field-errors',
        fieldErrors: {
          haToken: [`Invalid Home Assistant token ${fieldSecret}`],
          setupToken: [`Invalid setup token ${opaqueFieldSecret}`],
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
      expect(apiError.fieldErrors?.setupToken?.[0]).toBe('Invalid setup token Bearer [redacted]');
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
  if (url.endsWith('/api/notes') && method === 'POST') return jsonResponse(200, noteResponse);
  if (url.endsWith('/api/ignores') && method === 'GET') return jsonResponse(200, [ignoreResponse]);
  if (url.endsWith('/api/ignores') && method === 'POST') return jsonResponse(200, ignoreResponse);
  if (url.endsWith('/api/ignores/ignore%2Fid%20with%20spaces') && method === 'DELETE') return emptyResponse(204);
  if (url.endsWith('/api/notifiers/test') && method === 'POST') return jsonResponse(200, testResultResponse);
  if (url.endsWith('/api/notifiers/send') && method === 'POST') return jsonResponse(200, deliveryResultResponse);
  return jsonResponse(404, { code: 'NOT_FOUND', message: 'No fixture route matched.', requestId: 'fixture' });
}
