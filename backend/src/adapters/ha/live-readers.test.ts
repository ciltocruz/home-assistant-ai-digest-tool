import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HomeAssistantRestClient } from './rest-client.js';
import { HomeAssistantLogTailReader } from './log-reader.js';

const TOKEN = 'sentinel-live-ha-token';

describe('bounded live Home Assistant readers', () => {
  it('resolves the encrypted token inside a read-only bounded states request', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HomeAssistantRestClient({
      haUrl: 'https://ha.example.test',
      haTokenRef: 'secret:ha',
      secrets: { resolve: async () => TOKEN },
      maxStates: 1,
      maxResponseBytes: 2_000,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify([state('sensor.a'), state('sensor.b')]), { status: 200 });
      }
    });

    await expect(client.listStates()).resolves.toEqual([state('sensor.a')]);
    expect(requests).toEqual([expect.objectContaining({
      url: 'https://ha.example.test/api/states',
      init: expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) })
    })]);
  });

  it('returns safe source errors for non-success, malformed, and oversized states without exposing the token', async () => {
    for (const response of [new Response('forbidden', { status: 401 }), new Response('{}', { status: 200 }), new Response('x'.repeat(100), { status: 200 })]) {
      const client = new HomeAssistantRestClient({
        haUrl: 'http://homeassistant.local:8123', haTokenRef: 'secret:ha', secrets: { resolve: async () => TOKEN },
        maxResponseBytes: 16, fetch: async () => response
      });
      await expect(client.listStates()).rejects.toThrow(/HA_STATES_(UNAVAILABLE|INVALID|TOO_LARGE)/);
      await expect(client.listStates()).rejects.not.toThrow(TOKEN);
    }
  });

  it('reads only the configured tail bytes and lines from a fixed mounted log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ha-live-log-'));
    const path = join(dir, 'home-assistant.log');
    await writeFile(path, 'old-line\nline-1\nline-2\nline-3\n');
    const reader = new HomeAssistantLogTailReader({ path, maxBytes: 24, maxLines: 2 });

    await expect(reader.readLogLines()).resolves.toEqual(['line-2', 'line-3']);
  });

  it('propagates cancellation to REST reads without exposing the HA token', async () => {
    const controller = new AbortController();
    const client = new HomeAssistantRestClient({
      haUrl: 'https://ha.example.test', haTokenRef: 'secret:ha', secrets: { resolve: async () => TOKEN },
      fetch: async (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true }))
    });

    const read = client.listStates({ signal: controller.signal, checkpoint: () => { if (controller.signal.aborted) throw controller.signal.reason; }, deadlineAtMs: Date.now() + 1_000, dispose: () => undefined });
    controller.abort(new Error('ANALYSIS_CANCELLED'));

    await expect(read).rejects.toThrow('ANALYSIS_CANCELLED');
    await expect(read).rejects.not.toThrow(TOKEN);
  });

  it('stops a mounted log read before returning lines when its execution context is cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ha-live-log-cancelled-'));
    const path = join(dir, 'home-assistant.log');
    await writeFile(path, 'line-1\nline-2\n');
    const controller = new AbortController();
    controller.abort(new Error('ANALYSIS_CANCELLED'));

    await expect(new HomeAssistantLogTailReader({ path }).readLogLines({ signal: controller.signal, checkpoint: () => { throw controller.signal.reason; }, deadlineAtMs: Date.now(), dispose: () => undefined })).rejects.toThrow('ANALYSIS_CANCELLED');
  });
});

function state(entityId: string) {
  return { entity_id: entityId, state: 'on', last_changed: '2026-07-29T10:00:00.000Z', last_updated: '2026-07-29T10:00:00.000Z' };
}
