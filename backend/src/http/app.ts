import crypto from 'node:crypto';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  DigestWindowSchema, IgnoreRuleCreateSchema, NoteCreateSchema, NotifierTestRequestSchema, RedactedSettingsDtoSchema,
  RunDigestRequestSchema, SendDigestRequestSchema, SetupValidationRequestSchema,
  type DeliveryResult, type DigestHistoryResponse, type IgnoreRuleCreate, type IgnoreRuleDto, type MaskedSettings,
  type NoteDto, type NotifierTestRequest, type RedactedSettingsDto, type RunDigestRequest, type RunDigestResponse,
  type SendDigestRequest, type SetupValidationRequest, type TestResult
} from '@ha-digest/shared';
import type { DigestJobStore } from '../domain/jobs.js';
import type { IgnoreRuleStore, NoteStore, ReportStore } from '../domain/stores.js';

export type BackendApiServices = {
  setup: { complete(input: SetupValidationRequest): Promise<MaskedSettings> };
  settings: { get(): Promise<RedactedSettingsDto>; update(input: RedactedSettingsDto): Promise<RedactedSettingsDto> };
  digestJobs: Pick<DigestJobStore, 'enqueue'>;
  reports: Pick<ReportStore, 'list'>;
  notes: Pick<NoteStore, 'add' | 'listWindow'>;
  ignores: Pick<IgnoreRuleStore, 'add' | 'remove' | 'listActive'>;
  notifiers: {
    test(input: NotifierTestRequest): Promise<TestResult>;
    send(input: SendDigestRequest): Promise<DeliveryResult>;
  };
};

export type BackendAuthOptions = {
  adminToken: string;
  /** Bootstrap bearer token for first-run setup. Production runtime config must rotate or disable it after setup is complete. */
  setupToken: string;
  sessionTtlMs: number;
  /** Set true when serving over HTTPS or behind a TLS-terminating proxy that preserves Secure cookies. */
  secureCookies?: boolean;
};

export type OperationalFailureEvent = {
  requestId: string;
  method: string;
  url: string;
  statusCode: number;
  code: 'INTERNAL_ERROR';
  errorName: string;
};

export type CreateAppOptions = {
  services: BackendApiServices;
  auth: BackendAuthOptions;
  now?: () => string;
  /** Receives secret-safe operational failure events for production logging/metrics. Do not include raw error messages here. */
  failureReporter?: (event: OperationalFailureEvent) => void;
  /** Allows preview/static routes to stay public without weakening API protection. */
  publicRequest?: (request: FastifyRequest) => boolean;
};

type Session = { id: string; csrfToken: string; expiresAtMs: number };

