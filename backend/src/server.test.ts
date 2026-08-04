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
          reportStartupFailure: (event) => startupEvents.push(event)
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
        createLogger: () => ({ reportApiFailure: vi.fn(), reportStartupFailure: vi.fn() }),
        registerSignalHandler: (signal, handler) => handlers.set(signal, handler)
      }
    );

    await handlers.get('SIGTERM')?.();
    await handlers.get('SIGINT')?.();

    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('SIGINT')).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

});
