import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  DigestWindowSchema, EditableSettingsDtoSchema, IgnoreRuleCreateSchema, NoteCreateSchema, NotifierTestRequestSchema, OnboardingProgressSchema, OnboardingStepCommandSchema, SettingsUpdateCommandSchema,
  RunDigestRequestSchema, SendDigestRequestSchema,
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
  /** Retained only as an internal compatibility seam; legacy setup routes do not exist. */
  setup: { complete(input: SetupValidationRequest): Promise<MaskedSettings> };
  auth?: AuthStore;
  onboarding?: { get(): Promise<OnboardingProgress>; save(input: OnboardingStepCommand): Promise<OnboardingProgress>; complete?(): Promise<MaskedSettings> };
  settings: { get(): Promise<EditableSettingsDto>; update(input: SettingsUpdateCommand): Promise<EditableSettingsDto>; notificationTarget?(channel: 'telegram'): Promise<string> };
  digestJobs: Pick<DigestJobStore, 'enqueue' | 'get' | 'retryFailed'>;
  digestWorker?: { wake(): void };
  reports: { save?: ReportStore['save']; list(): Promise<DigestHistoryResponse>; get(id: string): Promise<DigestDetail | null> };
  notes: Pick<NoteStore, 'add' | 'listWindow'>;
  ignores: Pick<IgnoreRuleStore, 'add' | 'remove' | 'listActive'>;
  notifiers: {
    test(input: NotifierTestRequest): Promise<TestResult>;
    send(input: SendDigestRequest): Promise<DeliveryResult>;
  };
};

export type BackendAuthOptions = {
  sessionTtlMs: number;
  /** Set true when serving over HTTPS or behind a TLS-terminating proxy that preserves Secure cookies. */
  secureCookies?: boolean;
};

export type AuthStore = {
  hasAdmin(): Promise<boolean>;
  createAdmin(password: string, language: 'en' | 'es'): Promise<boolean>;
  verifyPassword(password: string): Promise<boolean>;
  changePassword(currentPassword: string, nextPassword: string): Promise<boolean>;
  createSession(ttlMs: number): Promise<Session>;
  readSession(id: string, csrfToken?: string): Promise<Session | null>;
  removeSession(id: string): Promise<void>;
  issueCsrf(id: string): Promise<string | null>;
  loginAllowed(subject: string): Promise<boolean>;
  recordFailedLogin(subject: string): Promise<void>;
  clearFailedLogins(subject: string): Promise<void>;
  language(): Promise<'en' | 'es'>;
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
  /** Allows static frontend routes to stay public without weakening API protection. */
  publicRequest?: (request: FastifyRequest) => boolean;
};

type Session = { id: string; csrfToken: string; expiresAtMs: number };

