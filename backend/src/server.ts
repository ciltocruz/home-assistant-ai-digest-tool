import { resolve } from 'node:path';
import { createRuntimePreviewApp } from './runtime-preview.js';

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '0.0.0.0';
const adminToken = requireEnv('ADMIN_TOKEN');
const setupToken = requireEnv('SETUP_TOKEN');
const frontendDistDir = resolve(process.env.FRONTEND_DIST_DIR ?? './frontend-dist');

const app = createRuntimePreviewApp({
  frontendDistDir,
  adminToken,
  setupToken,
  secureCookies: process.env.SECURE_COOKIES === 'true'
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
