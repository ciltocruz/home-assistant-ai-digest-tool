import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HomeAssistantLogDeltaReader } from './log-reader.js';

async function mountedLog() {
  const directory = await mkdtemp(join(tmpdir(), 'ha-batch-log-'));
  const path = join(directory, 'home-assistant.log');
  return { path, reader: new HomeAssistantLogDeltaReader({ path }) };
}

describe('HomeAssistantLogDeltaReader', () => {
  it('advances byte cursors only through complete UTF-8 lines', async () => {
    const { path, reader } = await mountedLog();
    const source = Buffer.from('first\nsecond café\n');
    const partialUtf8At = Buffer.byteLength('first\nsecond caf') + 1;
    await writeFile(path, source.subarray(0, partialUtf8At));

    const first = await reader.read(null);
    await writeFile(path, source.subarray(partialUtf8At), { flag: 'a' });
    const second = await reader.read(first.cursor);

    expect(first.lines).toEqual(['first']);
    expect(second.lines).toEqual(['second café']);
    expect(second.cursor.offset).toBe(Buffer.byteLength('first\nsecond café\n'));
  });

  it('safely restarts after truncation and replacement', async () => {
    const { path, reader } = await mountedLog();
    await writeFile(path, 'original line\n');
    const original = await reader.read(null);
    await writeFile(path, 'short\n');
    const truncated = await reader.read(original.cursor);
    const replacement = join(tmpdir(), `ha-replacement-${Date.now()}.log`);
    await writeFile(replacement, 'replacement\n');
    await rename(replacement, path);
    const replaced = await reader.read(truncated.cursor);

    expect(truncated).toMatchObject({ lines: ['short'], recovery: 'truncated', cursor: { offset: 6 } });
    expect(replaced).toMatchObject({ lines: ['replacement'], recovery: 'replaced', cursor: { offset: 12 } });
  });

  it('rejects rotated-file paths instead of reading history outside the mounted log', async () => {
    const path = join(tmpdir(), 'home-assistant.log.1');
    await writeFile(path, 'rotated\n');
    await expect(new HomeAssistantLogDeltaReader({ path }).read(null)).rejects.toThrow('HA_LOG_ROTATION_UNSUPPORTED');
  });
});
