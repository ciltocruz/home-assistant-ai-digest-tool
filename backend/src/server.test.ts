import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeServer } from './server.js';

describe('runtime server startup', () => {
  it('logs a configuration failure before constructing the app without leaking secrets', async () => {
    const startupEvents: unknown[] = [];
    const createApp = vi.fn();
    const setExitCode = vi.fn();

    await startRuntimeServer(
      {
        DATA_DIR: await mkdtemp(join(tmpdir(), 'ha-digest-startup-logs-')), TRUST_PROXY: 'not-a-boolean'
      },
      {
        createApp,
        createLogger: () => ({
          reportApiFailure: vi.fn(),
          reportDigestFailure: vi.fn(),
          reportStartupFailure: (event) => startupEvents.push(event),
          reportOperational: vi.fn()
        }),
        setExitCode
      }
    );

    expect(createApp).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(startupEvents).toEqual([
      expect.objectContaining({ event: 'runtime_startup_failure', reason: 'runtime_startup_failed', errorName: 'Error' })
    ]);
  });

  it('awaits idempotent application cleanup for SIGTERM and SIGINT', async () => {
    const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
    const close = vi.fn(async () => undefined);

    await startRuntimeServer(
      {
        DATA_DIR: await mkdtemp(join(tmpdir(), 'ha-digest-shutdown-'))
      },
      {
        createApp: async () => ({ listen: vi.fn(async () => undefined), close }) as never,
        createLogger: () => ({ reportApiFailure: vi.fn(), reportDigestFailure: vi.fn(), reportStartupFailure: vi.fn(), reportOperational: vi.fn() }),
        registerSignalHandler: (signal, handler) => handlers.set(signal, handler)
      }
    );

    await handlers.get('SIGTERM')?.();
    await handlers.get('SIGINT')?.();

    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('SIGINT')).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('emits one safe stdout lifecycle sequence without logging health polls', async () => {
    const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
    const events: unknown[] = [];
    await startRuntimeServer(
      { DATA_DIR: await mkdtemp(join(tmpdir(), 'ha-digest-lifecycle-')) },
      {
        createApp: async () => ({ listen: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }) as never,
        createLogger: () => ({ reportApiFailure: vi.fn(), reportDigestFailure: vi.fn(), reportStartupFailure: vi.fn(), reportOperational: (event) => { events.push(event); } }),
        registerSignalHandler: (signal, handler) => handlers.set(signal, handler)
      }
    );

    await handlers.get('SIGTERM')?.();

    expect(events).toEqual([{ event: 'runtime_starting' }, { event: 'runtime_listening' }, { event: 'runtime_shutdown' }]);
    expect(events).not.toContainEqual({ event: 'runtime_ready' });
  });

  it('emits a safe fatal lifecycle event when startup fails', async () => {
    const events: unknown[] = [];
    await startRuntimeServer(
      { DATA_DIR: await mkdtemp(join(tmpdir(), 'ha-digest-fatal-')), TRUST_PROXY: 'invalid-private-config' },
      {
        createLogger: () => ({ reportApiFailure: vi.fn(), reportDigestFailure: vi.fn(), reportStartupFailure: vi.fn(), reportOperational: (event) => { events.push(event); } }),
        setExitCode: vi.fn()
      }
    );

    expect(events).toEqual([{ event: 'runtime_starting' }, { event: 'runtime_fatal', reason: 'runtime_startup_failed' }]);
    expect(JSON.stringify(events)).not.toContain('invalid-private-config');
  });

});
