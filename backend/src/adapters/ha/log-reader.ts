import { basename } from 'node:path';
import { open } from 'node:fs/promises';
import type { HomeAssistantLogReader } from './home-assistant.js';
import type { ExecutionContext } from '../../domain/execution.js';
import type { LogCursor, LogDelta } from '../../domain/batch.js';

export type HomeAssistantLogTailReaderOptions = { path: string; maxBytes?: number; maxLines?: number };

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 200;

export class HomeAssistantLogTailReader implements HomeAssistantLogReader {
  constructor(private readonly options: HomeAssistantLogTailReaderOptions) {}

  async readLogLines(context?: ExecutionContext): Promise<string[]> {
    context?.checkpoint();
    try {
      const handle = await open(this.options.path, 'r');
      try {
        const info = await handle.stat();
        context?.checkpoint();
        const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
        const size = Math.min(info.size, maxBytes);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, Math.max(0, info.size - size));
        context?.checkpoint();
        const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
        return lines.slice(-(this.options.maxLines ?? DEFAULT_MAX_LINES));
      } finally { await handle.close(); }
    } catch (error) {
      if (context?.signal.aborted) context.checkpoint();
      throw error instanceof Error && /^ANALYSIS_/.test(error.message) ? error : new Error('HA_LOG_UNAVAILABLE');
    }
  }
}

export type HomeAssistantLogDeltaReaderOptions = { path: string };

export class HomeAssistantLogDeltaReader {
  constructor(private readonly options: HomeAssistantLogDeltaReaderOptions) {}

  async read(cursor: LogCursor | null, context?: ExecutionContext): Promise<LogDelta> {
    if (basename(this.options.path) !== 'home-assistant.log') throw new Error('HA_LOG_ROTATION_UNSUPPORTED');
    context?.checkpoint();
    try {
      const handle = await open(this.options.path, 'r');
      try {
        const info = await handle.stat();
        const identity = { dev: Number(info.dev), ino: Number(info.ino), size: info.size };
        const recovery = cursor && (cursor.dev !== identity.dev || cursor.ino !== identity.ino)
          ? 'replaced'
          : cursor && info.size < cursor.offset ? 'truncated'
            : undefined;
        const offset = recovery || !cursor ? 0 : cursor.offset;
        const bytes = info.size - offset;
        const buffer = Buffer.alloc(bytes);
        if (bytes > 0) await handle.read(buffer, 0, bytes, offset);
        context?.checkpoint();
        const completeAt = buffer.lastIndexOf(0x0a);
        const complete = completeAt < 0 ? Buffer.alloc(0) : buffer.subarray(0, completeAt + 1);
        const lines = complete.toString('utf8').split(/\r?\n/).filter(Boolean);
        return { lines, cursor: { ...identity, offset: offset + complete.length }, ...(recovery ? { recovery } : {}) };
      } finally { await handle.close(); }
    } catch (error) {
      if (context?.signal.aborted) context.checkpoint();
      throw error instanceof Error && /^ANALYSIS_/.test(error.message) ? error : new Error('HA_LOG_UNAVAILABLE');
    }
  }
}
