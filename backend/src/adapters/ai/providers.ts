import type { AIProvider, RedactedDigestInput, StructuredDigest } from '../../domain/providers.js';
import { redactProviderError } from '../../domain/safe-error.js';
import { combineAbortSignals, type ExecutionContext } from '../../domain/execution.js';
import type { BoundedSignatureContext, SignatureAnalysis, SignatureProvider } from '../../application/batch-report-run.js';

export type ProviderHttpRequest = {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
};

export type ProviderHttpResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type ProviderHttpClient = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;

type ProviderOptions = {
  apiKey: string;
  httpClient?: ProviderHttpClient;
  model?: string;
  timeoutMs?: number;
};

export type SignatureProviderOptions = ProviderOptions & { baseUrl?: string };

export type AIProviderFailureClassification = 'model retired' | 'quota' | 'billing' | 'invalid key' | 'timeout' | 'other';

export class AIProviderError extends Error {
  readonly status: number | 'unavailable';
  readonly classification: AIProviderFailureClassification;
  readonly provider: string;
  readonly model: string;

  constructor(details: {
    provider: string;
    model: string;
    status: number | 'unavailable';
    classification: AIProviderFailureClassification;
    message: string;
  }) {
    super(details.message);
    this.name = 'AIProviderError';
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
    this.classification = details.classification;
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

abstract class SignatureHttpProvider implements SignatureProvider {
  protected readonly httpClient: ProviderHttpClient;
  protected readonly timeoutMs: number;
  abstract readonly name: string;
  protected abstract readonly model: string;

  constructor(protected readonly options: SignatureProviderOptions) {
    this.httpClient = options.httpClient ?? fetchJson;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async analyze(context: BoundedSignatureContext, signal: AbortSignal, language: 'en' | 'es' = 'en'): Promise<SignatureAnalysis> {
    const response = await requestProvider(this.name, this.model, this.timeoutMs, signal, (requestSignal) => this.request(context, language, requestSignal), undefined, this.options.apiKey);
    try {
      return parseSignatureAnalysis(this.content(await response.json()), this.name, this.options.apiKey);
    } catch (error) {
      throw providerFailure(this.name, this.model, response.status, errorDetail(error), 'other', this.options.apiKey);
    }
  }

  protected abstract request(context: BoundedSignatureContext, language: 'en' | 'es', signal: AbortSignal): Promise<ProviderHttpResponse>;
  protected abstract content(payload: unknown): string;
}

export function createSignatureProvider(provider: 'openai' | 'gemini' | 'ollama', options: SignatureProviderOptions): SignatureProvider {
  if (provider === 'openai') return new OpenAISignatureProvider(options);
  if (provider === 'gemini') return new GeminiSignatureProvider(options);
  return new OllamaSignatureProvider(options);
}

class OpenAISignatureProvider extends SignatureHttpProvider {
  readonly name = 'OpenAI';
  protected readonly model: string;

  constructor(options: SignatureProviderOptions) {
    super(options);
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  protected request(context: BoundedSignatureContext, language: 'en' | 'es', signal: AbortSignal): Promise<ProviderHttpResponse> {
    return this.httpClient({ method: 'POST', url: this.options.baseUrl ?? OPENAI_URL, signal, headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' }, body: {
      model: this.model, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: signatureInstructions(language) }, { role: 'user', content: signaturePrompt(context) }]
    } });
  }

  protected content(payload: unknown): string { return extractOpenAIContent(payload); }
}

class GeminiSignatureProvider extends SignatureHttpProvider {
  readonly name = 'Gemini';
  protected readonly model: string;

  constructor(options: SignatureProviderOptions) {
    super(options);
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
  }

  protected request(context: BoundedSignatureContext, language: 'en' | 'es', signal: AbortSignal): Promise<ProviderHttpResponse> {
    const root = this.options.baseUrl ?? GEMINI_URL;
    return this.httpClient({ method: 'POST', url: `${root}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`, signal, headers: { 'content-type': 'application/json' }, body: {
      contents: [{ role: 'user', parts: [{ text: `${signatureInstructions(language)}\n\n${signaturePrompt(context)}` }] }], generationConfig: { responseMimeType: 'application/json' }
    } });
  }

  protected content(payload: unknown): string { return extractGeminiContent(payload); }
}

class OllamaSignatureProvider extends SignatureHttpProvider {
  readonly name = 'Ollama';
  protected readonly model: string;

  constructor(options: SignatureProviderOptions) {
    super(options);
    this.model = options.model ?? 'llama3.2';
  }

  protected request(context: BoundedSignatureContext, language: 'en' | 'es', signal: AbortSignal): Promise<ProviderHttpResponse> {
    return this.httpClient({ method: 'POST', url: `${(this.options.baseUrl ?? 'http://ollama:11434').replace(/\/$/, '')}/api/chat`, signal, headers: { 'content-type': 'application/json' }, body: {
      model: this.model, stream: false,
      messages: [{ role: 'system', content: signatureInstructions(language) }, { role: 'user', content: signaturePrompt(context) }]
    } });
  }

