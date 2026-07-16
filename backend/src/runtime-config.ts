import { resolve } from 'node:path';

export type RuntimeMode = 'local' | 'reverse-proxy';

export type RuntimeConfig = {
  mode: RuntimeMode;
  bindAddress: string;
  host: string;
  port: number;
  trustProxy: boolean;
  secureCookies: boolean;
  adminToken: string;
  setupToken: string;
  frontendDistDir: string;
  dataDir: string;
  logDir: string;
  haLogsDir?: string;
};

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const mode = parseRuntimeMode(environment.RUNTIME_MODE);
  const bindAddress = environment.APP_BIND_ADDRESS ?? '127.0.0.1';
  const trustProxy = parseBoolean('TRUST_PROXY', environment.TRUST_PROXY, false);
  const secureCookies = parseBoolean('SECURE_COOKIES', environment.SECURE_COOKIES, false);

  if (mode === 'local' && !isLoopbackAddress(bindAddress)) {
    throw new Error('Local mode must bind to a loopback host.');
  }
  if (mode === 'reverse-proxy' && (!trustProxy || !secureCookies)) {
    throw new Error('Reverse-proxy mode requires TRUST_PROXY=true and SECURE_COOKIES=true.');
  }

  const dataDir = resolve(environment.DATA_DIR ?? '/data');
  return {
    mode,
    bindAddress,
    host: environment.HOST ?? '0.0.0.0',
    port: parsePort(environment.PORT),
    trustProxy,
    secureCookies,
    adminToken: requireEnvironmentValue(environment, 'ADMIN_TOKEN'),
    setupToken: requireEnvironmentValue(environment, 'SETUP_TOKEN'),
    frontendDistDir: resolve(environment.FRONTEND_DIST_DIR ?? './frontend-dist'),
    dataDir,
    logDir: resolve(environment.LOG_DIR ?? `${dataDir}/logs`),
    haLogsDir: environment.HA_LOGS_DIR ? resolve(environment.HA_LOGS_DIR) : undefined
  };
}

function parseRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value === 'local') return 'local';
  if (value === 'reverse-proxy') return 'reverse-proxy';
  throw new Error('RUNTIME_MODE must be "local" or "reverse-proxy".');
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false".`);
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}

function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for the runtime preview.`);
  return value;
}
