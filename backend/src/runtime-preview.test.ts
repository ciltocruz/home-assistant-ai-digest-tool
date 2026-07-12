import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntimePreviewApp } from './runtime-preview.js';

describe('runtime preview app', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves built frontend assets while keeping API routes available', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token' });

    const index = await app.inject({ method: 'GET', url: '/' });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    const api = await app.inject({ method: 'GET', url: '/api/digests/history' });

    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('<div id="root"></div>');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.body).toBe('window.__preview = true;');
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('serves unauthenticated health endpoints for container readiness checks', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token' });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    expect(ready.json()).toMatchObject({ status: 'ready' });
  });

  it('reports not ready when the frontend index is missing', async () => {
    const frontendDistDir = await mkdtemp(join(tmpdir(), 'ha-digest-preview-empty-'));
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token' });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'frontend_index_unavailable' });
  });

  it('adds conservative security headers to runtime preview responses', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token' });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('injects the setup token into served HTML without modifying static assets', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token-with-</script>-chars' });

    const index = await app.inject({ method: 'GET', url: '/' });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('window.__HA_DIGEST_BOOTSTRAP__');
    expect(index.body).toContain('setup-token-with-');
    expect(index.body).not.toContain('</script>-chars');
    expect(asset.body).toBe('window.__preview = true;');
  });

  it('blocks path traversal outside the built frontend directory', async () => {
    const frontendDistDir = await createFrontendDist();
    await writeFile(join(frontendDistDir, '..', 'secret.txt'), 'do-not-serve');
    app = createRuntimePreviewApp({ frontendDistDir, adminToken: 'admin-token', setupToken: 'setup-token' });

    const response = await app.inject({ method: 'GET', url: '/assets/%2e%2e/secret.txt' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('do-not-serve');
  });
});

async function createFrontendDist(): Promise<string> {
  const frontendDistDir = await mkdtemp(join(tmpdir(), 'ha-digest-preview-'));
  await writeFile(join(frontendDistDir, 'index.html'), '<html><body><div id="root"></div></body></html>');
  await mkdir(join(frontendDistDir, 'assets'), { recursive: true });
  await writeFile(join(frontendDistDir, 'assets', 'app.js'), 'window.__preview = true;');
  return frontendDistDir;
}
