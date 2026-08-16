import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackendApiServices, OperationalFailureEvent } from './http/app.js';
import { createPersistentRuntimePreviewApp, createReportUrl, createRuntimePreviewApp } from './runtime-preview.js';

describe('runtime preview app', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('builds encoded report links from the configured public origin and committed report ID', () => {
    const reportUrl = createReportUrl('https://digest.example');

    expect(reportUrl?.('v2-report:committed/id')).toBe('https://digest.example/reports/v2-report%3Acommitted%2Fid');
    expect(createReportUrl(undefined)).toBeUndefined();
  });

  it('serves built frontend assets while keeping API routes available', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir });

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

  it('keeps liveness available while rejecting unconfigured Home Assistant logs from readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir });

    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(health.json()).toMatchObject({ status: 'ok' });
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_unconfigured' });
  });

  it('reports not ready when the frontend index is missing', async () => {
    const frontendDistDir = await mkdtemp(join(tmpdir(), 'ha-digest-preview-empty-'));
    app = createRuntimePreviewApp({ frontendDistDir });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'frontend_index_unavailable' });
  });

  it('adds conservative security headers to runtime preview responses', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('serves static HTML without injecting account credentials or modifying assets', async () => {
    const frontendDistDir = await createFrontendDist();
    app = createRuntimePreviewApp({ frontendDistDir });

    const index = await app.inject({ method: 'GET', url: '/' });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(index.statusCode).toBe(200);
    expect(index.body).not.toContain('credential');
    expect(asset.body).toBe('window.__preview = true;');
  });

  it('blocks path traversal outside the built frontend directory', async () => {
    const frontendDistDir = await createFrontendDist();
    await writeFile(join(frontendDistDir, '..', 'secret.txt'), 'do-not-serve');
    app = createRuntimePreviewApp({ frontendDistDir });

    const response = await app.inject({ method: 'GET', url: '/assets/%2e%2e/secret.txt' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('do-not-serve');
  });

  it('persists an account-backed session flow against persistent /data services', async () => {
    const frontendDistDir = await createFrontendDist();
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-preview-data-'));
    app = await createPersistentRuntimePreviewApp({
      frontendDistDir,
      dataDir, now: () => '2026-07-12T10:00:00.000Z'
    });

    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'persistent-runtime-password', language: 'en' } });
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: registered.headers['set-cookie'] } });
    await app.close();

    app = await createPersistentRuntimePreviewApp({
      frontendDistDir,
      dataDir, now: () => '2026-07-12T10:00:00.000Z'
    });
    const login = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'persistent-runtime-password' } });
    const reopenedCookie = login.headers['set-cookie'] as string;
    const reopenedSettings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: reopenedCookie } });

    expect(registered.statusCode).toBe(200);
    expect(settings.statusCode).toBe(200);
    expect(reopenedSettings.json()).toMatchObject({ ai: { provider: 'gemini' }, privacyLevel: 'balanced' });
  });

  it('keeps persistent runtime APIs unavailable until an account session exists', async () => {
    const frontendDistDir = await createFrontendDist();
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-account-'));
    app = await createPersistentRuntimePreviewApp({
      frontendDistDir, dataDir
    });

    const index = await app.inject({ method: 'GET', url: '/' });

    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<div id="root"></div>');

    const protectedApi = await app.inject({ method: 'GET', url: '/api/digests/history' });
    expect(protectedApi.statusCode).toBe(401);
    expect(protectedApi.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('reports not ready when persistence health fails', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await createReadableHaLogs();
    const services = {
      ...createRuntimePreviewServices(),
      health: { check: async () => ({ ok: false, reason: 'persistence_unavailable' }) }
    };
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir, services });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'persistence_unavailable' });
  });

  it('checks the configured Home Assistant logs mount during readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-ha-logs-'));
    await writeFile(join(haLogsDir, 'home-assistant.log'), '2026-07-15 safe log line');
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { haLogs: { status: 'ready' } } });
  });

  it('accepts a readable Home Assistant log file mount during readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-ha-log-file-'));
    const haLogFile = join(haLogsDir, 'home-assistant.log');
    await writeFile(haLogFile, '2026-07-15 safe log line');
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir: haLogFile });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { haLogs: { status: 'ready' } } });
  });

  it('rejects a missing configured Home Assistant logs mount from readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    const missingHaLogsDir = join(await mkdtemp(join(tmpdir(), 'ha-digest-missing-parent-')), 'not-created');
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir: missingHaLogsDir });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_unavailable' });
  });

  it('rejects an empty configured Home Assistant logs mount from readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-empty-ha-logs-'));
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_empty' });
  });

  it('rejects an unreadable configured Home Assistant logs mount from readiness', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-unreadable-ha-logs-'));
    try {
      await chmod(haLogsDir, 0o000);
      app = createRuntimePreviewApp({ frontendDistDir, haLogsDir });

      const ready = await app.inject({ method: 'GET', url: '/ready' });

      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_unreadable' });
    } finally {
      await chmod(haLogsDir, 0o700);
    }
  });

  it('rejects a directory that contains only metadata instead of a readable Home Assistant log', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-metadata-only-ha-logs-'));
    await mkdir(join(haLogsDir, 'metadata'));
    app = createRuntimePreviewApp({ frontendDistDir, haLogsDir });

    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_unavailable' });
  });

  it('rejects a directory with a non-readable Home Assistant log file', async () => {
    const frontendDistDir = await createFrontendDist();
    const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-unreadable-ha-log-file-'));
    const logFile = join(haLogsDir, 'home-assistant.log');
    await writeFile(logFile, '2026-07-15 safe log line');
    try {
      await chmod(logFile, 0o000);
      app = createRuntimePreviewApp({ frontendDistDir, haLogsDir });

      const ready = await app.inject({ method: 'GET', url: '/ready' });

      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ status: 'not_ready', reason: 'ha_logs_mount_unreadable' });
    } finally {
      await chmod(logFile, 0o600);
    }
  });

  it('closes runtime services when the app closes', async () => {
    const frontendDistDir = await createFrontendDist();
    const close = vi.fn();
    const services = { ...createRuntimePreviewServices(), close };
    app = createRuntimePreviewApp({ frontendDistDir, services });

    await app.close();
    app = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it('passes API failures from runtime preview services to the failure reporter', async () => {
    const frontendDistDir = await createFrontendDist();
    const events: OperationalFailureEvent[] = [];
    const services = createRuntimePreviewServices();
    services.settings.get = async () => { throw new Error('settings store unavailable'); };
    app = createRuntimePreviewApp({
      frontendDistDir, services,
      failureReporter: (event) => events.push(event)
    });
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'runtime-test-password', language: 'en' } });
    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: registered.headers['set-cookie'] } });

    expect(response.statusCode).toBe(500);
    expect(events).toEqual([expect.objectContaining({ method: 'GET', url: '/api/settings', code: 'INTERNAL_ERROR' })]);
  });
});

