import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alignToLineStart } from './log-cursor.js';

const mock = vi.hoisted(() => {
  class FakeDb {
    readonly runs: Array<{ sql: string; params: unknown[] }> = [];
    private readonly getResults = new Map<string, unknown>();
    constructor(public readonly path: string) {
      for (const [sql, value] of configuredGetResults) this.getResults.set(sql, value);
    }
    prepare(sql: string) {
      return {
        get: () => this.getResults.get(sql),
        run: (...params: unknown[]) => {
          this.runs.push({ sql, params });
          return { changes: 1 };
        },
        all: () => [] as unknown[]
      };
    }
    close(): void { /* no-op fake */ }
  }
  const configuredGetResults = new Map<string, unknown>();
  return {
    FakeDb,
    configuredGetResults,
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    runMigrations: vi.fn(),
    instance: null as FakeDb | null
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: mock.statSync, readFileSync: mock.readFileSync };
});

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: () => (moduleId: string) => ({
      DatabaseSync: function DatabaseSync(path: string) {
        mock.instance = new mock.FakeDb(path);
        return mock.instance;
      }
    })
  };
});

vi.mock('../adapters/persistence/migrations.js', () => ({ runMigrations: mock.runMigrations }));

const CURSOR_SELECT = 'select dev, ino, size, offset from v2_log_cursor where singleton = 1';
const UPSERT_SQL = 'insert into v2_log_cursor(singleton, dev, ino, size, offset, updated_at) values (1, ?, ?, ?, ?, ?) on conflict(singleton) do update set dev=excluded.dev, ino=excluded.ino, size=excluded.size, offset=excluded.offset, updated_at=excluded.updated_at';
const RESET_SQL = 'delete from v2_log_cursor where singleton = 1';
const SIGNATURES_COUNT_SQL = 'select count(*) as count from v2_signatures';
const SIGNATURES_DELETE_SQL = 'delete from v2_signatures';

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

const originalArgv = process.argv;
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mock.instance = null;
  mock.configuredGetResults.clear();
  mock.statSync.mockReturnValue({ dev: 1, ino: 2, size: 100 });
  mock.readFileSync.mockReturnValue(Buffer.from('line one\nline two\n'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit-call'); }) as typeof process.exit);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.argv = originalArgv;
  process.env = { ...originalEnv };
});

async function runCli(args: string[], env: Record<string, string> = {}, getResults: Record<string, unknown> = {}): Promise<InstanceType<typeof mock.FakeDb>> {
  for (const [sql, value] of Object.entries(getResults)) mock.configuredGetResults.set(sql, value);
  process.argv = [originalArgv[0], fileURLToPath(new URL('./log-cursor.ts', import.meta.url)), ...args];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  await import('./log-cursor.js');
  return mock.instance as InstanceType<typeof mock.FakeDb>;
}

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
}

describe('alignToLineStart', () => {
  it('keeps offsets at the buffer start and end untouched', () => {
    const buffer = Buffer.from('line one\nline two\n');
    expect(alignToLineStart(buffer, 0)).toBe(0);
    expect(alignToLineStart(buffer, buffer.length)).toBe(buffer.length);
  });

  it('advances an offset inside a line to the next line start', () => {
    const buffer = Buffer.from('line one\nline two\n');
    expect(alignToLineStart(buffer, 5)).toBe(9);
  });

  it('returns the buffer end when the offset is past the final newline', () => {
    const buffer = Buffer.from('line one\n');
    expect(alignToLineStart(buffer, 9)).toBe(9);
  });
});

