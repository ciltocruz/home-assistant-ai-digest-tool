import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantWebSocketClient, type HomeAssistantSocket } from './websocket-client.js';

describe('HomeAssistantWebSocketClient', () => {
  afterEach(() => vi.useRealTimers());

  it('takes one authenticated config_entries/get snapshot per report run', async () => {
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'https://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'ha-token' }, webSocketFactory: (url) => { expect(url).toBe('wss://ha.local:8123/api/websocket'); return socket.socket; } });

    const snapshot = client.snapshot();
    await tick(); socket.open(); await tick(); socket.message({ type: 'auth_required', ha_version: '2026.8.0' }); await tick(); socket.message({ type: 'auth_ok' }); await tick(); socket.message({ id: 1, type: 'result', success: true, result: [
      { domain: 'private_email_service', title: 'owner@example.test', state: 'loaded' },
      { domain: 'private_ip_service', title: '192.0.2.10', state: 'not_loaded' },
      { domain: 'private_setup_service', title: 'Temporary setup', state: 'setup_in_progress' },
      { domain: 'private_unload_service', title: 'Temporary unload', state: 'unload_in_progress' },
      { domain: 'private_retry_service', title: 'Retrying account', state: 'setup_retry' },
      { domain: 'private_url_service', title: 'https://private.example.test', state: 'setup_error', reason: 'invalid_auth' },
      { domain: 'private_migration_service', title: 'Private migration', state: 'migration_error' },
      { domain: 'private_device_service', title: 'Bedroom private device', state: 'failed_unload' },
      { domain: 'private_future_service', title: 'Future state', state: 'future_state' },
      { domain: 'private_malformed_service', title: 'Malformed state' }
    ] });

    const result = await snapshot;
    expect(result).toEqual({
      available: true,
      total: 10,
      loaded: 1,
      notLoaded: 1,
      inProgress: 2,
      retrying: 1,
      errors: 3,
      unknown: 2,
      errorGroups: [
        { category: 'authentication_error', reason: 'authentication_failed', count: 1 },
        { category: 'migration_error', reason: 'unknown', count: 1 },
        { category: 'failed_unload', reason: 'unknown', count: 1 }
      ]
    });
    for (const sentinel of ['owner@example.test', '192.0.2.10', 'https://private.example.test', 'Bedroom private device', 'private_email_service']) {
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
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
    await expect(snapshot).resolves.toEqual({ available: false, reason: 'connection_failed' });
  });

  it('returns unavailable when Home Assistant does not answer before the timeout', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'http://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'token' }, webSocketFactory: () => socket.socket, timeoutMs: 25 });
    const snapshot = client.snapshot();
    await tick(); socket.open(); await vi.advanceTimersByTimeAsync(25);
    await expect(snapshot).resolves.toEqual({ available: false, reason: 'socket_timeout' });
  });

  it.each([
    ['rejected authentication', [{ type: 'auth_required' }, { type: 'auth_invalid', message: 'secret-bearing provider text' }], 'auth_failed'],
    ['rejected command', [{ type: 'auth_required' }, { type: 'auth_ok' }, { id: 1, type: 'result', success: false, error: { message: 'private integration title' } }], 'command_rejected'],
    ['invalid command result', [{ type: 'auth_required' }, { type: 'auth_ok' }, { id: 1, type: 'result', success: true, result: {} }], 'invalid_result']
  ] as const)('returns only the safe reason code for %s', async (_label, messages, reason) => {
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'http://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'token' }, webSocketFactory: () => socket.socket });
    const snapshot = client.snapshot();

    await tick(); socket.open();
    for (const message of messages) { await tick(); socket.message(message); }

    await expect(snapshot).resolves.toEqual({ available: false, reason });
    expect(JSON.stringify(await snapshot)).not.toContain('private integration title');
    expect(JSON.stringify(await snapshot)).not.toContain('secret-bearing provider text');
  });

  it('fails safely when auth_required is missing', async () => {
    const socket = fakeSocket();
    const client = new HomeAssistantWebSocketClient({ haUrl: 'http://ha.local:8123', haTokenRef: 'ha', secrets: { resolve: async () => 'token' }, webSocketFactory: () => socket.socket });
    const snapshot = client.snapshot();

    await tick(); socket.open(); await tick(); socket.message({ type: 'auth_ok' }); await tick(); socket.error();

    await expect(snapshot).resolves.toEqual({ available: false, reason: 'auth_required_missing' });
  });
});

function fakeSocket() {
  let closed = false;
  const sent: string[] = [];
  const socket: HomeAssistantSocket = { onopen: null, onmessage: null, onerror: null, onclose: null, send: (data) => sent.push(data), close: () => { closed = true; } };
  return { socket, sent, get closed() { return closed; }, open: () => socket.onopen?.({}), error: () => socket.onerror?.({}), message: (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) }) };
}

async function tick(): Promise<void> { await Promise.resolve(); }
