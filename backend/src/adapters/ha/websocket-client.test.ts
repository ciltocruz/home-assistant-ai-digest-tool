import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantWebSocketClient, type HomeAssistantSocket } from './websocket-client.js';

describe('HomeAssistantWebSocketClient', () => {
  afterEach(() => vi.useRealTimers());

  it('takes one authenticated config_entries/get snapshot per report run', async () => {
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'https://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'ha-token' }, webSocketFactory: (url) => { expect(url).toBe('wss://ha.local:8123/api/websocket'); return socket.socket; } });

    const snapshot = client.snapshot();
    await tick(); socket.open(); await tick(); socket.message({ type: 'auth_ok' }); await tick(); socket.message({ id: 1, type: 'result', success: true, result: [{ domain: 'mqtt', title: 'MQTT', state: 'loaded' }] });

    await expect(snapshot).resolves.toEqual({ available: true, integrations: [{ domain: 'mqtt', title: 'MQTT', state: 'loaded' }] });
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([{ type: 'auth', access_token: 'ha-token' }, { id: 1, type: 'config_entries/get' }]);
    expect(socket.closed).toBe(true);
  });

  it.each([
    ['unreachable socket', async (socket: ReturnType<typeof fakeSocket>) => { socket.error(); }],
    ['token failure', async () => undefined]
  ])('returns unavailable integration status on %s without leaking details', async (_name, drive) => {
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'http://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => { if (_name === 'token failure') throw new Error('token-secret'); return 'token'; } }, webSocketFactory: () => socket.socket });
    const snapshot = client.snapshot();
    await tick();
    if (_name === 'unreachable socket') await drive(socket);
    await expect(snapshot).resolves.toEqual({ available: false, integrations: [] });
  });

  it('returns unavailable when Home Assistant does not answer before the timeout', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'http://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'token' }, webSocketFactory: () => socket.socket, timeoutMs: 25 });
    const snapshot = client.snapshot();
    await tick(); socket.open(); await vi.advanceTimersByTimeAsync(25);
    await expect(snapshot).resolves.toEqual({ available: false, integrations: [] });
  });
});

function fakeSocket() {
  let closed = false;
  const sent: string[] = [];
  const socket: HomeAssistantSocket = { onopen: null, onmessage: null, onerror: null, onclose: null, send: (data) => sent.push(data), close: () => { closed = true; } };
  return { socket, sent, get closed() { return closed; }, open: () => socket.onopen?.({}), error: () => socket.onerror?.({}), message: (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) }) };
}

async function tick(): Promise<void> { await Promise.resolve(); }
