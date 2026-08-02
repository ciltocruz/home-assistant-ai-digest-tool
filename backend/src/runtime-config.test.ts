import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './runtime-config.js';

describe('runtime configuration', () => {
  it('defaults to safe local mode', () => {
    expect(loadRuntimeConfig(tokens())).toMatchObject({
      mode: 'local',
      bindAddress: '127.0.0.1',
      trustProxy: false,
      secureCookies: false,
      port: 3000
    });
  });

  it.each([
    ['TRUST_PROXY', 'yes'],
    ['SECURE_COOKIES', '1']
  ])('rejects malformed boolean %s values', (name, value) => {
    expect(() => loadRuntimeConfig(tokens({ [name]: value }))).toThrow(/must be "true" or "false"/i);
  });

  it('rejects an unknown runtime mode', () => {
    expect(() => loadRuntimeConfig(tokens({ RUNTIME_MODE: 'public' }))).toThrow(/RUNTIME_MODE must be "local" or "reverse-proxy"/);
  });

  it('rejects non-loopback local publication', () => {
    expect(() => loadRuntimeConfig(tokens({ APP_BIND_ADDRESS: '0.0.0.0' }))).toThrow(/local mode must bind to a loopback host/i);
  });

  it.each([
    [{ RUNTIME_MODE: 'reverse-proxy', TRUST_PROXY: 'false', SECURE_COOKIES: 'true' }],
    [{ RUNTIME_MODE: 'reverse-proxy', TRUST_PROXY: 'true', SECURE_COOKIES: 'false' }]
  ])('requires trusted proxy and secure cookies in reverse-proxy mode', (environment) => {
    expect(() => loadRuntimeConfig(tokens(environment))).toThrow(/reverse-proxy mode requires TRUST_PROXY=true and SECURE_COOKIES=true/i);
  });

  it('loads positive bounded live Home Assistant reader limits', () => {
    expect(loadRuntimeConfig(tokens({ HA_LOGS_DIR: '/ha-logs', HA_MAX_STATES: '12', HA_MAX_LOG_LINES: '8', HA_MAX_RESPONSE_BYTES: '4096', HA_ANALYSIS_TIMEOUT_MS: '15000' }))).toMatchObject({
      haLogsDir: '/ha-logs', haMaxStates: 12, haMaxLogLines: 8, haMaxResponseBytes: 4096, haAnalysisTimeoutMs: 15000
    });
    expect(() => loadRuntimeConfig(tokens({ HA_MAX_STATES: '0' }))).toThrow(/HA_MAX_STATES must be a positive integer/);
  });
});

function tokens(environment: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_TOKEN: 'admin-token',
    SETUP_TOKEN: 'setup-token',
    ...environment
  };
}