describe('log-cursor CLI', () => {
  it('prints the stored cursor and the delta for the current log file', async () => {
    await runCli(['status'], {}, { [CURSOR_SELECT]: { dev: 1, ino: 2, size: 100, offset: 40 } });

    expect(output(logSpy)).toContain('cursor:');
    expect(output(logSpy)).toContain('dev: 1');
    expect(output(logSpy)).toContain('ino: 2');
    expect(output(logSpy)).toContain('offset: 40');
    expect(output(logSpy)).toContain('log file: /ha-logs/home-assistant.log');
    expect(output(logSpy)).toContain('next run: delta = 60 bytes from offset 40');
  });

  it('reports a missing cursor row as a fresh read from offset 0', async () => {
    await runCli(['status']);
    expect(output(logSpy)).toContain('no cursor row (next read starts at offset 0)');
    expect(output(logSpy)).toContain('next run: delta = 100 bytes from offset 0');
  });

  it('reports an unreadable log file and the failing next run', async () => {
    mock.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    await runCli(['status']);
    expect(output(logSpy)).toContain('cannot be stat\'ed');
    expect(output(logSpy)).toContain('the run will fail with HA_LOG_UNAVAILABLE');
  });

  it('flags recovery pending when the log file identity changed', async () => {
    await runCli(['status'], {}, { [CURSOR_SELECT]: { dev: 9, ino: 2, size: 100, offset: 40 } });
    expect(output(logSpy)).toContain('recovery pending (log file identity changed)');
  });

  it('flags recovery pending when the log file was truncated', async () => {
    await runCli(['status'], {}, { [CURSOR_SELECT]: { dev: 1, ino: 2, size: 100, offset: 500 } });
    expect(output(logSpy)).toContain('recovery pending (log file truncated)');
  });

  it('honors HA_LOG_FILE and DATA_DIR environment defaults', async () => {
    const db = await runCli(['status'], { HA_LOG_FILE: '/custom/home-assistant.log', DATA_DIR: '/custom-data' });
    expect(output(logSpy)).toContain('log file: /custom/home-assistant.log');
    expect(db.path).toBe('/custom-data/app.db');
  });

  it('resets the cursor for a full re-read', async () => {
    const db = await runCli(['reset']);
    expect(db.runs.some((run) => run.sql === RESET_SQL)).toBe(true);
    expect(output(logSpy)).toContain('cursor reset: the next run re-reads the whole current log file');
  });

  it('moves the cursor to the end of the current log file', async () => {
    const db = await runCli(['to-end']);
    const upsert = db.runs.find((run) => run.sql === UPSERT_SQL);
    expect(upsert?.params.slice(0, 4)).toEqual([1, 2, 100, 100]);
    expect(output(logSpy)).toContain('cursor moved to end: the next run reads nothing until the log file grows');
  });

  it('fails to move the cursor when the log file cannot be statted', async () => {
    mock.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(runCli(['to-end'])).rejects.toThrow('process.exit-call');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output(errorSpy)).toContain('cannot stat log file /ha-logs/home-assistant.log');
  });

  it('sets a byte offset aligned to the next line start', async () => {
    const db = await runCli(['set', '10']);
    const upsert = db.runs.find((run) => run.sql === UPSERT_SQL);
    expect(upsert?.params.slice(0, 4)).toEqual([1, 2, 100, 18]);
    expect(output(logSpy)).toContain('cursor offset set to 18 (requested 10)');
  });

  it('uses the requested offset as-is when the log file is too large to align', async () => {
    mock.statSync.mockReturnValue({ dev: 1, ino: 2, size: 300 * 1024 * 1024 });
    const db = await runCli(['set', '10']);
    const upsert = db.runs.find((run) => run.sql === UPSERT_SQL);
    expect(upsert?.params.slice(0, 4)).toEqual([1, 2, 300 * 1024 * 1024, 10]);
    expect(output(warnSpy)).toContain('warning: log file too large to align; the offset is used as-is');
    expect(mock.readFileSync).not.toHaveBeenCalled();
  });

  it.each(['-1', 'abc'])('rejects the invalid offset %s', async (offset) => {
    await expect(runCli(['set', offset])).rejects.toThrow('process.exit-call');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output(errorSpy)).toContain(`invalid offset: ${offset}`);
  });

  it('rejects a set command without an offset', async () => {
    await expect(runCli(['set'])).rejects.toThrow('process.exit-call');
    expect(output(errorSpy)).toContain('usage:');
  });

  it('fails to set an offset when the log file cannot be statted', async () => {
    mock.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(runCli(['set', '10'])).rejects.toThrow('process.exit-call');
    expect(output(errorSpy)).toContain('cannot stat log file');
  });

  it('clears signature memory and reports the deleted row count', async () => {
    const db = await runCli(['signatures', 'reset'], {}, { [SIGNATURES_COUNT_SQL]: { count: 3 } });
    expect(output(logSpy)).toContain('deleted 3 signature memory rows');
    expect(output(logSpy)).toContain('all signature memory cleared: re-read signatures will be classified as new');
    expect(db.runs.some((run) => run.sql === SIGNATURES_DELETE_SQL)).toBe(true);
  });

  it('prints usage and exits for an unknown command', async () => {
    await expect(runCli(['bogus'])).rejects.toThrow('process.exit-call');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output(errorSpy)).toContain('usage: node backend/dist/scripts/log-cursor.js');
  });

  it('prints usage and exits when no command is given', async () => {
    await expect(runCli([])).rejects.toThrow('process.exit-call');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts both --db flag forms', async () => {
    const spaced = await runCli(['status', '--db', '/flag/path/app.db']);
    expect(spaced.path).toBe('/flag/path/app.db');
    const equals = await runCli(['status', '--db=/equals/path/app.db']);
    expect(equals.path).toBe('/equals/path/app.db');
  });
});