const SESSION_COOKIE = 'ha_digest_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = fastify({ logger: false });
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => new Date().toISOString());
  const currentTimeMs = () => Date.parse(now());

  app.setErrorHandler((error, request, reply) => {
    request.log.debug({ err: error }, 'request failed');
    reportFailure(options.failureReporter, {
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      errorName: getErrorName(error)
    });
    return sendError(reply, 500, 'INTERNAL_ERROR', 'Request failed. Check server logs with redaction enabled.', request.id);
  });

  app.post('/api/session', async (request, reply) => {
    const body = asRecord(request.body);
    if (!safeEqual(String(body.adminToken ?? ''), options.auth.adminToken)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Invalid admin token.', request.id);
    return startSession(reply, options.auth, sessions, currentTimeMs(), request.id);
  });

  app.delete('/api/session', async (request, reply) => {
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    reply.header('set-cookie', expiredSessionCookie(options.auth));
    return reply.code(204).send();
  });

  app.post('/api/setup', async (request, reply) => {
    if (!hasSetupBearer(request, options.auth.setupToken)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Setup token is required.', request.id);
    const input = parseRequest(SetupValidationRequestSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;

    const settings = await options.services.setup.complete(input.value);
    const session = createSession(options.auth, sessions, currentTimeMs());
    reply.header('set-cookie', sessionCookie(session, options.auth));
    return reply.send({ settings, csrfToken: session.csrfToken });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isPublicRoute(request) || options.publicRequest?.(request)) return;

    const session = authenticate(request, options.auth, sessions, currentTimeMs());
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Authenticated session required.', request.id);
    if (MUTATING_METHODS.has(request.method) && request.headers['x-csrf-token'] !== session.csrfToken) {
      return sendError(reply, 403, 'CSRF_REQUIRED', 'CSRF token required for this request.', request.id);
    }
  });

  app.get('/api/settings', async () => options.services.settings.get());
  app.put('/api/settings', async (request, reply) => {
    const input = parseRequest(RedactedSettingsDtoSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    return options.services.settings.update(input.value);
  });

  app.post('/api/digests/run', async (request, reply): Promise<RunDigestResponse | FastifyReply> => {
    const input = parseRequest(RunDigestRequestSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    const triggerWindowId = buildTriggerWindowId(input.value, now());
    return options.services.digestJobs.enqueue({ kind: input.value.kind, triggerWindowId });
  });
  app.get('/api/digests/history', async (): Promise<DigestHistoryResponse> => options.services.reports.list());

  app.post('/api/notes', async (request, reply): Promise<NoteDto | FastifyReply> => {
    const input = parseRequest(NoteCreateSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    const note = await options.services.notes.add(input.value);
    return reply.code(201).send(note);
  });
  app.get('/api/notes', async (request, reply): Promise<NoteDto[] | FastifyReply> => {
    const window = parseRequest(DigestWindowSchema, request.query, reply, request.id);
    if (!window.ok) return window.response;
    return options.services.notes.listWindow(window.value);
  });

  app.get('/api/ignores', async (): Promise<IgnoreRuleDto[]> => options.services.ignores.listActive(now()));
  app.post('/api/ignores', async (request, reply): Promise<IgnoreRuleDto | FastifyReply> => {
    const input = parseRequest(IgnoreRuleCreateSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    const rule = await options.services.ignores.add(input.value as IgnoreRuleCreate);
    return reply.code(201).send(rule);
  });
  app.delete('/api/ignores/:id', async (request, reply) => {
    await options.services.ignores.remove(String((request.params as { id: string }).id));
    return reply.code(204).send();
  });

  app.post('/api/notifiers/test', async (request, reply): Promise<TestResult | FastifyReply> => {
    const input = parseRequest(NotifierTestRequestSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    return options.services.notifiers.test(input.value);
  });
  app.post('/api/notifiers/send', async (request, reply): Promise<DeliveryResult | FastifyReply> => {
    const input = parseRequest(SendDigestRequestSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    return options.services.notifiers.send(input.value);
  });

  return app;
}

function parseRequest<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): { fieldErrors: Record<string, string[]> } } } }, value: unknown, reply: FastifyReply, requestId: string) {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true as const, value: result.data };
  return {
    ok: false as const,
    response: sendError(reply, 400, 'VALIDATION_FAILED', 'Request validation failed.', requestId, result.error.flatten().fieldErrors)
  };
}

function startSession(reply: FastifyReply, auth: BackendAuthOptions, sessions: Map<string, Session>, currentTimeMs: number, requestId: string) {
  const session = createSession(auth, sessions, currentTimeMs);
  reply.header('set-cookie', sessionCookie(session, auth));
  return reply.send({ csrfToken: session.csrfToken });
}

function createSession(auth: BackendAuthOptions, sessions: Map<string, Session>, currentTimeMs: number): Session {
  const session = { id: token(), csrfToken: token(), expiresAtMs: currentTimeMs + auth.sessionTtlMs };
  sessions.set(session.id, session);
  return session;
}

function authenticate(request: FastifyRequest, auth: BackendAuthOptions, sessions: Map<string, Session>, currentTimeMs: number): Session | null {
  const sessionId = readCookie(request, SESSION_COOKIE);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) return null;
  if (session.expiresAtMs <= currentTimeMs) {
    sessions.delete(session.id);
    return null;
  }
  return session;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, requestId: string, fieldErrors?: Record<string, string[]>) {
  return reply.code(status).send({ code, message, requestId, ...(fieldErrors ? { fieldErrors } : {}) });
}

function buildTriggerWindowId(request: RunDigestRequest, fallback: string): string {
  if (request.window) return `${request.kind}:${request.window.from}:${request.window.to}`;
  return `${request.kind}:${fallback}`;
}

function isPublicRoute(request: FastifyRequest): boolean {
  return (request.method === 'POST' && request.url === '/api/session') || (request.method === 'POST' && request.url === '/api/setup');
}

function reportFailure(reporter: CreateAppOptions['failureReporter'], event: OperationalFailureEvent): void {
  try {
    reporter?.(event);
  } catch {
    // Never let telemetry/reporting failures change the HTTP response path.
  }
}

function getErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function hasSetupBearer(request: FastifyRequest, setupToken: string): boolean {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') && safeEqual(header.slice('Bearer '.length), setupToken);
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name && value) return decodeURIComponent(value);
  }
  return null;
}

function sessionCookie(session: Session, auth: BackendAuthOptions): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(auth.sessionTtlMs / 1000)}${auth.secureCookies ? '; Secure' : ''}`;
}

function expiredSessionCookie(auth: BackendAuthOptions): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${auth.secureCookies ? '; Secure' : ''}`;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function token(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
