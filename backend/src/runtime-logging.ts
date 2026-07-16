import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OperationalFailureEvent } from './http/app.js';

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
};

export type RuntimeStartupFailureEvent = {
  event: 'runtime_startup_failure';
  reason: 'runtime_startup_failed';
  errorName: 'Error' | 'TypeError';
};

export type RuntimeLogger = {
  reportApiFailure(event: OperationalFailureEvent): void;
  reportStartupFailure(event: RuntimeStartupFailureEvent): void;
};

type RuntimeLogEvent = (OperationalFailureEvent & { event: 'runtime_api_failure' }) | RuntimeStartupFailureEvent;

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
      write({ event: 'runtime_api_failure', ...event });
    },
    reportStartupFailure(event) {
      write(event);
    }
  };
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