function createRuntimePreviewServices(): BackendApiServices {
  let password = ''; const sessions = new Map<string, { csrfToken: string; expiresAtMs: number }>();
  return {
    auth: {
      hasAdmin: async () => Boolean(password), createAdmin: async (value) => { if (password) return false; password = value; return true; }, verifyPassword: async (value) => value === password,
      changePassword: async (current, next) => { if (current !== password) return false; password = next; sessions.clear(); return true; }, createSession: async (ttl) => { const id = `runtime-session-${sessions.size}`; const csrfToken = `runtime-csrf-${sessions.size}`; const expiresAtMs = Date.now() + ttl; sessions.set(id, { csrfToken, expiresAtMs }); return { id, csrfToken, expiresAtMs }; },
      readSession: async (id, csrf) => { const session = sessions.get(id); return session && session.expiresAtMs > Date.now() && (!csrf || csrf === session.csrfToken) ? { id, ...session } : null; }, removeSession: async (id) => { sessions.delete(id); }, issueCsrf: async () => null,
      loginAllowed: async () => true, recordFailedLogin: async () => undefined, clearFailedLogins: async () => undefined, language: async () => 'en'
    },
    setup: { async complete(input) { return { haUrl: input.haUrl, ai: { provider: input.aiProvider, keyMask: 'configured', ref: 'preview:ai' }, notifiers: [] }; } },
    settings: { async get() { return { homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: 'configured' } }, ai: { provider: 'gemini' as const, key: { configured: true, mask: 'configured' } }, notifications: { channel: 'none' as const }, schedules: [], privacyLevel: 'balanced' as const, retentionDays: 30 }; }, async update() { return this.get(); } },
    digestJobs: { async enqueue(input) { return { status: 'queued', jobId: `preview:${input.triggerWindowId}` }; }, async get() { return null; }, async retryFailed() { return null; } },
    reports: { async list() { return []; }, async get() { return null; }, async remove() { return false; }, async removeBatch() { return 0; } },
    notes: { async add(input) { return { id: 'preview-note', ...input, createdAt: '2026-07-12T10:00:00.000Z' }; }, async listWindow() { return []; } },
    ignores: { async add(input) { return { id: 'preview-ignore', match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: '2026-07-12T10:00:00.000Z' }; }, async remove() {}, async listActive() { return []; } },
    notifiers: { async test() { return { status: 'failed', message: 'Preview runtime does not send live notifications yet.', checkedAt: '2026-07-12T10:00:00.000Z' }; }, async send(input) { return { status: 'skipped', targetRef: input.targetRef, message: 'Preview runtime does not send live notifications yet.' }; } }
  };
}

async function createFrontendDist(): Promise<string> {
  const frontendDistDir = await mkdtemp(join(tmpdir(), 'ha-digest-preview-'));
  await writeFile(join(frontendDistDir, 'index.html'), '<html><body><div id="root"></div></body></html>');
  await mkdir(join(frontendDistDir, 'assets'), { recursive: true });
  await writeFile(join(frontendDistDir, 'assets', 'app.js'), 'window.__preview = true;');
  return frontendDistDir;
}

async function createReadableHaLogs(): Promise<string> {
  const haLogsDir = await mkdtemp(join(tmpdir(), 'ha-digest-readable-ha-logs-'));
  await writeFile(join(haLogsDir, 'home-assistant.log'), '2026-07-15 safe log line');
  return haLogsDir;
}
