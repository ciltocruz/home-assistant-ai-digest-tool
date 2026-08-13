import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OperationalFailureEvent } from './http/app.js';
import type { BatchOperationalEvent } from './application/batch-report-run.js';
import type { DigestWorkerEvent } from './application/digest-worker.js';

export type RuntimeLogSink = {
  ensureDir(path: string): void;
  append(path: string, content: string): void;
  rename(from: string, to: string): void;
  size(path: string): number;
};

export type RuntimeFailureLoggerOptions = {
  dataDir?: string;
  logDir?: string;
  maxBytes?: number;
  now?: () => string;
  sink?: RuntimeLogSink;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
};

export type RuntimeStartupFailureEvent = {
  event: 'runtime_startup_failure';
  reason: 'runtime_startup_failed';
  errorName: 'Error' | 'TypeError';
};

export type RuntimeDigestFailureEvent = {
  jobId: string;
  stage: 'provider' | 'source' | 'processing' | 'storage';
  errorCode: string;
  errorMessage: string;
};

export type RuntimeLogger = {
  reportApiFailure(event: OperationalFailureEvent): void;
  reportDigestFailure(event: RuntimeDigestFailureEvent): void;
  reportStartupFailure(event: RuntimeStartupFailureEvent): void;
  reportOperational(event: RuntimeOperationalEvent): void;
};

type RuntimeLogEvent = ({ event: 'runtime_api_failure' } & Omit<OperationalFailureEvent, 'url'>) | (RuntimeDigestFailureEvent & { event: 'runtime_digest_failure' }) | RuntimeStartupFailureEvent;
export type RuntimeOperationalEvent =
  | { event: 'runtime_starting' | 'runtime_listening' | 'runtime_ready' | 'runtime_shutdown' }
  | { event: 'runtime_fatal'; reason: 'runtime_startup_failed' }
  | BatchOperationalEvent
  | DigestWorkerEvent;

const DEFAULT_MAX_BYTES = 256 * 1024;

const fileSink: RuntimeLogSink = {
  ensureDir(path) { mkdirSync(path, { recursive: true }); },
  append(path, content) { appendFileSync(path, content, 'utf8'); },
  rename(from, to) { renameSync(from, to); },
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }
};

export function createRuntimeLogger(options: RuntimeFailureLoggerOptions = {}): RuntimeLogger {
  const logDir = resolve(options.logDir ?? join(options.dataDir ?? '/data', 'logs'));
  const logPath = join(logDir, 'runtime.log');
  const rotatedPath = join(logDir, 'runtime.log.1');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => new Date().toISOString());
  const sink = options.sink ?? fileSink;
  const stderr = options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  const stdout = options.stdout ?? ((message) => process.stdout.write(`${message}\n`));

  const write = (event: RuntimeLogEvent) => {
    const entry = { level: 'error', createdAt: now(), ...event };
    const line = boundedLogLine(entry, maxBytes);
    try {
      sink.ensureDir(logDir);
      const currentSize = sink.size(logPath);
      if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > maxBytes) sink.rename(logPath, rotatedPath);
      sink.append(logPath, line);
    } catch {
      stderr(JSON.stringify({ ...entry, persistentLogStatus: 'failed' }));
    }
  };

  return {
    reportApiFailure(event) {
      write({ event: 'runtime_api_failure', requestId: event.requestId, method: event.method, statusCode: event.statusCode, code: event.code, errorName: event.errorName });
    },
    reportDigestFailure(event) {
      write({ event: 'runtime_digest_failure', jobId: event.jobId, stage: event.stage, errorCode: event.errorCode, errorMessage: 'See report diagnostics for safe recovery guidance.' });
    },
    reportStartupFailure(event) {
      write(event);
    },
    reportOperational(event) {
      const projected = projectOperationalEvent(event);
      if (!projected) return;
      const level = operationalLevel(projected);
      try { stdout(JSON.stringify({ level, createdAt: now(), ...projected })); } catch { /* Stdout failure must never affect runtime behavior. */ }
    }
  };
}

function projectOperationalEvent(event: RuntimeOperationalEvent): RuntimeOperationalEvent | undefined {
  switch (event.event) {
    case 'runtime_starting':
    case 'runtime_listening':
    case 'runtime_ready':
    case 'runtime_shutdown':
    case 'report_collection_failed':
    case 'report_commit_failed':
    case 'telegram_delivery_started':
      return { event: event.event };
    case 'runtime_fatal':
      return { event: event.event, reason: event.reason };
    case 'report_collection_completed':
      return { event: event.event, lineCount: event.lineCount, signatureCount: event.signatureCount, durationMs: event.durationMs };
    case 'report_analysis_completed':
      return { event: event.event, analyzedCount: event.analyzedCount, failedCount: event.failedCount, durationMs: event.durationMs };
    case 'report_commit_completed':
      return { event: event.event, reportId: event.reportId, status: event.status, signatureCount: event.signatureCount };
    case 'ha_snapshot_completed':
      return { event: event.event, integrationCount: event.integrationCount, durationMs: event.durationMs };
    case 'ha_snapshot_failed':
      return { event: event.event, reason: event.reason, durationMs: event.durationMs };
    case 'telegram_delivery_completed':
      return { event: event.event, outcome: event.outcome, ...(event.errorCode ? { errorCode: event.errorCode } : {}), durationMs: event.durationMs };
    case 'job_started':
    case 'job_retry':
      return { event: event.event, jobId: event.jobId, retryCount: event.retryCount };
    case 'job_stage':
      return { event: event.event, jobId: event.jobId, stage: event.stage };
    case 'job_completed':
      return { event: event.event, jobId: event.jobId, reportId: event.reportId };
    case 'job_failed':
      return { event: event.event, jobId: event.jobId, errorCode: event.errorCode };
    default:
      return undefined;
  }
}

function operationalLevel(event: RuntimeOperationalEvent): 'info' | 'warn' | 'error' {
  if (event.event === 'runtime_fatal' || event.event === 'job_failed' || event.event === 'report_collection_failed' || event.event === 'report_commit_failed') return 'error';
  if (event.event === 'ha_snapshot_failed' || event.event === 'telegram_delivery_completed' && event.outcome === 'failed') return 'warn';
  return 'info';
}

export function createRuntimeFailureLogger(options: RuntimeFailureLoggerOptions = {}): (event: OperationalFailureEvent) => void {
  return createRuntimeLogger(options).reportApiFailure;
}

function boundedLogLine(entry: object, maxBytes: number): string {
  const line = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line;

  const fallback = `${JSON.stringify({ level: 'error', event: 'runtime_log_entry_truncated' })}\n`;
  return Buffer.byteLength(fallback, 'utf8') <= maxBytes ? fallback : '\n';
}
