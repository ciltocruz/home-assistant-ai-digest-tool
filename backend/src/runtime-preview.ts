import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BackendApiServices, BackendAuthOptions } from './http/app.js';
import { createApp } from './http/app.js';

export type RuntimePreviewOptions = {
  frontendDistDir: string;
  adminToken: string;
  setupToken: string;
  sessionTtlMs?: number;
  secureCookies?: boolean;
  now?: () => string;
};

export function createRuntimePreviewApp(options: RuntimePreviewOptions): FastifyInstance {
  const app = createApp({
    services: createPreviewServices(options.now),
    auth: createPreviewAuth(options),
    now: options.now,
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
    return { status: 'ready' };
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id });
    }

    return serveFrontend(request, reply, frontendRoot, options.setupToken);
  });

  return app;
}

function isRuntimePublicRequest(url: string): boolean {
  return !url.startsWith('/api/') || url === '/health' || url === '/ready';
}

function createPreviewAuth(options: RuntimePreviewOptions): BackendAuthOptions {
  return {
    adminToken: options.adminToken,
    setupToken: options.setupToken,
    sessionTtlMs: options.sessionTtlMs ?? 8 * 60 * 60 * 1000,
    secureCookies: options.secureCookies
  };
}

function createPreviewServices(now = () => new Date().toISOString()): BackendApiServices {
  return {
    setup: {
      async complete(input) {
        return {
          haUrl: input.haUrl,
          ai: { provider: input.aiProvider, keyMask: 'configured', ref: 'preview:ai' },
          notifiers: input.telegram
            ? [{ id: 'preview-telegram', channel: 'telegram', targetRef: 'preview:telegram', label: 'Telegram preview', secretMask: 'configured' }]
            : []
        };
      }
    },
    settings: {
      async get() {
        return {
          haUrl: 'http://homeassistant.local:8123',
          aiProvider: 'gemini',
          secretRefs: { haTokenRef: 'preview:ha', aiKeyRef: 'preview:ai', notifierRefs: {} },
          schedules: [],
          privacyLevel: 'balanced',
          retentionDays: 30
        };
      },
      async update(input) {
        return input;
      }
    },
    digestJobs: {
      async enqueue(input) {
        return { status: 'queued', jobId: `preview:${input.triggerWindowId}` };
      }
    },
    reports: { async list() { return []; } },
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

async function serveFrontend(request: FastifyRequest, reply: FastifyReply, frontendRoot: string, setupToken: string): Promise<FastifyReply> {
  const pathname = new URL(request.url, 'http://preview.local').pathname;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = safeJoin(frontendRoot, requested);
  if (!filePath) return reply.code(404).send('Not found');

  const file = await readExistingFile(filePath);
  if (file) return sendFile(reply, filePath, file, setupToken);
  if (extname(pathname)) return reply.code(404).send('Not found');

  const index = await readExistingFile(join(frontendRoot, 'index.html'));
  if (!index) return reply.code(404).send('Frontend build not found. Run `pnpm -C frontend build` first.');
  return sendFile(reply, join(frontendRoot, 'index.html'), index, setupToken);
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

function sendFile(reply: FastifyReply, filePath: string, file: Buffer, setupToken: string): FastifyReply {
  const type = contentType(filePath);
  if (type.startsWith('text/html')) return reply.type(type).send(injectBootstrap(file.toString('utf8'), setupToken));
  return reply.type(type).send(file);
}

function injectBootstrap(html: string, setupToken: string): string {
  const script = `<script>window.__HA_DIGEST_BOOTSTRAP__=${safeJson({ setupToken })};</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${script}</head>`);
  if (html.includes('<body')) return html.replace(/<body([^>]*)>/i, `<body$1>${script}`);
  return `${script}${html}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
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
