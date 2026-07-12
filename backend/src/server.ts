import { resolve } from 'node:path';
import { createPersistentRuntimePreviewApp } from './runtime-preview.js';

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';
const adminToken = requireEnv('ADMIN_TOKEN');
const setupToken = requireEnv('SETUP_TOKEN');
const frontendDistDir = resolve(process.env.FRONTEND_DIST_DIR ?? './frontend-dist');
const dataDir = resolve(process.env.DATA_DIR ?? '/data');

const app = await createPersistentRuntimePreviewApp({
  frontendDistDir,
  dataDir,
  adminToken,
  setupToken,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  failureReporter: (event) => console.error(JSON.stringify({ level: 'error', event: 'runtime_api_failure', ...event }))
});

app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the runtime preview.`);
  return value;
}
