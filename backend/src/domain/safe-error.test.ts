import { describe, expect, it } from 'vitest';
import { redactProviderError } from './safe-error.js';

describe('redactProviderError', () => {
  it.each([
    ['Bearer bearer-fixture-value', 'bearer-fixture-value'],
    ['token=assignment-fixture-value', 'assignment-fixture-value'],
    ['token: colon-token-fixture-value', 'colon-token-fixture-value'],
    ['api_key=underscore-api-key-fixture-value', 'underscore-api-key-fixture-value'],
    ['access_token: colon-access-token-fixture-value', 'colon-access-token-fixture-value'],
    ['password=password-fixture-value', 'password-fixture-value'],
    ['secret: secret-fixture-value', 'secret-fixture-value'],
    ['botToken=123456:ABCdefGHIjklMNOpqr', '123456:ABCdefGHIjklMNOpqr'],
    ['bot_token: 987654:ZYXwvUTSrqponMLK', '987654:ZYXwvUTSrqponMLK'],
    ['https://provider.test/generate?token=query-fixture-value&access_token=query-access-fixture-value', 'query-fixture-value'],
    ['https://provider.test/generate?token=query-fixture-value&access_token=query-access-fixture-value', 'query-access-fixture-value']
  ])('redacts credential-shaped %s values while keeping useful provider context', (raw, secret) => {
    const safe = redactProviderError(`Gemini model retired; classification: unavailable; ${raw}`);

    expect(safe).toContain('Gemini model retired');
    expect(safe).toContain('classification: unavailable');
    expect(safe).not.toContain(secret);
    if (!raw.startsWith('https://')) expect(safe).toContain('[REDACTED]');
  });

  it('redacts Telegram-shaped tokens even when they are not assigned to a named key', () => {
    const safe = redactProviderError('Telegram delivery failed for 123456:ABCdefGHIjklMNOpqr while retrying the notification.');

    expect(safe).toContain('Telegram delivery failed');
    expect(safe).toContain('while retrying the notification');
    expect(safe).not.toContain('123456:ABCdefGHIjklMNOpqr');
  });

  it('redacts quoted and escaped JSON credential fields while preserving diagnostic context', () => {
    const safe = redactProviderError(
      'Provider payload failed: {"token":"json-token","api_key": "raw-api-key","botToken":"json-bot-token"}; retry the request. Escaped: {\\"token\\":\\"escaped-token\\"}',
    );

    expect(safe).toContain('Provider payload failed');
    expect(safe).toContain('"token":"[REDACTED]"');
    expect(safe).toContain('"api_key": "[REDACTED]"');
    expect(safe).toContain('"botToken":"[REDACTED]"');
    expect(safe).toContain('Escaped: {\\"token\\":\\"[REDACTED]\\"}');
    expect(safe).toContain('retry the request');
    expect(safe).not.toContain('json-token');
    expect(safe).not.toContain('raw-api-key');
    expect(safe).not.toContain('json-bot-token');
    expect(safe).not.toContain('escaped-token');
  });

  it('redacts Telegram bot tokens in URL paths without changing ordinary URLs', () => {
    const safe = redactProviderError(
      'Telegram request failed at https://api.telegram.org/bot123456:ABCdefGHIjklMNOpqr/sendMessage?chat_id=123; docs: https://provider.test/docs/reference.',
    );

    expect(safe).toContain('https://api.telegram.org/bot[REDACTED]/sendMessage?chat_id=123');
    expect(safe).toContain('https://provider.test/docs/reference');
    expect(safe).not.toContain('123456:ABCdefGHIjklMNOpqr');
  });

  it('does not redact timestamp-like identifiers without Telegram context', () => {
    const safe = redactProviderError('Correlation id 123456:20260812ABCDEF remains useful for diagnosis.');

    expect(safe).toContain('123456:20260812ABCDEF');
  });

  it('preserves ordinary diagnostic phrases that only mention token or API key concepts', () => {
    const safe = redactProviderError('The API key rotation is pending; token budget is 40%; retry the request.');

    expect(safe).toContain('The API key rotation is pending');
    expect(safe).toContain('token budget is 40%');
    expect(safe).toContain('retry the request');
  });
});
