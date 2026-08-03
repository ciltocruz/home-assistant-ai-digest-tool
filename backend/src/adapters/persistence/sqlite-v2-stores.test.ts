import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parseHomeAssistantLog } from '../../domain/batch.js';
import { runMigrations } from './migrations.js';
import { SQLiteV2Stores } from './sqlite-v2-stores.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('SQLiteV2Stores', () => {
  it('keeps existing onboarding configuration and encrypted secret references while starting v2 history empty', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.prepare("insert into settings(key, value_json, updated_at) values ('runtime', ?, ?)")
      .run(JSON.stringify({ secretRefs: { haTokenRef: 'secret_ha', aiKeyRef: 'secret_ai' } }), '2026-08-01T00:00:00.000Z');
    db.prepare("insert into secrets(id, kind, encrypted_value, iv, auth_tag, created_at, updated_at) values ('secret_ha', 'home_assistant', 'cipher', 'iv', 'tag', ?, ?)")
      .run('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    runMigrations(db);

    expect(db.prepare("select value_json from settings where key = 'runtime'").get()).toEqual({ value_json: JSON.stringify({ secretRefs: { haTokenRef: 'secret_ha', aiKeyRef: 'secret_ai' } }) });
    expect(db.prepare('select count(*) as count from v2_reports').get()).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from v2_signatures').get()).toEqual({ count: 0 });
  });

  it('atomically stages cursor, permanent signatures, runs, and count-retained reports', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    const entries = parseHomeAssistantLog(['2026-08-01 10:00:00 ERROR [homeassistant.components.demo] Failure 42']);

    for (let index = 0; index < 12; index += 1) {
      const at = `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`;
      const plan = await stores.classifyAndStage(entries, at);
      await stores.commit({
        request: { runId: `run-${index}`, slotId: `slot-${index}` },
        cursor: { dev: 1, ino: 2, size: 100 + index, offset: 100 + index },
        signatures: plan,
        report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
      });
    }

    expect(await stores.readCursor()).toEqual({ dev: 1, ino: 2, size: 111, offset: 111 });
    expect(db.prepare('select count(*) as count from v2_runs').get()).toEqual({ count: 12 });
    expect(db.prepare('select count(*) as count from v2_reports').get()).toEqual({ count: 10 });
    expect(db.prepare('select total_count as count from v2_signatures').get()).toEqual({ count: 12 });
  });

  it('rolls back every staged v2 write when report persistence fails', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.exec("create trigger v2_report_failure before insert on v2_reports begin select raise(abort, 'storage unavailable'); end");
    const stores = new SQLiteV2Stores(db);
    const entries = parseHomeAssistantLog(['2026-08-01 10:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-01T10:00:00.000Z');

    await expect(stores.commit({
      request: { runId: 'failed-run', slotId: 'failed-slot' }, cursor: { dev: 1, ino: 2, size: 10, offset: 10 }, signatures: plan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    })).rejects.toThrow('storage unavailable');

    for (const table of ['v2_log_cursor', 'v2_signatures', 'v2_runs', 'v2_reports']) {
      expect(db.prepare(`select count(*) as count from ${table}`).get()).toEqual({ count: 0 });
    }
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
