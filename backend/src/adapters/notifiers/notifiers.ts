import type { DeliveryResult, TestResult } from '@ha-digest/shared';
import type { Notifier, ResolvedTargetConfig } from '../../domain/notifiers.js';
import type { RenderedDigest } from '../../domain/renderers.js';

export type NotifierHttpRequest = {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
};

export type NotifierHttpResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type NotifierHttpClient = (request: NotifierHttpRequest) => Promise<NotifierHttpResponse>;

type TelegramNotifierOptions = {
  httpClient?: NotifierHttpClient;
  now?: () => string;
  timeoutMs?: number;
};

export type TelegramSummary = { findings: Array<{ signature: string; analysis: { summary: string; recommendation: string } }>; reportUrl?: string; language?: 'en' | 'es' };

type MarkdownNotifierOptions = {
  write: (entry: { label: string; body: string }) => Promise<string>;
  now?: () => string;
};

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';
  private readonly httpClient: NotifierHttpClient;
  private readonly now: () => string;
  private readonly timeoutMs: number;

  constructor(options: TelegramNotifierOptions = {}) {
    this.httpClient = options.httpClient ?? fetchJson;
    this.now = options.now ?? (() => new Date().toISOString());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async test(target: ResolvedTargetConfig): Promise<TestResult> {
    const result = await this.postMessage(target, 'Home Assistant AI Digest test message.');
    if (result.status === 'sent') return { status: 'success', message: 'Telegram test message delivered.', checkedAt: this.now() };
    return { status: 'failed', message: result.message ?? 'Telegram test message failed.', checkedAt: this.now() };
  }

  async send(digest: RenderedDigest, target: ResolvedTargetConfig): Promise<DeliveryResult> {
    return this.postMessage(target, digest.body);
  }

  async sendSummary(summary: TelegramSummary, target: ResolvedTargetConfig): Promise<DeliveryResult> {
    if (summary.findings.length === 0) return { status: 'skipped', targetRef: targetRef(target), message: 'No noteworthy findings.' };
    const first = escapeTelegramMarkdown(summary.findings[0]!.analysis.summary);
    const spanish = summary.language === 'es';
    const link = summary.reportUrl ? `\n[${spanish ? 'Abrir informe' : 'Open report'}](${escapeTelegramUrl(summary.reportUrl)})` : '';
    const count = summary.findings.length;
    return this.postMessage(target, spanish
      ? `*Resumen de Home Assistant*\n${count} incidencia${count === 1 ? '' : 's'} destacada${count === 1 ? '' : 's'}\\. ${first}${link}`
      : `*Home Assistant digest*\n${count} noteworthy finding${count === 1 ? '' : 's'}\\. ${first}${link}`, true);
  }

  private async postMessage(target: ResolvedTargetConfig, text: string, isMarkdown = false): Promise<DeliveryResult> {
    const botToken = requiredConfig(target, 'botToken');
    const chatId = requiredConfig(target, 'chatId');
    let response: NotifierHttpResponse;
    try {
      response = await withTimeout(this.timeoutMs, (signal) => this.httpClient({
        method: 'POST',
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,
        signal,
        headers: { 'content-type': 'application/json' },
        body: {
          chat_id: chatId,
          text: isMarkdown ? text : escapeTelegramMarkdown(text),
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        }
      }));
    } catch {
      return {
        status: 'failed',
        targetRef: targetRef(target),
        errorCode: 'TELEGRAM_REQUEST_FAILED',
        message: 'Telegram delivery failed before receiving a response.'
      };
    }

    if (response.status < 200 || response.status >= 300) {
      const failure = telegramHttpFailure(response.status);
      return {
        status: 'failed',
        targetRef: targetRef(target),
        ...failure
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return telegramInvalidResponse(target);
    }
    if (telegramRejected(payload)) {
      return { status: 'failed', targetRef: targetRef(target), errorCode: 'TELEGRAM_REJECTED', message: 'Telegram rejected the message.' };
    }
    if (!telegramOk(payload)) return telegramInvalidResponse(target);

    return { status: 'sent', targetRef: targetRef(target), deliveredAt: this.now() };
  }
}

function telegramHttpFailure(status: number): Pick<DeliveryResult, 'errorCode' | 'message'> {
  if (status === 400) return { errorCode: 'TELEGRAM_HTTP_400', message: 'Telegram rejected the message format.' };
  if (status === 401) return { errorCode: 'TELEGRAM_HTTP_401', message: 'Telegram rejected the configured credentials.' };
  if (status === 403) return { errorCode: 'TELEGRAM_HTTP_403', message: 'Telegram refused delivery to the configured destination.' };
  if (status === 404) return { errorCode: 'TELEGRAM_HTTP_404', message: 'Telegram could not find the configured bot endpoint.' };
  if (status === 409) return { errorCode: 'TELEGRAM_HTTP_409', message: 'Telegram reported a conflicting bot operation.' };
  if (status === 429) return { errorCode: 'TELEGRAM_HTTP_429', message: 'Telegram temporarily limited delivery requests.' };
  if (status >= 500 && status <= 599) return { errorCode: 'TELEGRAM_HTTP_5XX', message: 'Telegram service is temporarily unavailable.' };
  return { errorCode: 'TELEGRAM_REJECTED', message: 'Telegram rejected the delivery request.' };
}

async function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export class MarkdownNotifier implements Notifier {
  readonly channel = 'markdown';
  private readonly now: () => string;

  constructor(private readonly options: MarkdownNotifierOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async test(target: ResolvedTargetConfig): Promise<TestResult> {
    try {
      await this.options.write({ label: target.label, body: 'Home Assistant AI Digest test message.' });
      return { status: 'success', message: `Markdown target ${target.label} is writable.`, checkedAt: this.now() };
    } catch {
      return {
        status: 'failed',
        message: `Markdown target ${target.label} is not writable. Check the configured output path and permissions.`,
        checkedAt: this.now()
      };
    }
  }

  async send(digest: RenderedDigest, target: ResolvedTargetConfig): Promise<DeliveryResult> {
    const location = await this.options.write({ label: target.label, body: digest.body });
    return { status: 'sent', targetRef: targetRef(target), deliveredAt: this.now(), message: location };
  }
}

function requiredConfig(target: ResolvedTargetConfig, key: string): string {
  const value = target.config[key];
  if (!value) throw new Error(`Missing ${key} for ${target.channel} notifier`);
  return value;
}

function targetRef(target: ResolvedTargetConfig): string {
  return `${target.channel}:${target.label}`;
}

function telegramOk(payload: unknown): boolean {
  return asRecord(payload).ok === true;
}

function telegramRejected(payload: unknown): boolean {
  return asRecord(payload).ok === false;
}

function telegramInvalidResponse(target: ResolvedTargetConfig): DeliveryResult {
  return { status: 'pending', targetRef: targetRef(target), errorCode: 'TELEGRAM_INVALID_RESPONSE', message: 'Telegram returned a response that could not be confirmed.' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function escapeTelegramMarkdown(value: string): string {
  return value.replace(/([_\-*\[\]()~`>#+=|{}.!\\])/g, '\\$1');
}

function escapeTelegramUrl(value: string): string {
  return value.replace(/([\\)])/g, '\\$1');
}

async function fetchJson(request: NotifierHttpRequest): Promise<NotifierHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: request.signal
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}
