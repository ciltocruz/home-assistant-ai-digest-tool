import {
  DeliveryResultSchema,
  DigestDetailSchema,
  DigestJobStatusSchema,
  DigestHistoryResponseSchema,
  IgnoreRuleCreateSchema,
  IgnoreRuleDtoSchema,
  NoteCreateSchema,
  NoteDtoSchema,
  NotifierTestRequestSchema,
  MaskedSettingsSchema,
  OnboardingProgressSchema,
  OnboardingStepCommandSchema,
  SettingsUpdateCommandSchema,
  EditableSettingsDtoSchema,
  RunDigestRequestSchema,
  RunDigestResponseSchema,
  SendDigestRequestSchema,
  TestResultSchema,
  type DeliveryResult,
  type DigestDetail,
  type DigestJobStatus,
  type DigestHistoryResponse,
  type IgnoreRuleCreate,
  type IgnoreRuleDto,
  type NoteCreate,
  type NoteDto,
  type NotifierTestRequest,
  type OnboardingProgress,
  type OnboardingStepCommand,
  type EditableSettingsDto,
  type RunDigestRequest,
  type RunDigestResponse,
  type SendDigestRequest,
  type SetupValidationRequest,
  type SetupValidationResponse, type SettingsUpdateCommand,
  type TestResult
} from '@ha-digest/shared';
import { z } from 'zod';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ApiClientOptions = {
  baseUrl?: string;
  csrfToken?: string;
  fetch?: FetchLike;
};

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly fieldErrors?: Record<string, string[]>;

  constructor(code: string, message: string, requestId: string, fieldErrors?: Record<string, string[]>) {
    super(redactSensitiveText(message));
    this.name = 'ApiClientError';
    this.code = code;
    this.requestId = requestId;
    this.fieldErrors = redactFieldErrors(fieldErrors);
  }

  override toString(): string {
    return `${this.name}: ${this.message} (${this.code}, request ${this.requestId})`;
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  let csrfToken = options.csrfToken ?? '';

  async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (init.body !== undefined && init.body !== null) headers['content-type'] = 'application/json';
    else delete headers['content-type'];
    if (csrfToken && (init.method && init.method !== 'GET' || path === '/api/session')) headers['x-csrf-token'] = csrfToken;

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl ?? ''}${path}`, { ...init, headers, credentials: 'same-origin' });
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'Network request failed before a safe server response was available.', 'client');
    }
    const body = await readJson(response);
    if (!response.ok) throw toApiClientError(body);

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : 'response';
      throw new ApiClientError('INVALID_RESPONSE', `The server returned an invalid ${path}: ${issue?.message ?? 'unexpected response shape'}.`, 'client');
    }
    return parsed.data;
  }

  return {
    getCsrfToken: () => csrfToken,
    getSession: async (): Promise<{ language: 'en' | 'es' }> => {
      const response = await request('/api/session', z.object({ csrfToken: z.string().min(1), language: z.enum(['en', 'es']) }), { method: 'GET' });
      csrfToken = response.csrfToken;
      return { language: response.language };
    },
    getAuthStatus: () => request('/api/auth/status', z.object({ hasAdmin: z.boolean() })),
    register: async (password: string, language: 'en' | 'es'): Promise<{ language: 'en' | 'es' }> => {
      const response = await request('/api/auth/register', z.object({ csrfToken: z.string().min(1), language: z.enum(['en', 'es']) }), { method: 'POST', body: JSON.stringify({ password, language }) });
      csrfToken = response.csrfToken;
      return { language: response.language };
    },
    login: async (password: string): Promise<{ language: 'en' | 'es' }> => {
      const response = await request('/api/session', z.object({ csrfToken: z.string().min(1), language: z.enum(['en', 'es']) }), { method: 'POST', body: JSON.stringify({ password }) });
      csrfToken = response.csrfToken;
      return { language: response.language };
    },
    getOnboarding: (): Promise<OnboardingProgress> => request('/api/onboarding', OnboardingProgressSchema, { method: 'GET' }),
    saveOnboarding: (input: OnboardingStepCommand): Promise<OnboardingProgress> => request('/api/onboarding', OnboardingProgressSchema, { method: 'PATCH', body: JSON.stringify(OnboardingStepCommandSchema.parse(input)) }),
    completeOnboarding: () => request('/api/onboarding/complete', z.object({ settings: MaskedSettingsSchema }), { method: 'POST', body: JSON.stringify({}) }),
    getSettings: () => request('/api/settings', EditableSettingsDtoSchema),
    updateSettings: (input: SettingsUpdateCommand) => request('/api/settings', EditableSettingsDtoSchema, { method: 'PUT', body: JSON.stringify(SettingsUpdateCommandSchema.parse(input)) }),
    runDigest: (input: RunDigestRequest): Promise<RunDigestResponse> => request('/api/digests/run', RunDigestResponseSchema, { method: 'POST', body: JSON.stringify(RunDigestRequestSchema.parse(input)) }),
    getDigestJob: (id: string): Promise<DigestJobStatus> => request(`/api/digests/jobs/${encodeURIComponent(id)}`, DigestJobStatusSchema),
    retryDigestJob: (id: string): Promise<DigestJobStatus> => request(`/api/digests/jobs/${encodeURIComponent(id)}/retry`, DigestJobStatusSchema, { method: 'POST' }),
    listHistory: (): Promise<DigestHistoryResponse> => request('/api/digests/history', DigestHistoryResponseSchema),
    getDigest: (id: string): Promise<DigestDetail> => request(`/api/digests/${encodeURIComponent(id)}`, DigestDetailSchema),
    addNote: (input: NoteCreate): Promise<NoteDto> => request('/api/notes', NoteDtoSchema, { method: 'POST', body: JSON.stringify(NoteCreateSchema.parse(input)) }),
    listNotes: (window: { from: string; to: string }): Promise<NoteDto[]> => {
      const params = new URLSearchParams({ from: window.from, to: window.to });
      return request(`/api/notes?${params.toString()}`, z.array(NoteDtoSchema));
    },
    listIgnores: (): Promise<IgnoreRuleDto[]> => request('/api/ignores', z.array(IgnoreRuleDtoSchema)),
    addIgnore: (input: IgnoreRuleCreate): Promise<IgnoreRuleDto> => request('/api/ignores', IgnoreRuleDtoSchema, { method: 'POST', body: JSON.stringify(IgnoreRuleCreateSchema.parse(input)) }),
    removeIgnore: (id: string): Promise<void> => request(`/api/ignores/${encodeURIComponent(id)}`, z.unknown(), { method: 'DELETE' }).then(() => undefined),
    testNotifier: (input: NotifierTestRequest): Promise<TestResult> => request('/api/notifiers/test', TestResultSchema, { method: 'POST', body: JSON.stringify(NotifierTestRequestSchema.parse(input)) }),
    testCurrentNotifier: (): Promise<TestResult> => request('/api/notifiers/test-current', TestResultSchema, { method: 'POST', body: JSON.stringify({ channel: 'telegram' }) }),
    sendDigest: (digestId: string, targetRef: string): Promise<DeliveryResult> => {
      const payload: SendDigestRequest = SendDigestRequestSchema.parse({ digestId, targetRef });
      return request('/api/notifiers/send', DeliveryResultSchema, { method: 'POST', body: JSON.stringify(payload) });
    }
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { code: 'INVALID_RESPONSE', message: 'The server returned a non-JSON response.', requestId: 'client' };
  }
}

function toApiClientError(body: unknown): ApiClientError {
  const parsed = z.object({ code: z.string(), message: z.string(), requestId: z.string(), fieldErrors: z.record(z.array(z.string())).optional() }).safeParse(body);
  if (!parsed.success) return new ApiClientError('REQUEST_FAILED', 'Request failed without a safe error response.', 'client');
  return new ApiClientError(parsed.data.code, parsed.data.message, parsed.data.requestId, parsed.data.fieldErrors);
}

function redactFieldErrors(fieldErrors: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined;
  return Object.fromEntries(Object.entries(fieldErrors).map(([field, errors]) => [field, errors.map(redactSensitiveText)]));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(QUERY_SECRET_PATTERN, '$1[redacted]')
    .replace(ASSIGNMENT_SECRET_PATTERN, '$1[redacted]')
    .replace(BASE64URL_JSON_TOKEN_PATTERN, '[redacted]')
    .replace(/[A-Za-z0-9_-]*secret[A-Za-z0-9_:-]*/gi, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:ha|sk|ghp|AIza)[A-Za-z0-9_:-]{8,}\b/g, '[redacted]');
}

const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s'"<>,);]+/gi;
const BASE64URL_JSON_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{24,}\b/g;
const QUERY_SECRET_PATTERN = /([?&](?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret)=)[^&#\s]+/gi;
const ASSIGNMENT_SECRET_PATTERN = /(\b(?:key|token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|authorization)\s*[:=]\s*)[^\s&;,}<>"']+/gi;
