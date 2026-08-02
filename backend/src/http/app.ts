import crypto from 'node:crypto';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  DigestWindowSchema, EditableSettingsDtoSchema, IgnoreRuleCreateSchema, NoteCreateSchema, NotifierTestRequestSchema, OnboardingProgressSchema, OnboardingStepCommandSchema, SettingsUpdateCommandSchema,
  RunDigestRequestSchema, SendDigestRequestSchema, SetupValidationRequestSchema,
  type DeliveryResult, type DigestDetail, type DigestHistoryResponse, type IgnoreRuleCreate, type IgnoreRuleDto, type MaskedSettings,
  type DigestJobStatus, type EditableSettingsDto, type NoteDto, type NotifierTestRequest, type OnboardingProgress, type OnboardingStepCommand, type RunDigestRequest, type RunDigestResponse, type SettingsUpdateCommand,
  type SendDigestRequest, type SetupValidationRequest, type TestResult
} from '@ha-digest/shared';
import type { DigestJobStore } from '../domain/jobs.js';
import type { IgnoreRuleStore, NoteStore, ReportStore } from '../domain/stores.js';
import { projectReportPresentation } from '../application/report-presentation.js';

export type BackendApiServices = {
  health?: { check(): Promise<{ ok: true } | { ok: false; reason: string }> };
  close?: () => void | Promise<void>;
  setup: { complete(input: SetupValidationRequest): Promise<MaskedSettings> };
  onboarding?: { get(): Promise<OnboardingProgress>; save(input: OnboardingStepCommand): Promise<OnboardingProgress>; complete?(): Promise<MaskedSettings> };
  settings: { get(): Promise<EditableSettingsDto>; update(input: SettingsUpdateCommand): Promise<EditableSettingsDto>; notificationTarget?(channel: 'telegram'): Promise<string> };
  digestJobs: Pick<DigestJobStore, 'enqueue' | 'get' | 'retryFailed'>;
  digestWorker?: { wake(): void };
  reports: Pick<ReportStore, 'list' | 'get'>;
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
  /** Enable only when the runtime mode is a controlled TLS-terminating reverse proxy. */
  trustProxy?: boolean;
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
  const app = fastify({ logger: false, trustProxy: options.trustProxy ?? false });
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => new Date().toISOString());
  const currentTimeMs = () => Date.parse(now());

  app.setErrorHandler((error, request, reply) => {
    request.log.debug({ err: error }, 'request failed');
    reportFailure(options.failureReporter, {
      requestId: request.id,
      method: request.method,
      url: safeOperationalUrl(request.url),
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

  app.get('/api/session', async (request, reply) => {
    const session = authenticate(request, options.auth, sessions, currentTimeMs());
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Authenticated session required.', request.id);
    return { csrfToken: session.csrfToken };
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

  app.get('/api/onboarding', async (request, reply): Promise<OnboardingProgress | FastifyReply> => {
    if (!hasSetupBearer(request, options.auth.setupToken)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Setup token is required.', request.id);
    if (!options.services.onboarding) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    return OnboardingProgressSchema.parse(await options.services.onboarding.get());
  });
  app.patch('/api/onboarding', async (request, reply): Promise<OnboardingProgress | FastifyReply> => {
    if (!hasSetupBearer(request, options.auth.setupToken)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Setup token is required.', request.id);
    if (!options.services.onboarding) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    const input = parseRequest(OnboardingStepCommandSchema, request.body, reply, request.id);
    return input.ok ? OnboardingProgressSchema.parse(await options.services.onboarding.save(input.value)) : input.response;
  });
  app.post('/api/onboarding/complete', async (request, reply) => {
    if (!hasSetupBearer(request, options.auth.setupToken)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Setup token is required.', request.id);
    if (!options.services.onboarding?.complete) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    try {
      const settings = await options.services.onboarding.complete();
      const session = createSession(options.auth, sessions, currentTimeMs());
      reply.header('set-cookie', sessionCookie(session, options.auth));
      return reply.send({ settings, csrfToken: session.csrfToken });
    } catch (error) {
      if (error instanceof Error && error.message === 'ONBOARDING_INCOMPLETE') return sendError(reply, 400, 'ONBOARDING_INCOMPLETE', 'Complete todos los pasos requeridos antes de lanzar el informe.', request.id);
      throw error;
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (isPublicRoute(request) || options.publicRequest?.(request)) return;

    const session = authenticate(request, options.auth, sessions, currentTimeMs());
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Authenticated session required.', request.id);
    if (MUTATING_METHODS.has(request.method) && request.headers['x-csrf-token'] !== session.csrfToken) {
      return sendError(reply, 403, 'CSRF_REQUIRED', 'CSRF token required for this request.', request.id);
    }
  });

  app.get('/api/settings', async () => EditableSettingsDtoSchema.parse(await options.services.settings.get()));
  app.put('/api/settings', async (request, reply) => {
    const input = parseRequest(SettingsUpdateCommandSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    try {
      return EditableSettingsDtoSchema.parse(await options.services.settings.update(input.value));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SETTINGS_REQUIRED_SECRET')) {
        return sendError(reply, 400, 'SETTINGS_REQUIRED_SECRET', 'A required secret is not configured. Replace it before saving.', request.id);
      }
      if (error instanceof Error && error.message === 'SETTINGS_SAVE_FAILED') {
        return sendError(reply, 503, 'SETTINGS_SAVE_FAILED', 'Settings could not be saved. Check storage and try again.', request.id);
      }
      throw error;
    }
  });

  app.post('/api/digests/run', async (request, reply): Promise<RunDigestResponse | FastifyReply> => {
    const input = parseRequest(RunDigestRequestSchema, request.body, reply, request.id);
    if (!input.ok) return input.response;
    if (!options.services.digestWorker) return sendError(reply, 503, 'ANALYSIS_UNAVAILABLE', 'El análisis manual no está disponible. Revise la configuración del servicio.', request.id);
    const result = await options.services.digestJobs.enqueue({ kind: input.value.kind, triggerWindowId: buildTriggerWindowId(input.value, now()), settingsSnapshot: await options.services.settings.get() });
    options.services.digestWorker.wake();
    return reply.code(202).send(result);
  });
  app.get('/api/digests/jobs/:id', async (request, reply): Promise<DigestJobStatus | FastifyReply> => {
    const job = await options.services.digestJobs.get(String((request.params as { id: string }).id));
    return job ? presentJob(job) : sendError(reply, 404, 'NOT_FOUND', 'No se encontró el trabajo del informe.', request.id);
  });
  app.post('/api/digests/jobs/:id/retry', async (request, reply): Promise<DigestJobStatus | FastifyReply> => {
    const job = await options.services.digestJobs.retryFailed(String((request.params as { id: string }).id));
    if (!job) return sendError(reply, 404, 'NOT_FOUND', 'No se encontró el trabajo del informe.', request.id);
    if (job.status === 'queued') options.services.digestWorker?.wake();
    return reply.code(202).send(presentJob(job));
  });
  app.get('/api/digests/history', async (): Promise<DigestHistoryResponse> => options.services.reports.list());
  app.get('/api/digests/:id', async (request, reply): Promise<DigestDetail | FastifyReply> => {
    const detail = await options.services.reports.get(String((request.params as { id: string }).id));
    return detail
      ? { ...detail, presentation: projectReportPresentation(detail) }
      : sendError(reply, 404, 'NOT_FOUND', 'Digest not found.', request.id);
  });

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
  app.post('/api/notifiers/test-current', async (request, reply): Promise<TestResult | FastifyReply> => {
    const body = asRecord(request.body);
    if (body.channel !== 'telegram') return sendError(reply, 400, 'VALIDATION_FAILED', 'Only Telegram can be tested from saved settings.', request.id);
    if (!options.services.settings.notificationTarget) return sendError(reply, 503, 'NOTIFIER_UNAVAILABLE', 'Saved notification testing is unavailable.', request.id);
    try {
      return options.services.notifiers.test({ channel: 'telegram', targetRef: await options.services.settings.notificationTarget('telegram'), message: 'Home Assistant AI Digest notification test' });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('SETTINGS_REQUIRED_SECRET')) return sendError(reply, 400, 'SETTINGS_REQUIRED_SECRET', 'Configure a Telegram bot token before testing delivery.', request.id);
      throw error;
    }
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

function presentJob(job: Awaited<ReturnType<DigestJobStore['get']>> extends infer T ? NonNullable<T> : never): DigestJobStatus {
  const { id, status, stage, attempts, retryCount, retryAvailable, reportId, errorCode, errorMessage, createdAt, updatedAt } = job;
  return { id, status, stage, attempts, retryCount, retryAvailable, ...(reportId ? { reportId } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}), createdAt, updatedAt };
}

function isPublicRoute(request: FastifyRequest): boolean {
  return (request.method === 'POST' && request.url === '/api/session') || (request.method === 'POST' && request.url === '/api/setup') || request.url.startsWith('/api/onboarding');
}

function reportFailure(reporter: CreateAppOptions['failureReporter'], event: OperationalFailureEvent): void {
  try {
    reporter?.(event);
  } catch {
    // Never let telemetry/reporting failures change the HTTP response path.
  }
}

function safeOperationalUrl(url: string): string {
  try {
    return new URL(url, 'http://runtime.local').pathname;
  } catch {
    return url.split('?')[0] || '/';
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