  protected content(payload: unknown): string {
    const content = asRecord(asRecord(payload).message).content;
    if (typeof content !== 'string') throw new Error('Ollama provider response was missing message content');
    return content;
  }
}

export class FakeAIProvider implements AIProvider {
  readonly id = 'fake';

  async generate(input: RedactedDigestInput, context?: ExecutionContext): Promise<StructuredDigest> {
    context?.checkpoint();
    const severity = highestSeverity(input.incidents.map((incident) => incident.severity));
    return {
      severity,
      summary: `${input.incidents.length} incident${input.incidents.length === 1 ? '' : 's'} needs attention for ${input.window.from} → ${input.window.to}.`,
      attentionItems: [...input.incidents].sort((a, b) => a.id.localeCompare(b.id)).map((incident) => ({
        title: incident.summary,
        severity: incident.severity,
        detail: incident.redactedEvidence.join('; ')
      }))
    };
  }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  private readonly httpClient: ProviderHttpClient;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProviderOptions) {
    this.httpClient = options.httpClient ?? fetchJson;
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async generate(input: RedactedDigestInput, context?: ExecutionContext): Promise<StructuredDigest> {
    context?.checkpoint();
    const response = await requestProvider(
      'OpenAI',
      this.model,
      this.timeoutMs,
      context?.signal,
      (signal) => this.httpClient({
        method: 'POST',
        url: OPENAI_URL,
        signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json'
        },
        body: {
          model: this.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: providerInstructions() },
            { role: 'user', content: redactedPrompt(input) }
          ]
        }
      }),
      context?.checkpoint,
      this.options.apiKey
    );

    context?.checkpoint();
    try {
      const payload = await response.json();
      return parseStructuredDigest(extractOpenAIContent(payload), 'OpenAI', this.options.apiKey);
    } catch (error) {
      throw providerFailure('OpenAI', this.model, response.status, errorDetail(error), 'other', this.options.apiKey);
    }
  }
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  private readonly httpClient: ProviderHttpClient;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProviderOptions) {
    this.httpClient = options.httpClient ?? fetchJson;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async generate(input: RedactedDigestInput, context?: ExecutionContext): Promise<StructuredDigest> {
    context?.checkpoint();
    const response = await requestProvider(
      'Gemini',
      this.model,
      this.timeoutMs,
      context?.signal,
      (signal) => this.httpClient({
        method: 'POST',
        url: `${GEMINI_URL}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
        signal,
        headers: { 'content-type': 'application/json' },
        body: {
          contents: [
            {
              role: 'user',
              parts: [{ text: `${providerInstructions()}\n\n${redactedPrompt(input)}` }]
            }
          ],
          generationConfig: { responseMimeType: 'application/json' }
        }
      }),
      context?.checkpoint,
      this.options.apiKey
    );

    context?.checkpoint();
    try {
      const payload = await response.json();
      return parseStructuredDigest(extractGeminiContent(payload), 'Gemini', this.options.apiKey);
    } catch (error) {
      throw providerFailure('Gemini', this.model, response.status, errorDetail(error), 'other', this.options.apiKey);
    }
  }
}

async function requestProvider(
  provider: string,
  model: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<ProviderHttpResponse>,
  checkpoint?: ExecutionContext['checkpoint'],
  apiKey?: string
): Promise<ProviderHttpResponse> {
  const cancellation = combineAbortSignals(parentSignal, timeoutMs);
  try {
    let response: ProviderHttpResponse;
    try {
      response = await operation(cancellation.signal);
    } catch (error) {
      if (parentSignal?.aborted) {
        try {
          checkpoint?.();
        } catch (checkpointError) {
          throw checkpointError;
        }
        throw providerFailure(provider, model, undefined, errorDetail(error), 'other', apiKey);
      }
      const classification = cancellation.signal.aborted ? 'timeout' : 'other';
      throw providerFailure(provider, model, undefined, errorDetail(error), classification, apiKey);
    }
    if (response.status < 200 || response.status >= 300) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        payload = { error: { message: errorDetail(error) } };
      }
      throw providerFailure(provider, model, response.status, providerErrorMessage(payload), undefined, apiKey);
    }
    return response;
  } finally {
    cancellation.dispose();
  }
}

function providerFailure(
  provider: string,
  model: string,
  status: number | undefined,
  detail: string,
  classification = classifyProviderFailure(status, detail),
  apiKey?: string
): AIProviderError {
  const safeDetail = redactProviderError(detail || 'The provider returned no error message.', apiKey);
  const statusLabel = status ?? 'unavailable';
  const prefix = `${provider} ${statusLabel}: model '${model}'`;
  if (classification === 'model retired') {
    const remediation = provider === 'Gemini' ? ' Update the model to gemini-flash-latest.' : '';
    return new AIProviderError({
      provider,
      model,
      status: statusLabel,
      classification,
      message: `${prefix} no longer exists (retired; classification: model retired).${remediation} Provider message: ${safeDetail}`
    });
  }
  const detailLabel = classification === 'timeout' ? 'Original error' : 'Provider message';
  return new AIProviderError({
    provider,
    model,
    status: statusLabel,
    classification,
    message: `${prefix} failed (classification: ${classification}). ${detailLabel}: ${safeDetail}`
  });
}

function classifyProviderFailure(status: number | undefined, detail: string): AIProviderFailureClassification {
  if (status === undefined && /timeout|timed out|aborted/i.test(detail)) return 'timeout';
  if (status === 401 || status === 403) return 'invalid key';
  if (status === 404 && /model|not found|not supported|generatecontent/i.test(detail)) return 'model retired';
  if (status === 429 && /billing|paid plan|payment|subscription|upgrade|plan|free tier/i.test(detail)) return 'billing';
  if (status === 429) return 'quota';
  return 'other';
}

function providerErrorMessage(payload: unknown): string {
  const root = asRecord(payload);
  const error = asRecord(root.error);
  if (typeof error.message === 'string') return error.message;
  if (typeof root.message === 'string') return root.message;
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return 'The provider returned an unreadable error response.';
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'The provider request failed without an error message.';
  }
}

function providerInstructions(): string {
  return [
    'You summarize Home Assistant incidents from redacted incident context.',
    'Return JSON only with severity, summary, and attentionItems.',
    'Do not request or reveal raw secrets, tokens, full logs, or credentials.'
  ].join(' ');
}

function redactedPrompt(input: RedactedDigestInput): string {
  return `Use this redacted incident context to generate a digest:\n${JSON.stringify(input)}`;
}

function signatureInstructions(language: 'en' | 'es'): string {
  const outputLanguage = language === 'es'
    ? 'Write both string values in neutral professional Spanish.'
    : 'Write both string values in English.';
  return `Analyze one redacted Home Assistant log signature. Return JSON only with stable English keys summary and recommendation. ${outputLanguage} Do not reveal or request secrets, tokens, credentials, or full logs.`;
}

function signaturePrompt(context: BoundedSignatureContext): string {
  return `Use this bounded redacted signature context:\n${JSON.stringify({ ...context, occurrences: context.occurrences.map(redactText) })}`;
}

function redactText(value: string): string {
  return value.replace(/\bBearer\s+[-._~+/=A-Za-z0-9]+\b/gi, 'Bearer [REDACTED]').replace(/\b(token|api[_-]?key|password|secret)(\s*[:=]\s*)[^\s&]+/gi, '$1$2[REDACTED]');
}

function extractOpenAIContent(payload: unknown): string {
  const choice = asRecord(payload).choices;
  if (!Array.isArray(choice)) throw new Error('OpenAI provider response was missing choices');
  const content = asRecord(asRecord(choice[0]).message).content;
  if (typeof content !== 'string') throw new Error('OpenAI provider response was missing message content');
  return content;
}

function extractGeminiContent(payload: unknown): string {
  const candidates = asRecord(payload).candidates;
  if (!Array.isArray(candidates)) throw new Error('Gemini provider response was missing candidates');
  const parts = asRecord(asRecord(candidates[0]).content).parts;
  if (!Array.isArray(parts)) throw new Error('Gemini provider response was missing parts');
  const text = asRecord(parts[0]).text;
  if (typeof text !== 'string') throw new Error('Gemini provider response was missing text');
  return text;
}

function parseStructuredDigest(content: string, provider: string, apiKey?: string): StructuredDigest {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isStructuredDigest(parsed)) throw new Error('invalid digest shape');
    return {
      severity: parsed.severity,
      summary: redactProviderError(parsed.summary, apiKey),
      attentionItems: parsed.attentionItems.map((item) => ({
        title: redactProviderError(item.title, apiKey),
        severity: item.severity,
        detail: redactProviderError(item.detail, apiKey)
      }))
    };
  } catch {
    throw new Error(`${provider} provider returned an invalid digest`);
  }
}

function parseSignatureAnalysis(content: string, provider: string, apiKey?: string): SignatureAnalysis {
  try {
    const value = asRecord(JSON.parse(content));
    if (typeof value.summary !== 'string' || typeof value.recommendation !== 'string') throw new Error('invalid analysis');
    return { summary: redactProviderError(value.summary, apiKey), recommendation: redactProviderError(value.recommendation, apiKey) };
  } catch {
    throw new Error(`${provider} provider returned an invalid signature analysis`);
  }
}

function isStructuredDigest(value: unknown): value is StructuredDigest {
  const digest = asRecord(value);
  return isSeverity(digest.severity) && typeof digest.summary === 'string' && Array.isArray(digest.attentionItems) && digest.attentionItems.every(isAttentionItem);
}

function isAttentionItem(value: unknown): value is StructuredDigest['attentionItems'][number] {
  const item = asRecord(value);
  return typeof item.title === 'string' && isSeverity(item.severity) && typeof item.detail === 'string';
}

function isSeverity(value: unknown): value is StructuredDigest['severity'] {
  return value === 'critical' || value === 'warning' || value === 'info';
}

function highestSeverity(severities: StructuredDigest['severity'][]): StructuredDigest['severity'] {
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('warning')) return 'warning';
  return 'info';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function fetchJson(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}