const SESSION_COOKIE = 'ha_digest_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = fastify({ logger: false, trustProxy: options.trustProxy ?? false });
  const now = options.now ?? (() => new Date().toISOString());
  const currentTimeMs = () => Date.parse(now());
  const auth = options.services.auth;

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

  // Register before routes: Fastify applies encapsulated hooks to routes declared after them.
  app.addHook('preHandler', async (request, reply) => {
    if (isPublicRoute(request) || options.publicRequest?.(request)) return;
    const session = await authenticate(request, auth);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Authenticated session required.', request.id);
    const csrfToken = typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined;
    if (MUTATING_METHODS.has(request.method) && (!csrfToken || !await auth?.readSession(session.id, csrfToken))) {
      return sendError(reply, 403, 'CSRF_REQUIRED', 'CSRF token required for this request.', request.id);
    }
  });

  app.get('/api/auth/status', async () => ({ hasAdmin: await requireAuthStore(auth).hasAdmin() }));

  app.post('/api/auth/register', async (request, reply) => {
    const body = asRecord(request.body);
    const password = String(body.password ?? '');
    const language = body.language === 'es' ? 'es' : 'en';
    if (password.length < 8) return sendError(reply, 400, 'VALIDATION_FAILED', 'Choose a password with at least 8 characters.', request.id);
    const store = requireAuthStore(auth);
    if (!await store.createAdmin(password, language)) return sendError(reply, 409, 'ADMIN_EXISTS', 'An administrator account already exists. Sign in instead.', request.id);
    return startSession(reply, options.auth, store, request.id);
  });

  app.post('/api/session', async (request, reply) => {
    const body = asRecord(request.body);
    const store = requireAuthStore(auth);
    const subject = request.ip || 'unknown';
    if (!await store.loginAllowed(subject)) return sendError(reply, 429, 'LOGIN_THROTTLED', 'Too many sign-in attempts. Try again later.', request.id);
    if (!await store.verifyPassword(String(body.password ?? ''))) {
      await store.recordFailedLogin(subject);
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Invalid credentials.', request.id);
    }
    await store.clearFailedLogins(subject);
    return startSession(reply, options.auth, store, request.id);
  });

  app.get('/api/session', async (request, reply) => {
    const session = await authenticate(request, auth);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Authenticated session required.', request.id);
    const store = requireAuthStore(auth);
    const csrfToken = session.csrfToken || await store.issueCsrf(session.id);
    if (!csrfToken) return sendError(reply, 503, 'SESSION_UNAVAILABLE', 'The authenticated session could not be resumed safely.', request.id);
    return { csrfToken, language: await store.language() };
  });

  app.delete('/api/session', async (request, reply) => {
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId) await requireAuthStore(auth).removeSession(sessionId);
    reply.header('set-cookie', expiredSessionCookie(options.auth));
    return reply.code(204).send();
  });

  app.get('/api/onboarding', async (request, reply): Promise<OnboardingProgress | FastifyReply> => {
    if (!options.services.onboarding) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    return OnboardingProgressSchema.parse(await options.services.onboarding.get());
  });
  app.patch('/api/onboarding', async (request, reply): Promise<OnboardingProgress | FastifyReply> => {
    if (!options.services.onboarding) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    const input = parseRequest(OnboardingStepCommandSchema, request.body, reply, request.id);
    return input.ok ? OnboardingProgressSchema.parse(await options.services.onboarding.save(input.value)) : input.response;
  });
  app.post('/api/onboarding/complete', async (request, reply) => {
    if (!options.services.onboarding?.complete) return sendError(reply, 503, 'ONBOARDING_UNAVAILABLE', 'Persisted onboarding is unavailable.', request.id);
    try {
      const settings = await options.services.onboarding.complete();
       return reply.send({ settings });
    } catch (error) {
      if (error instanceof Error && error.message === 'ONBOARDING_INCOMPLETE') return sendError(reply, 400, 'ONBOARDING_INCOMPLETE', 'Complete todos los pasos requeridos antes de lanzar el informe.', request.id);
      throw error;
    }
  });

  app.post('/api/account/password', async (request, reply) => {
    const body = asRecord(request.body);
    const currentPassword = String(body.currentPassword ?? '');
    const nextPassword = String(body.nextPassword ?? '');
    if (nextPassword.length < 8) return sendError(reply, 400, 'VALIDATION_FAILED', 'Choose a password with at least 8 characters.', request.id);
    if (!await requireAuthStore(auth).changePassword(currentPassword, nextPassword)) return sendError(reply, 401, 'UNAUTHENTICATED', 'Invalid credentials.', request.id);
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId) await requireAuthStore(auth).removeSession(sessionId);
    reply.header('set-cookie', expiredSessionCookie(options.auth));
    return reply.code(204).send();
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
      ? { ...detail, presentation: detail.presentation ?? projectReportPresentation(detail) }
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

async function startSession(reply: FastifyReply, auth: BackendAuthOptions, store: AuthStore, requestId: string) {
  const session = await store.createSession(auth.sessionTtlMs);
  reply.header('set-cookie', sessionCookie(session, auth));
  return reply.send({ csrfToken: session.csrfToken, language: await store.language() });
}

async function authenticate(request: FastifyRequest, auth: AuthStore | undefined): Promise<Session | null> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  return sessionId ? requireAuthStore(auth).readSession(sessionId) : null;
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
  return request.url === '/api/auth/status' || (request.method === 'POST' && (request.url === '/api/auth/register' || request.url === '/api/session'));
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

function requireAuthStore(auth: AuthStore | undefined): AuthStore {
  if (!auth) throw new Error('AUTH_STORE_UNAVAILABLE');
  return auth;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
