import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeFailureLogger, createRuntimeLogger, type RuntimeLogSink } from './runtime-logging.js';

describe('runtime failure logger', () => {
  it('writes secret-safe operational failure events to a JSONL log file under /data logs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-logs-'));
    const reporter = createRuntimeFailureLogger({ dataDir, now: () => '2026-07-15T10:00:00.000Z' });

    await reporter({
      requestId: 'request-1',
      method: 'GET',
      url: '/api/settings',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      errorName: 'Error'
    });

    const log = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8');

    expect(log).toContain('"event":"runtime_api_failure"');
    expect(log).toContain('"url":"/api/settings"');
    expect(log).toContain('"createdAt":"2026-07-15T10:00:00.000Z"');
    expect(log).not.toContain('token');
    expect(log).not.toContain('secret');
  });

  it('writes detailed secret-safe AI provider failures for digest jobs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-ai-logs-'));
    const logger = createRuntimeLogger({ dataDir, now: () => '2026-07-15T10:00:00.000Z' });

    logger.reportDigestFailure({
      jobId: 'job-1',
      stage: 'provider',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      errorMessage: "Gemini 404: model 'gemini-1.5-flash' no longer exists (retired; classification: model retired). Provider message: models/gemini-1.5-flash is not found. key=super-secret"
    });

    const log = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8');

    expect(log).toContain('"event":"runtime_digest_failure"');
    expect(log).toContain('Gemini 404');
    expect(log).toContain('model retired');
    expect(log).not.toContain('super-secret');
  });

  it('uses the shared redactor for quoted and Telegram-shaped provider failures', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-shared-redactor-'));
    const logger = createRuntimeLogger({ dataDir, now: () => '2026-07-15T10:00:00.000Z' });
    const telegramToken = '123456:ABCdefGHIjklMNOpqr';

    logger.reportDigestFailure({
      jobId: 'job-quoted',
      stage: 'provider',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      errorMessage: `provider response {"apiKey":"runtime-json-secret"} Telegram bot ${telegramToken}`
    });

    const log = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8');

    expect(log).not.toContain('runtime-json-secret');
    expect(log).not.toContain(telegramToken);
  });

  it('falls back to stderr when persistent logging fails without leaking sensitive error details', async () => {
    const stderrMessages: string[] = [];
    const failingSink: RuntimeLogSink = {
      ensureDir() { throw new Error('disk full includes sentinel-secret-value'); },
      append() { throw new Error('should not append'); },
      rename() { throw new Error('should not rotate'); },
      size() { return 0; }
    };
    const reporter = createRuntimeFailureLogger({ sink: failingSink, stderr: (message) => stderrMessages.push(message), now: () => '2026-07-15T10:00:00.000Z' });

    reporter({ requestId: 'request-1', method: 'GET', url: '/api/settings', statusCode: 500, code: 'INTERNAL_ERROR', errorName: 'Error' });

    expect(stderrMessages).toHaveLength(1);
    expect(stderrMessages[0]).toContain('"event":"runtime_api_failure"');
    expect(stderrMessages[0]).toContain('"persistentLogStatus":"failed"');
    expect(stderrMessages[0]).not.toContain('sentinel-secret-value');
    expect(stderrMessages[0]).not.toContain('disk full');
  });

  it('writes secret-safe startup failures before the app is constructed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-startup-log-'));
    const logger = createRuntimeLogger({ dataDir, now: () => '2026-07-15T10:00:00.000Z' });

    logger.reportStartupFailure({
      event: 'runtime_startup_failure',
      reason: 'runtime_startup_failed',
      errorName: 'Error'
    });

    const log = await readFile(join(dataDir, 'logs', 'runtime.log'), 'utf8');

    expect(log).toContain('"event":"runtime_startup_failure"');
    expect(log).toContain('"reason":"runtime_startup_failed"');
    expect(log).not.toContain('sentinel-secret-value');
    expect(log).not.toContain('TRUST_PROXY');
  });

  it('rotates the runtime log deterministically before appending beyond the size limit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-rotate-'));
    const runtimeLog = join(dataDir, 'logs', 'runtime.log');
    await mkdir(join(dataDir, 'logs'), { recursive: true });
    await writeFile(runtimeLog, `${'x'.repeat(280)}\n`, 'utf8');
    const reporter = createRuntimeFailureLogger({ dataDir, maxBytes: 256, now: () => '2026-07-15T10:00:00.000Z' });

    reporter({ requestId: 'request-1', method: 'GET', url: '/api/settings', statusCode: 500, code: 'INTERNAL_ERROR', errorName: 'Error' });

    const rotated = await readFile(join(dataDir, 'logs', 'runtime.log.1'), 'utf8');
    const current = await readFile(runtimeLog, 'utf8');

    expect(rotated).toContain('xxx');
    expect(current).toContain('"requestId":"request-1"');
    expect(current).not.toContain('xxx');
  });

  it('keeps only the current runtime log and one rotation generation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-rotation-limit-'));
    const logsDir = join(dataDir, 'logs');
    const runtimeLog = join(logsDir, 'runtime.log');
    await mkdir(logsDir, { recursive: true });
    const logger = createRuntimeLogger({ dataDir, maxBytes: 100, now: () => '2026-07-15T10:00:00.000Z' });

    await writeFile(runtimeLog, `${'x'.repeat(120)}\n`, 'utf8');
    logger.reportStartupFailure({ event: 'runtime_startup_failure', reason: 'runtime_startup_failed', errorName: 'Error' });
    await writeFile(runtimeLog, `${'y'.repeat(120)}\n`, 'utf8');
    logger.reportStartupFailure({ event: 'runtime_startup_failure', reason: 'runtime_startup_failed', errorName: 'Error' });

    expect((await readdir(logsDir)).sort()).toEqual(['runtime.log', 'runtime.log.1']);
  });
});
