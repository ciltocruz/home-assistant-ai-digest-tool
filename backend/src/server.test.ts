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
        DATA_DIR: await mkdtemp(join(tmpdir(), 'ha-digest-startup-logs-')),
        ADMIN_TOKEN: 'admin-sentinel-secret',
        SETUP_TOKEN: 'setup-sentinel-secret',
        TRUST_PROXY: 'not-a-boolean'
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
    expect(JSON.stringify(startupEvents)).not.toContain('admin-sentinel-secret');
    expect(JSON.stringify(startupEvents)).not.toContain('setup-sentinel-secret');
  });
});
