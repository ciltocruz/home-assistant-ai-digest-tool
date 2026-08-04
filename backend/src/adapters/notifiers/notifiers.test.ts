import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderedDigest } from '../../domain/renderers.js';
import { MarkdownNotifier, TelegramNotifier } from './notifiers.js';

const digest: RenderedDigest = {
  format: 'markdown',
  body: '# Home Assistant Digest\n\nKitchen sensor needs attention.'
};

const TELEGRAM_BOT_TOKEN_SENTINEL = 'telegram-bot-token-sentinel';

describe('notifier adapters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores markdown reports through an injected sink', async () => {
    const writes: Array<{ label: string; body: string }> = [];
    const notifier = new MarkdownNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      write: async (entry) => {
        writes.push(entry);
        return 'report-1.md';
      }
    });

    const result = await notifier.send(digest, { channel: 'markdown', label: 'Local report', config: {} });

    expect(result).toEqual({ status: 'sent', targetRef: 'markdown:Local report', deliveredAt: '2026-07-02T00:00:00.000Z', message: 'report-1.md' });
    expect(writes).toEqual([{ label: 'Local report', body: digest.body }]);
  });

  it('verifies markdown test-send by writing to the injected sink', async () => {
    const writes: Array<{ label: string; body: string }> = [];
    const notifier = new MarkdownNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      write: async (entry) => {
        writes.push(entry);
        return 'test-report.md';
      }
    });

    await expect(notifier.test({ channel: 'markdown', label: 'Local report', config: {} })).resolves.toEqual({
      status: 'success',
      message: 'Markdown target Local report is writable.',
      checkedAt: '2026-07-02T00:00:00.000Z'
    });
    expect(writes).toEqual([{ label: 'Local report', body: expect.stringContaining('Home Assistant AI Digest test message') }]);
  });

  it('returns actionable markdown test failures without exposing sink errors', async () => {
    const notifier = new MarkdownNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      write: async () => {
        throw new Error('EACCES /tmp/reports secret-token-value');
      }
    });

    const result = await notifier.test({ channel: 'markdown', label: 'Local report', config: {} });

    expect(result).toEqual({
      status: 'failed',
      message: 'Markdown target Local report is not writable. Check the configured output path and permissions.',
      checkedAt: '2026-07-02T00:00:00.000Z'
    });
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });

  it('sends Telegram test and digest messages through an injected HTTP client', async () => {
    const requests: HttpRequest[] = [];
    const notifier = new TelegramNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      httpClient: async (request) => {
        requests.push(request);
        return { status: 200, json: async () => ({ ok: true, result: { message_id: 10 } }) };
      }
    });

    const target = { channel: 'telegram' as const, label: 'Telegram', config: { botToken: TELEGRAM_BOT_TOKEN_SENTINEL, chatId: '4242' } };

    await expect(notifier.test(target)).resolves.toEqual({ status: 'success', message: 'Telegram test message delivered.', checkedAt: '2026-07-02T00:00:00.000Z' });
    await expect(notifier.send(digest, target)).resolves.toEqual({ status: 'sent', targetRef: 'telegram:Telegram', deliveredAt: '2026-07-02T00:00:00.000Z' });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_SENTINEL}/sendMessage`);
    expect(requests[0]?.body).toMatchObject({ chat_id: '4242', parse_mode: 'MarkdownV2' });
    expect(requests[1]?.body).toMatchObject({ text: expect.stringContaining('Kitchen sensor') });
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(TELEGRAM_BOT_TOKEN_SENTINEL);
  });

  it('returns Telegram failures without exposing bot tokens', async () => {
    const notifier = new TelegramNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      httpClient: async () => ({ status: 401, json: async () => ({ ok: false, description: `Unauthorized ${TELEGRAM_BOT_TOKEN_SENTINEL}` }) })
    });

    const result = await notifier.send(digest, { channel: 'telegram', label: 'Telegram', config: { botToken: TELEGRAM_BOT_TOKEN_SENTINEL, chatId: '4242' } });

    expect(result).toEqual({ status: 'failed', targetRef: 'telegram:Telegram', errorCode: 'TELEGRAM_HTTP_401', message: 'Telegram delivery failed with status 401' });
    expect(JSON.stringify(result)).not.toContain(TELEGRAM_BOT_TOKEN_SENTINEL);
  });

  it('keeps Telegram secret-bearing URLs out of delivery failure messages', async () => {
    const notifier = new TelegramNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      httpClient: async (request) => {
        throw new Error(`network failed for ${request.url}`);
      }
    });

    await expect(notifier.send(digest, { channel: 'telegram', label: 'Telegram', config: { botToken: TELEGRAM_BOT_TOKEN_SENTINEL, chatId: '4242' } })).resolves.toEqual({
      status: 'failed',
      targetRef: 'telegram:Telegram',
      errorCode: 'TELEGRAM_REQUEST_FAILED',
      message: 'Telegram delivery failed before receiving a response.'
    });
  });

  it('aborts Telegram requests after the configured timeout through the injected HTTP boundary', async () => {
    vi.useFakeTimers();
    const notifier = new TelegramNotifier({
      now: () => '2026-07-02T00:00:00.000Z',
      timeoutMs: 25,
      httpClient: async (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error(`aborted ${request.url}`)), { once: true });
        })
    });

    const result = notifier.send(digest, { channel: 'telegram', label: 'Telegram', config: { botToken: TELEGRAM_BOT_TOKEN_SENTINEL, chatId: '4242' } });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({
      status: 'failed',
      targetRef: 'telegram:Telegram',
      errorCode: 'TELEGRAM_REQUEST_FAILED',
      message: 'Telegram delivery failed before receiving a response.'
    });
  });

  it('sends a compact linked summary only when a batch has noteworthy findings', async () => {
    const requests: HttpRequest[] = [];
    const notifier = new TelegramNotifier({ now: () => '2026-07-02T00:00:00.000Z', httpClient: async (request) => { requests.push(request); return { status: 200, json: async () => ({ ok: true }) }; } });
    const target = { channel: 'telegram' as const, label: 'Telegram', config: { botToken: TELEGRAM_BOT_TOKEN_SENTINEL, chatId: '4242' } };

    await expect(notifier.sendSummary({ findings: [], reportUrl: 'https://digest.local/reports/r1' }, target)).resolves.toMatchObject({ status: 'skipped' });
    await expect(notifier.sendSummary({ findings: [{ signature: 'sig', analysis: { summary: 'MQTT failed', recommendation: 'Restart MQTT' } }], reportUrl: 'https://digest.local/reports/r1' }, target)).resolves.toMatchObject({ status: 'sent' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ text: expect.stringContaining('Open report') });
    expect(JSON.stringify(requests[0]?.body)).not.toContain(TELEGRAM_BOT_TOKEN_SENTINEL);
  });
});

type HttpRequest = { url: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal };
