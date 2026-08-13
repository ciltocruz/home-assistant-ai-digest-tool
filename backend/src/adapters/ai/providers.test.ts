import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedactedDigestInput } from '../../domain/providers.js';
import { createSignatureProvider, FakeAIProvider, GeminiProvider, OpenAIProvider } from './providers.js';

const OPENAI_TEST_KEY = 'openai-placeholder-key-for-tests';

const input: RedactedDigestInput = {
  window: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
  privacyLevel: 'balanced',
  incidents: [
    {
      id: 'ha:entity:sensor.kitchen:unavailable',
      type: 'entity',
      severity: 'warning',
      area: 'Kitchen',
      summary: 'sensor.kitchen is unavailable',
      redactedEvidence: ['state=unavailable', 'token=[REDACTED]'],
      detectedAt: '2026-07-02T00:00:00.000Z'
    }
  ],
  entityStats: { unavailableCount: 1 },
  notes: [{ id: 'note-1', text: 'Checked router; no secret included', occurredAt: '2026-07-01T12:00:00.000Z' }],
  unsupportedSignals: [{ source: 'supervisor', reason: 'Unsupported in Docker/Core mode' }],
  redactionReport: ['redacted:token']
};

describe('AI provider adapters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns deterministic fake digests for tests without network', async () => {
    const provider = new FakeAIProvider();

    await expect(provider.generate(input)).resolves.toEqual({
      severity: 'warning',
      summary: '1 incident needs attention for 2026-07-01T00:00:00.000Z → 2026-07-02T00:00:00.000Z.',
      attentionItems: [
        {
          title: 'sensor.kitchen is unavailable',
          severity: 'warning',
          detail: 'state=unavailable; token=[REDACTED]'
        }
      ]
    });
  });

  it('orders equivalent incidents deterministically before rendering local digest items', async () => {
    const provider = new FakeAIProvider();
    const reordered = { ...input, incidents: [...input.incidents, { ...input.incidents[0]!, id: 'a-incident', summary: 'A unavailable' }] };
    const digest = await provider.generate(reordered);
    expect(digest.attentionItems.map((item) => item.title)).toEqual(['A unavailable', 'sensor.kitchen is unavailable']);
  });

  it('posts OpenAI-compatible redacted payloads through an injected HTTP client', async () => {
    const requests: HttpRequest[] = [];
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      httpClient: async (request) => {
        requests.push(request);
        return { status: 200, json: async () => openAiResponse };
      }
    });

    const digest = await provider.generate(input);

    expect(digest.summary).toBe('Kitchen sensor is unavailable.');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${OPENAI_TEST_KEY}`);
    const body = JSON.stringify(requests[0]?.body);
    expect(body).toContain('sensor.kitchen is unavailable');
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain(OPENAI_TEST_KEY);
  });

  it('posts Gemini-compatible redacted payloads through an injected HTTP client', async () => {
    const requests: HttpRequest[] = [];
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      httpClient: async (request) => {
        requests.push(request);
        return { status: 200, json: async () => geminiResponse };
      }
    });

    const digest = await provider.generate(input);

    expect(digest.attentionItems[0]?.title).toBe('Kitchen sensor');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect(requests[0]?.url).toContain('key=gemini-test-secret');
    const body = JSON.stringify(requests[0]?.body);
    expect(body).toContain('redacted incident context');
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain('gemini-test-secret');
  });

  it('keeps an explicitly selected Gemini model instead of replacing it with the default', async () => {
    const requests: HttpRequest[] = [];
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      model: 'gemini-3.1-flash',
      httpClient: async (request) => { requests.push(request); return { status: 200, json: async () => geminiResponse }; }
    });

    await provider.generate(input);

    expect(requests[0]?.url).toContain('/models/gemini-3.1-flash:generateContent');
  });

  it('returns provider failures without exposing API keys or raw responses', async () => {
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      httpClient: async () => ({ status: 500, json: async () => ({ error: { message: `raw provider detail ${OPENAI_TEST_KEY}` } }) })
    });

    await expect(provider.generate(input)).rejects.toThrow("OpenAI 500: model 'gpt-4o-mini' failed (classification: other)");
    await expect(provider.generate(input)).rejects.toThrow('raw provider detail');
    await expect(provider.generate(input)).rejects.not.toThrow(OPENAI_TEST_KEY);
  });

  it('explains a retired Gemini model from the provider response', async () => {
    const retiredMessage = 'models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent.';
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      model: 'gemini-1.5-flash',
      httpClient: async () => ({ status: 404, json: async () => ({ error: { message: retiredMessage } }) })
    });

    const error = await provider.generate(input).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ provider: 'Gemini', model: 'gemini-1.5-flash', status: 404, classification: 'model retired' });
    expect((error as Error).message).toContain('Gemini 404');
    expect((error as Error).message).toContain("model 'gemini-1.5-flash'");
    expect((error as Error).message).toContain(retiredMessage);
    expect((error as Error).message).toContain('model retired');
    expect((error as Error).message).toContain('Update the model to gemini-flash-latest');
    expect((error as Error).message).not.toContain('gemini-test-secret');
  });

  it.each([
    [429, 'You exceeded your current quota.', 'quota'],
    [429, 'You exceeded your current quota; check your plan and billing details.', 'billing']
  ] as const)('classifies Gemini %s provider evidence as %s', async (status, providerMessage, classification) => {
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      model: 'gemini-3.6-flash',
      httpClient: async () => ({ status, json: async () => ({ error: { message: providerMessage } }) })
    });

    const error = await provider.generate(input).catch((value: unknown) => value);

    expect((error as Error).message).toContain(`Gemini 429: model 'gemini-3.6-flash' failed (classification: ${classification})`);
    expect((error as Error).message).toContain(providerMessage);
    expect((error as Error).message).not.toContain('gemini-test-secret');
  });

  it.each([
    [401, 'Incorrect API key provided.'],
    [403, 'The API key is not authorized for this resource.']
  ] as const)('classifies OpenAI %s authentication failures as invalid key', async (status, providerMessage) => {
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      model: 'gpt-test-model',
      httpClient: async () => ({ status, json: async () => ({ error: { message: providerMessage } }) })
    });

    const error = await provider.generate(input).catch((value: unknown) => value);

    expect((error as Error).message).toContain(`OpenAI ${status}: model 'gpt-test-model' failed (classification: invalid key)`);
    expect((error as Error).message).toContain(providerMessage);
    expect((error as Error).message).not.toContain(OPENAI_TEST_KEY);
  });

  it('returns safe errors when OpenAI returns malformed JSON content', async () => {
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      httpClient: async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: `{not-json ${OPENAI_TEST_KEY}` } }] })
      })
    });

    await expect(provider.generate(input)).rejects.toThrow('OpenAI provider returned an invalid digest');
    await expect(provider.generate(input)).rejects.not.toThrow(OPENAI_TEST_KEY);
  });

  it('returns safe errors when Gemini returns an invalid structured digest', async () => {
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      httpClient: async () => ({
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ severity: 'urgent', summary: 'bad shape', secret: 'gemini-test-secret' }) }] } }] })
      })
    });

    await expect(provider.generate(input)).rejects.toThrow('Gemini provider returned an invalid digest');
    await expect(provider.generate(input)).rejects.not.toThrow('gemini-test-secret');
  });

  it('keeps Gemini secret-bearing URLs out of request failure messages', async () => {
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      httpClient: async (request) => {
        throw new Error(`network failed for ${request.url}`);
      }
    });

    await expect(provider.generate(input)).rejects.toThrow("Gemini unavailable: model 'gemini-flash-latest' failed (classification: other)");
    await expect(provider.generate(input)).rejects.toThrow('network failed for');
    await expect(provider.generate(input)).rejects.not.toThrow('gemini-test-secret');
  });

  it('aborts OpenAI requests after the configured timeout through the injected HTTP boundary', async () => {
    vi.useFakeTimers();
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      timeoutMs: 25,
      httpClient: async (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error(`aborted ${OPENAI_TEST_KEY}`)), { once: true });
        })
    });

    const result = provider.generate(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("OpenAI unavailable: model 'gpt-4o-mini' failed (classification: timeout)");
    expect((error as Error).message).toContain('aborted');
    expect((error as Error).message).not.toContain(OPENAI_TEST_KEY);
  });

  it('aborts Gemini requests after the configured timeout through the injected HTTP boundary', async () => {
    vi.useFakeTimers();
    const provider = new GeminiProvider({
      apiKey: 'gemini-test-secret',
      timeoutMs: 25,
      httpClient: async (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted gemini-test-secret')), { once: true });
        })
    });

    const result = provider.generate(input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Gemini unavailable: model 'gemini-flash-latest' failed (classification: timeout)");
    expect((error as Error).message).toContain('aborted');
    expect((error as Error).message).not.toContain('gemini-test-secret');
  });

  it('propagates a parent analysis cancellation to the provider HTTP boundary without exposing its key', async () => {
    const controller = new AbortController();
    const provider = new OpenAIProvider({
      apiKey: OPENAI_TEST_KEY,
      httpClient: async (request) => new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error(OPENAI_TEST_KEY)), { once: true }))
    });
    const request = provider.generate(input, { signal: controller.signal, checkpoint: () => { if (controller.signal.aborted) throw controller.signal.reason; }, deadlineAtMs: Date.now() + 1_000, dispose: () => undefined });
    controller.abort(new Error('ANALYSIS_CANCELLED'));

    await expect(request).rejects.toThrow('ANALYSIS_CANCELLED');
    await expect(request).rejects.not.toThrow(OPENAI_TEST_KEY);
  });

  it.each([
    ['openai', 'https://fake.openai/v1/chat/completions', { choices: [{ message: { content: JSON.stringify({ summary: 'OpenAI summary', recommendation: 'Restart it' }) } }] }],
    ['gemini', 'https://fake.gemini/gemini-flash-latest:generateContent?key=provider-secret', { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Gemini summary', recommendation: 'Check it' }) }] } }] }],
    ['ollama', 'http://fake.ollama/api/chat', { message: { content: JSON.stringify({ summary: 'Ollama summary', recommendation: 'Inspect it' }) } }]
  ] as const)('uses bounded redacted per-signature %s requests', async (kind, url, response) => {
    const requests: HttpRequest[] = [];
    const provider = createSignatureProvider(kind, { apiKey: 'provider-secret', baseUrl: kind === 'openai' ? url : kind === 'gemini' ? 'https://fake.gemini' : 'http://fake.ollama', httpClient: async (request) => { requests.push(request); return { status: 200, json: async () => response }; } });

    const result = await provider.analyze({ signature: 'sig-1', component: 'mqtt', classification: 'new', occurrences: ['token=must-not-leak', 'short context'] }, new AbortController().signal);

    expect(result.summary).toContain(kind[0]!.toUpperCase());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(url);
    expect(JSON.stringify(requests[0]?.body)).toContain('[REDACTED]');
    expect(JSON.stringify(requests[0]?.body)).not.toContain('must-not-leak');
  });

  it('sanitizes credential-shaped content in structured signature output without losing diagnostics', async () => {
    const rawSecrets = [
      'signature-bearer-fixture',
      'signature-token-fixture',
      'signature-api-key-fixture',
      'signature-query-token-fixture',
      '123456:ABCdefGHIjklMNOpqr',
      '987654:ZYXwvUTSrqponMLK'
    ];
    const provider = createSignatureProvider('ollama', {
      apiKey: 'unused',
      httpClient: async () => ({
        status: 200,
        json: async () => ({ message: { content: JSON.stringify({
          summary: `Incident context: Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api_key=${rawSecrets[2]} https://provider.test/?token=${rawSecrets[3]} botToken=${rawSecrets[4]}. Token budget remains available.`,
          recommendation: `Restart the integration after checking bot_token: ${rawSecrets[5]}. Keep the API key rotation documented.`
        }) } })
      })
    });

    const result = await provider.analyze({ signature: 'sig', component: 'mqtt', classification: 'new', occurrences: [] }, new AbortController().signal);

    expect(result.summary).toContain('Incident context');
    expect(result.summary).toContain('Token budget remains available');
    expect(result.recommendation).toContain('Restart the integration');
    expect(result.recommendation).toContain('API key rotation documented');
    for (const secret of rawSecrets) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('redacts the configured key and credential-shaped values from every provider output path', async () => {
    const configuredKey = 'opaque-configured-key-9f3d7c2a';
    const rawSecrets = [configuredKey, 'opaque-bearer-fixture', 'opaque-token-fixture', '123456:ABCdefGHIjklMNOpqr'];
    const output = `Provider output ${configuredKey}; Bearer ${rawSecrets[1]} token=${rawSecrets[2]} Telegram bot ${rawSecrets[3]}`;
    const openAi = new OpenAIProvider({
      apiKey: configuredKey,
      httpClient: async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          severity: 'warning', summary: output,
          attentionItems: [{ title: output, severity: 'warning', detail: output }]
        }) } }] })
      })
    });
    const signature = createSignatureProvider('ollama', {
      apiKey: configuredKey,
      httpClient: async () => ({ status: 200, json: async () => ({ message: { content: JSON.stringify({ summary: output, recommendation: output }) } }) })
    });
    const gemini = new GeminiProvider({
      apiKey: configuredKey,
      httpClient: async () => ({
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          severity: 'warning', summary: output,
          attentionItems: [{ title: output, severity: 'warning', detail: output }]
        }) }] } }] })
      })
    });

    const digest = await openAi.generate(input);
    const geminiDigest = await gemini.generate(input);
    const analysis = await signature.analyze({ signature: 'sig', component: 'mqtt', classification: 'new', occurrences: [] }, new AbortController().signal);

    for (const value of [digest, geminiDigest, analysis]) {
      for (const secret of rawSecrets) expect(JSON.stringify(value)).not.toContain(secret);
    }
  });

  it('allowlists public provider output fields while sanitizing configured keys in analysis text', async () => {
    const configuredKey = 'opaque-configured-key-allowlist-fixture';
    const leakedText = `Provider output ${configuredKey}`;
    const openAi = new OpenAIProvider({
      apiKey: configuredKey,
      httpClient: async () => ({
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          severity: 'warning',
          summary: leakedText,
          attentionItems: [{ title: leakedText, severity: 'warning', detail: leakedText, providerControlled: configuredKey }],
          providerControlled: configuredKey
        }) } }] })
      })
    });
    const signature = createSignatureProvider('ollama', {
      apiKey: configuredKey,
      httpClient: async () => ({
        status: 200,
        json: async () => ({ message: { content: JSON.stringify({ summary: leakedText, recommendation: leakedText, providerControlled: configuredKey }) } })
      })
    });

    await expect(openAi.generate(input)).resolves.toEqual({
      severity: 'warning',
      summary: 'Provider output [REDACTED]',
      attentionItems: [{ title: 'Provider output [REDACTED]', severity: 'warning', detail: 'Provider output [REDACTED]' }]
    });
    await expect(signature.analyze({ signature: 'sig', component: 'mqtt', classification: 'new', occurrences: [] }, new AbortController().signal)).resolves.toEqual({
      summary: 'Provider output [REDACTED]',
      recommendation: 'Provider output [REDACTED]'
    });
  });

  it('returns safe Ollama HTTP and malformed-response failures', async () => {
    const statusFailure = createSignatureProvider('ollama', { apiKey: 'unused', httpClient: async () => ({ status: 500, json: async () => ({ secret: 'ollama-secret' }) }) });
    const malformed = createSignatureProvider('ollama', { apiKey: 'unused', httpClient: async () => ({ status: 200, json: async () => ({ message: { content: 'not-json ollama-secret' } }) }) });
    const context = { signature: 'sig', component: 'mqtt', classification: 'new' as const, occurrences: [] };

    await expect(statusFailure.analyze(context, new AbortController().signal)).rejects.toThrow("Ollama 500: model 'llama3.2' failed (classification: other)");
    await expect(statusFailure.analyze(context, new AbortController().signal)).rejects.not.toThrow('ollama-secret');
    await expect(malformed.analyze(context, new AbortController().signal)).rejects.toThrow('Ollama provider returned an invalid signature analysis');
  });

  it('returns a safe Ollama timeout failure', async () => {
    vi.useFakeTimers();
    const provider = createSignatureProvider('ollama', { apiKey: 'unused', timeoutMs: 25, httpClient: async (request) => new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('ollama-secret')), { once: true })) });
    const result = provider.analyze({ signature: 'sig', component: 'mqtt', classification: 'new', occurrences: [] }, new AbortController().signal);
    const assertion = expect(result).rejects.toThrow("Ollama unavailable: model 'llama3.2' failed (classification: timeout)");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});

type HttpRequest = { url: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal };

const openAiResponse = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          severity: 'warning',
          summary: 'Kitchen sensor is unavailable.',
          attentionItems: [{ title: 'Kitchen sensor', severity: 'warning', detail: 'Check Home Assistant entity availability.' }]
        })
      }
    }
  ]
};

const geminiResponse = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              severity: 'warning',
              summary: 'Kitchen sensor is unavailable.',
              attentionItems: [{ title: 'Kitchen sensor', severity: 'warning', detail: 'Check Home Assistant entity availability.' }]
            })
          }
        ]
      }
    }
  ]
};
