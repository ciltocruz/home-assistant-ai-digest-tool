import { open, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BackendApiServices, BackendAuthOptions, CreateAppOptions } from './http/app.js';
import { createApp } from './http/app.js';
import { createPersistentRuntimeServices } from './runtime-persistence.js';
import type { RuntimeDigestFailureEvent } from './runtime-logging.js';
import type { SetupValidationRequest } from '@ha-digest/shared';

export type RuntimePreviewOptions = {
  frontendDistDir: string;
  haLogsDir?: string;
  sessionTtlMs?: number;
  secureCookies?: boolean;
  trustProxy?: boolean;
  now?: () => string;
  failureReporter?: CreateAppOptions['failureReporter'];
  digestFailureReporter?: (event: RuntimeDigestFailureEvent) => void;
};

type RuntimeCheck = { status: 'ready' } | { status: 'degraded'; reason: string };

export type PersistentRuntimePreviewOptions = RuntimePreviewOptions & {
  dataDir?: string;
  haMaxStates?: number;
  haMaxLogLines?: number;
  haMaxResponseBytes?: number;
  haAnalysisTimeoutMs?: number;
};

export async function createPersistentRuntimePreviewApp(options: PersistentRuntimePreviewOptions): Promise<FastifyInstance> {
  return createRuntimePreviewApp({
    ...options,
    services: await createPersistentRuntimeServices({ dataDir: options.dataDir, now: options.now, haLogPath: options.haLogsDir ? join(options.haLogsDir, 'home-assistant.log') : undefined, haMaxStates: options.haMaxStates, haMaxLogLines: options.haMaxLogLines, haMaxResponseBytes: options.haMaxResponseBytes, haAnalysisTimeoutMs: options.haAnalysisTimeoutMs, digestFailureReporter: options.digestFailureReporter })
  });
}

type RuntimePreviewAppOptions = RuntimePreviewOptions & {
  services?: BackendApiServices;
};

export function createRuntimePreviewApp(options: RuntimePreviewAppOptions): FastifyInstance {
  const services = options.services ?? createPreviewServices(options.now);
  const app = createApp({
    services,
    auth: createPreviewAuth(options),
    trustProxy: options.trustProxy,
    now: options.now,
    failureReporter: options.failureReporter,
    publicRequest: (request) => isRuntimePublicRequest(request.url)
  });
  const frontendRoot = resolve(options.frontendDistDir);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const index = await readExistingFile(join(frontendRoot, 'index.html'));
    if (!index) return reply.code(503).send({ status: 'not_ready', reason: 'frontend_index_unavailable' });
    const haLogs = options.haLogsDir
      ? await checkHaLogsMount(options.haLogsDir)
      : { status: 'degraded' as const, reason: 'ha_logs_mount_unconfigured' };
    if (haLogs.status === 'degraded') return reply.code(503).send({ status: 'not_ready', reason: haLogs.reason });
    const persistence = await options.services?.health?.check();
    if (persistence && !persistence.ok) return reply.code(503).send({ status: 'not_ready', reason: persistence.reason });
    return { status: 'ready', checks: { haLogs } };
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id });
    }

    return serveFrontend(request, reply, frontendRoot);
  });

  if (services.close) app.addHook('onClose', async () => services.close?.());

  return app;
}

function isRuntimePublicRequest(url: string): boolean {
  return !url.startsWith('/api/') || url === '/health' || url === '/ready';
}

function createPreviewAuth(options: RuntimePreviewOptions): BackendAuthOptions {
  return {
    sessionTtlMs: options.sessionTtlMs ?? 8 * 60 * 60 * 1000,
    secureCookies: options.secureCookies
  };
}

function createPreviewServices(now = () => new Date().toISOString()): BackendApiServices {
  return {
    setup: {
      async complete(input) {
        const setup = input as SetupValidationRequest;
        return {
          haUrl: setup.haUrl,
          ai: { provider: setup.aiProvider, keyMask: 'configured', ref: 'preview:ai' },
          notifiers: setup.telegram
            ? [{ id: 'preview-telegram', channel: 'telegram', targetRef: 'preview:telegram', label: 'Telegram preview', secretMask: 'configured' }]
            : []
        };
      }
    },
    settings: {
      async get() {
        return {
          homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: 'configured' } },
          ai: { provider: 'gemini' as const, key: { configured: true, mask: 'configured' } },
          notifications: { channel: 'none' as const },
          schedules: [],
          privacyLevel: 'balanced' as const,
          retentionDays: 30
        };
      },
      async update() {
        return this.get();
      }
    },
    digestJobs: {
      async enqueue(input) {
        return { status: 'queued', jobId: `preview:${input.triggerWindowId}` };
      },
      async get() { return null; },
      async retryFailed() { return null; }
    },
    reports: { async list() { return []; }, async get() { return null; }, async remove() { return false; } },
    notes: {
      async add(input) { return { id: 'preview-note', ...input, createdAt: now() }; },
      async listWindow() { return []; }
    },
    ignores: {
      async add(input) { return { id: 'preview-ignore', match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: now() }; },
      async remove() {},
      async listActive() { return []; }
    },
    notifiers: {
      async test() { return { status: 'failed', message: 'Preview runtime does not send live notifications yet.', checkedAt: now() }; },
      async send(input) { return { status: 'skipped', targetRef: input.targetRef, message: 'Preview runtime does not send live notifications yet.' }; }
    }
  };
}

async function serveFrontend(request: FastifyRequest, reply: FastifyReply, frontendRoot: string): Promise<FastifyReply> {
  const pathname = new URL(request.url, 'http://preview.local').pathname;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = safeJoin(frontendRoot, requested);
  if (!filePath) return reply.code(404).send('Not found');

  const file = await readExistingFile(filePath);
  if (file) return sendFile(reply, filePath, file);
  if (extname(pathname)) return reply.code(404).send('Not found');

  const index = await readExistingFile(join(frontendRoot, 'index.html'));
  if (!index) return reply.code(404).send('Frontend build not found. Run `pnpm -C frontend build` first.');
  return sendFile(reply, join(frontendRoot, 'index.html'), index);
}

function safeJoin(root: string, requested: string): string | null {
  const filePath = resolve(root, requested);
  const rel = relative(root, filePath);
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) return null;
  return filePath;
}

async function readExistingFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    return readFile(filePath);
  } catch {
    return null;
  }
}

async function checkHaLogsMount(path: string): Promise<RuntimeCheck> {
  try {
    const info = await stat(path);
    if (info.isFile()) return await canOpenForRead(path) ? { status: 'ready' } : { status: 'degraded', reason: 'ha_logs_mount_unreadable' };
    if (!info.isDirectory()) return { status: 'degraded', reason: 'ha_logs_mount_unavailable' };
  } catch {
    return { status: 'degraded', reason: 'ha_logs_mount_unavailable' };
  }

  try {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length === 0) return { status: 'degraded', reason: 'ha_logs_mount_empty' };
    const logFiles = entries.filter((entry) => entry.isFile());
    if (logFiles.length === 0) return { status: 'degraded', reason: 'ha_logs_mount_unavailable' };
    for (const entry of logFiles) {
      if (await canOpenForRead(join(path, entry.name))) return { status: 'ready' };
    }
    return { status: 'degraded', reason: 'ha_logs_mount_unreadable' };
  } catch {
    return { status: 'degraded', reason: 'ha_logs_mount_unreadable' };
  }
}

async function canOpenForRead(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

function sendFile(reply: FastifyReply, filePath: string, file: Buffer): FastifyReply {
  const type = contentType(filePath);
  return reply.type(type).send(file);
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}
