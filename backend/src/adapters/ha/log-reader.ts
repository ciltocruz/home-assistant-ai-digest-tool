import { open } from 'node:fs/promises';
import type { HomeAssistantLogReader } from './home-assistant.js';
import type { ExecutionContext } from '../../domain/execution.js';

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
