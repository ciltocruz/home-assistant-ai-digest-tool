import {
  DeliveryResultSchema,
  DigestHistoryResponseSchema,
  IgnoreRuleCreateSchema,
  IgnoreRuleDtoSchema,
  NoteCreateSchema,
  NoteDtoSchema,
  NotifierTestRequestSchema,
  RedactedSettingsDtoSchema,
  RunDigestRequestSchema,
  RunDigestResponseSchema,
  SendDigestRequestSchema,
  SetupValidationRequestSchema,
  SetupValidationResponseSchema,
  TestResultSchema,
  type DeliveryResult,
  type DigestHistoryResponse,
  type IgnoreRuleCreate,
  type IgnoreRuleDto,
  type NoteCreate,
  type NoteDto,
  type NotifierTestRequest,
  type RedactedSettingsDto,
  type RunDigestRequest,
  type RunDigestResponse,
  type SendDigestRequest,
  type SetupValidationRequest,
  type SetupValidationResponse,
  type TestResult
} from '@ha-digest/shared';
import { z } from 'zod';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ApiClientOptions = {
  baseUrl?: string;
  csrfToken?: string;
  setupToken?: string;
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
    headers['content-type'] = 'application/json';
    if (csrfToken && init.method && init.method !== 'GET') headers['x-csrf-token'] = csrfToken;

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl ?? ''}${path}`, { ...init, headers, credentials: 'same-origin' });
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'Network request failed before a safe server response was available.', 'client');
    }
    const body = await readJson(response);
    if (!response.ok) throw toApiClientError(body);

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiClientError('INVALID_RESPONSE', 'The server returned an unexpected redacted response shape.', 'client');
    return parsed.data;
  }

  return {
    getCsrfToken: () => csrfToken,
    validateSetup: async (input: SetupValidationRequest): Promise<SetupValidationResponse> => {
      const payload = SetupValidationRequestSchema.parse(input);
      const response = await request('/api/setup', SetupValidationResponseSchema, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.setupToken ?? ''}` },
        body: JSON.stringify(payload)
      });
      csrfToken = response.csrfToken;
      return response;
    },
    getSettings: () => request('/api/settings', RedactedSettingsDtoSchema),
    updateSettings: (input: RedactedSettingsDto) => request('/api/settings', RedactedSettingsDtoSchema, { method: 'PUT', body: JSON.stringify(RedactedSettingsDtoSchema.parse(input)) }),
    runDigest: (input: RunDigestRequest): Promise<RunDigestResponse> => request('/api/digests/run', RunDigestResponseSchema, { method: 'POST', body: JSON.stringify(RunDigestRequestSchema.parse(input)) }),
    listHistory: (): Promise<DigestHistoryResponse> => request('/api/digests/history', DigestHistoryResponseSchema),
    addNote: (input: NoteCreate): Promise<NoteDto> => request('/api/notes', NoteDtoSchema, { method: 'POST', body: JSON.stringify(NoteCreateSchema.parse(input)) }),
    listIgnores: (): Promise<IgnoreRuleDto[]> => request('/api/ignores', z.array(IgnoreRuleDtoSchema)),
    addIgnore: (input: IgnoreRuleCreate): Promise<IgnoreRuleDto> => request('/api/ignores', IgnoreRuleDtoSchema, { method: 'POST', body: JSON.stringify(IgnoreRuleCreateSchema.parse(input)) }),
    removeIgnore: (id: string): Promise<void> => request(`/api/ignores/${encodeURIComponent(id)}`, z.unknown(), { method: 'DELETE' }).then(() => undefined),
    testNotifier: (input: NotifierTestRequest): Promise<TestResult> => request('/api/notifiers/test', TestResultSchema, { method: 'POST', body: JSON.stringify(NotifierTestRequestSchema.parse(input)) }),
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
    .replace(BASE64URL_JSON_TOKEN_PATTERN, '[redacted]')
    .replace(/[A-Za-z0-9_-]*secret[A-Za-z0-9_:-]*/gi, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:ha|sk|ghp|AIza)[A-Za-z0-9_:-]{8,}\b/g, '[redacted]');
}

const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s'"<>,);]+/gi;
const BASE64URL_JSON_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{24,}\b/g;
