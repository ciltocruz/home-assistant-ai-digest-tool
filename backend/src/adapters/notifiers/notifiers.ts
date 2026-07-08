import type { DeliveryResult, TestResult } from '@ha-digest/shared';
import type { Notifier, ResolvedTargetConfig } from '../../domain/notifiers.js';
import type { RenderedDigest } from '../../domain/renderers.js';

export type NotifierHttpRequest = {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type NotifierHttpResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type NotifierHttpClient = (request: NotifierHttpRequest) => Promise<NotifierHttpResponse>;

type TelegramNotifierOptions = {
  httpClient?: NotifierHttpClient;
  now?: () => string;
};

type MarkdownNotifierOptions = {
  write: (entry: { label: string; body: string }) => Promise<string>;
  now?: () => string;
};

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram';
  private readonly httpClient: NotifierHttpClient;
  private readonly now: () => string;

  constructor(options: TelegramNotifierOptions = {}) {
    this.httpClient = options.httpClient ?? fetchJson;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async test(target: ResolvedTargetConfig): Promise<TestResult> {
    const result = await this.postMessage(target, 'Home Assistant AI Digest test message.');
    if (result.status === 'sent') return { status: 'success', message: 'Telegram test message delivered.', checkedAt: this.now() };
    return { status: 'failed', message: result.message ?? 'Telegram test message failed.', checkedAt: this.now() };
  }

  async send(digest: RenderedDigest, target: ResolvedTargetConfig): Promise<DeliveryResult> {
    return this.postMessage(target, digest.body);
  }

  private async postMessage(target: ResolvedTargetConfig, text: string): Promise<DeliveryResult> {
    const botToken = requiredConfig(target, 'botToken');
    const chatId = requiredConfig(target, 'chatId');
    let response: NotifierHttpResponse;
    try {
      response = await this.httpClient({
        method: 'POST',
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body: {
          chat_id: chatId,
          text: escapeTelegramMarkdown(text),
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        }
      });
    } catch {
      return {
        status: 'failed',
        targetRef: targetRef(target),
        errorCode: 'TELEGRAM_REQUEST_FAILED',
        message: 'Telegram delivery failed before receiving a response.'
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        status: 'failed',
        targetRef: targetRef(target),
        errorCode: `TELEGRAM_HTTP_${response.status}`,
        message: `Telegram delivery failed with status ${response.status}`
      };
    }

    const payload = await response.json();
    if (!telegramOk(payload)) {
      return { status: 'failed', targetRef: targetRef(target), errorCode: 'TELEGRAM_REJECTED', message: 'Telegram rejected the message.' };
    }

    return { status: 'sent', targetRef: targetRef(target), deliveredAt: this.now() };
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
  return Boolean(asRecord(payload).ok);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function escapeTelegramMarkdown(value: string): string {
  return value.replace(/([_\-*\[\]()~`>#+=|{}.!\\])/g, '\\$1');
}

async function fetchJson(request: NotifierHttpRequest): Promise<NotifierHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body)
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}
