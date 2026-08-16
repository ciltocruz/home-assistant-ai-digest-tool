import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runMigrations } from '../adapters/persistence/migrations.js';

const MAX_ALIGN_READ_BYTES = 256 * 1024 * 1024;

type CursorRow = { dev: number; ino: number; size: number; offset: number };

export function alignToLineStart(buffer: Buffer, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= buffer.length) return buffer.length;
  const newline = buffer.indexOf(0x0a, offset);
  return newline === -1 ? buffer.length : newline + 1;
}

function databasePath(flag: string | undefined): string {
  return flag ? resolve(flag) : resolve(process.env.DATA_DIR ?? '/data', 'app.db');
}

function logFilePath(): string {
  return process.env.HA_LOG_FILE ?? '/ha-logs/home-assistant.log';
}

function openDatabase(dbPath: string) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  return db;
}

function readCursor(db: { prepare(sql: string): { get(): unknown } }): CursorRow | null {
  const row = db.prepare('select dev, ino, size, offset from v2_log_cursor where singleton = 1').get() as CursorRow | undefined;
  return row ?? null;
}

function upsertCursor(db: { prepare(sql: string): { run(...params: unknown[]): void } }, cursor: CursorRow): void {
  db.prepare(
    'insert into v2_log_cursor(singleton, dev, ino, size, offset, updated_at) values (1, ?, ?, ?, ?, ?) on conflict(singleton) do update set dev=excluded.dev, ino=excluded.ino, size=excluded.size, offset=excluded.offset, updated_at=excluded.updated_at'
  ).run(cursor.dev, cursor.ino, cursor.size, cursor.offset, new Date().toISOString());
}

function statLog(): { dev: number; ino: number; size: number } | null {
  try {
    const info = statSync(logFilePath());
    return { dev: Number(info.dev), ino: Number(info.ino), size: info.size };
  } catch {
    return null;
  }
}

function commandStatus(db: { prepare(sql: string): { get(): unknown } }): void {
  const cursor = readCursor(db);
  const file = statLog();
  console.log('cursor:');
  if (cursor) {
    console.log(`  dev: ${cursor.dev}`);
    console.log(`  ino: ${cursor.ino}`);
    console.log(`  size: ${cursor.size}`);
    console.log(`  offset: ${cursor.offset}`);
  } else {
    console.log('  no cursor row (next read starts at offset 0)');
  }
  console.log(`log file: ${logFilePath()}`);
  if (!file) {
    console.log('  cannot be stat\'ed');
    console.log('next run: the log file cannot be read; the run will fail with HA_LOG_UNAVAILABLE');
    return;
  }
  console.log(`  dev: ${file.dev}`);
  console.log(`  ino: ${file.ino}`);
  console.log(`  size: ${file.size}`);
  if (cursor && (cursor.dev !== file.dev || cursor.ino !== file.ino)) {
    console.log('next run: recovery pending (log file identity changed); it will re-read from offset 0');
    return;
  }
  if (cursor && file.size < cursor.offset) {
    console.log('next run: recovery pending (log file truncated); it will re-read from offset 0');
    return;
  }
  const offset = cursor?.offset ?? 0;
  console.log(`next run: delta = ${file.size - offset} bytes from offset ${offset}`);
}

function commandReset(db: { prepare(sql: string): { run(): void } }): void {
  db.prepare('delete from v2_log_cursor where singleton = 1').run();
  console.log('cursor reset: the next run re-reads the whole current log file');
}

function commandToEnd(db: { prepare(sql: string): { run(...params: unknown[]): void } }): void {
  const file = statLog();
  if (!file) {
    console.error(`cannot stat log file ${logFilePath()}`);
    process.exit(1);
  }
  upsertCursor(db, { ...file, offset: file.size });
  console.log('cursor moved to end: the next run reads nothing until the log file grows');
}

function commandSet(db: { prepare(sql: string): { run(...params: unknown[]): void } }, rawOffset: string): void {
  const requested = Number(rawOffset);
  if (!Number.isInteger(requested) || requested < 0) {
    console.error(`invalid offset: ${rawOffset}`);
    process.exit(1);
  }
  const file = statLog();
  if (!file) {
    console.error(`cannot stat log file ${logFilePath()}`);
    process.exit(1);
  }
  let offset = requested;
  if (file.size > MAX_ALIGN_READ_BYTES) {
    console.warn('warning: log file too large to align; the offset is used as-is');
  } else {
    offset = alignToLineStart(readFileSync(logFilePath()), requested);
  }
  upsertCursor(db, { dev: file.dev, ino: file.ino, size: file.size, offset });
  console.log(`cursor offset set to ${offset} (requested ${requested})`);
}

function commandSignaturesReset(db: { prepare(sql: string): { run(): void; get(): unknown } }): void {
  const { count } = db.prepare('select count(*) as count from v2_signatures').get() as { count: number };
  db.prepare('delete from v2_signatures').run();
  console.log(`deleted ${count} signature memory rows`);
  console.log('all signature memory cleared: re-read signatures will be classified as new');
}

function usage(): void {
  console.error('usage: node backend/dist/scripts/log-cursor.js <status|reset|to-end|set <offset>|signatures reset> [--db <path>]');
  process.exit(1);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let dbFlag: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--db') {
      dbFlag = args[i + 1];
      i += 1;
    } else if (args[i].startsWith('--db=')) {
      dbFlag = args[i].slice('--db='.length);
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    }
  }
  const command = positional[0];
  if (!command || (command !== 'status' && command !== 'reset' && command !== 'to-end' && command !== 'set' && command !== 'signatures')) {
    usage();
  }
  const db = openDatabase(databasePath(dbFlag));
  try {
    if (command === 'status') {
      commandStatus(db);
    } else if (command === 'reset') {
      commandReset(db);
    } else if (command === 'to-end') {
      commandToEnd(db);
    } else if (command === 'set') {
      if (positional.length < 2) usage();
      commandSet(db, positional[1]);
    } else {
      commandSignaturesReset(db);
    }
  } finally {
    db.close();
  }
}