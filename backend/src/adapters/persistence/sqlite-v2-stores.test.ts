import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DigestDetailSchema, DigestHistoryResponseSchema } from '@ha-digest/shared';
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

  it('commits a successful retry over a failed run and remains idempotent', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const request = { runId: 'retry-run', slotId: 'retry-slot' };

    await stores.fail({ request, code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: 'Provider unavailable.' });

    const failedHistory = DigestHistoryResponseSchema.parse(await stores.listReports());
    expect(failedHistory).toHaveLength(1);
    expect(Date.parse(failedHistory[0]!.window.to) - Date.parse(failedHistory[0]!.window.from)).toBe(1);
    DigestDetailSchema.parse(await stores.getReport('v2-run:retry-run'));

    const reportId = await stores.commit({
      request,
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    });

    expect(reportId).toBe('v2-report:retry-run');
    expect(db.prepare('select status, error_code from v2_runs where id = ?').get('retry-run')).toEqual({ status: 'reported', error_code: null });
    expect(db.prepare('select count(*) as count from v2_reports where run_id = ?').get('retry-run')).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from v2_report_signatures where report_id = ?').get(reportId)).toEqual({ count: 1 });
    expect(await stores.readCursor()).toEqual({ dev: 1, ino: 2, size: 100, offset: 100 });

    const history = DigestHistoryResponseSchema.parse(await stores.listReports());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: reportId, runStatus: 'reported' });
    expect(await stores.getReport('v2-run:retry-run')).toBeNull();
    DigestDetailSchema.parse(await stores.getReport(reportId));

    await expect(stores.commit({
      request,
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    })).resolves.toBe(reportId);
    expect(db.prepare('select count(*) as count from v2_reports where run_id = ?').get('retry-run')).toEqual({ count: 1 });
  });

  it('keeps a normal successful run and legacy reports independent', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const commit = {
      request: { runId: 'normal-run', slotId: 'normal-slot' },
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported' as const, findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    };

    await stores.commit(commit);
    await stores.commit(commit);

    expect(db.prepare('select count(*) as count from v2_runs').get()).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from v2_reports').get()).toEqual({ count: 1 });
    expect(DigestHistoryResponseSchema.parse(await stores.listReports())).toHaveLength(1);
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
