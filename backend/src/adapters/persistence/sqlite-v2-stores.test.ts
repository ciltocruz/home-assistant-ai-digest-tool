import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DigestDetailSchema, DigestHistoryResponseSchema } from '@ha-digest/shared';
import { parseHomeAssistantLog } from '../../domain/batch.js';
import { runMigrations } from './migrations.js';
import { SQLiteV2Stores } from './sqlite-v2-stores.js';
import { SQLiteDigestJobStore } from './sqlite-digest-job-store.js';
import { BatchReportRun } from '../../application/batch-report-run.js';
import { DigestWorker } from '../../application/digest-worker.js';

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

  it('sanitizes provider analysis before writing both v2 report storage locations and projecting detail', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const rawSecrets = [
      'stored-bearer-fixture',
      'stored-token-fixture',
      'stored-api-key-fixture',
      'stored-query-token-fixture',
      '123456:ABCdefGHIjklMNOpqr',
      '987654:ZYXwvUTSrqponMLK'
    ];
    const analysis = {
      summary: `Incident summary: Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api_key=${rawSecrets[2]} https://provider.test/?token=${rawSecrets[3]} botToken=${rawSecrets[4]}. Token budget is stable.`,
      recommendation: `Restart the integration after bot_token: ${rawSecrets[5]}; keep API key rotation documented.`
    };
    const reportId = await stores.commit({
      request: { runId: 'analysis-redaction-run', slotId: 'analysis-redaction-slot' },
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis }], warnings: [] }
    });

    const payloadRow = db.prepare('select payload_json from v2_reports where id = ?').get(reportId) as { payload_json: string };
    const signatureRow = db.prepare('select summary, recommendation from v2_report_signatures where report_id = ?').get(reportId) as { summary: string; recommendation: string };
    const detail = await stores.getReport(reportId);

    expect(payloadRow.payload_json).toContain('Incident summary');
    expect(signatureRow.summary).toContain('Token budget is stable');
    expect(signatureRow.recommendation).toContain('API key rotation documented');
    for (const value of [payloadRow, signatureRow, detail]) {
      for (const secret of rawSecrets) expect(JSON.stringify(value)).not.toContain(secret);
    }
    expect(JSON.stringify(detail)).toContain('Token budget is stable');
    expect(JSON.stringify(detail)).toContain('API key rotation documented');
  });

  it('strictly persists and presents only safe v2 finding fields with the configured key', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const configuredKey = 'opaque-v2-configured-key-fixture';
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z', async () => configuredKey);
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const reportId = await stores.commit({
      request: { runId: 'strict-v2-run', slotId: 'strict-v2-slot' },
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: {
        status: 'reported',
        findings: [{
          signature: entries[0]!.signature,
          analysis: { summary: `Summary ${configuredKey}`, recommendation: `Recommendation ${configuredKey}` },
          providerControlled: configuredKey
        } as never],
        warnings: []
      }
    });

    const payload = db.prepare('select payload_json from v2_reports where id = ?').get(reportId) as { payload_json: string };
    const detail = await stores.getReport(reportId);

    expect(payload.payload_json).not.toContain(configuredKey);
    expect(payload.payload_json).not.toContain('providerControlled');
    expect(JSON.stringify(detail)).not.toContain(configuredKey);
    expect(JSON.stringify(detail)).not.toContain('providerControlled');
    expect(detail?.presentation).toMatchObject({ signatures: [{ analysis: { summary: 'Summary [REDACTED]', recommendation: 'Recommendation [REDACTED]' } }] });
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

    const rawProviderFailure = "Gemini 404: model 'gemini-flash-latest' failed (classification: model retired). Bearer bearer-token-fixture token=token-assignment-fixture api_key: api-key-colon-fixture https://provider.test/generate?token=query-token-fixture";
    const rawSecrets = ['bearer-token-fixture', 'token-assignment-fixture', 'api-key-colon-fixture', 'query-token-fixture'];
    await stores.fail({ request, code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: rawProviderFailure });

    const persistedFailure = db.prepare('select error_message from v2_runs where id = ?').get('retry-run') as { error_message: string };
    expect(persistedFailure.error_message).toContain('classification: model retired');
    expect(persistedFailure.error_message).toContain('[REDACTED]');
    for (const secret of rawSecrets) expect(persistedFailure.error_message).not.toContain(secret);

    const failedHistory = DigestHistoryResponseSchema.parse(await stores.listReports());
    expect(failedHistory).toHaveLength(1);
    expect(failedHistory[0]).toMatchObject({ source: 'v2' });
    expect(Date.parse(failedHistory[0]!.window.to) - Date.parse(failedHistory[0]!.window.from)).toBe(1);
    const failedDetail = DigestDetailSchema.parse(await stores.getReport('v2-run:retry-run'));
    expect(failedDetail.presentation).toMatchObject({ mode: 'batch', failure: expect.stringContaining('classification: model retired') });
    for (const secret of rawSecrets) expect(JSON.stringify(failedDetail)).not.toContain(secret);

    const reportId = await stores.commit({
      request,
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    });

    expect(reportId).toBe('v2-report:retry-run');
    expect(db.prepare('select status, error_code, error_message from v2_runs where id = ?').get('retry-run')).toEqual({ status: 'reported', error_code: null, error_message: null });
    expect(db.prepare('select count(*) as count from v2_reports where run_id = ?').get('retry-run')).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from v2_report_signatures where report_id = ?').get(reportId)).toEqual({ count: 1 });
    expect(await stores.readCursor()).toEqual({ dev: 1, ino: 2, size: 100, offset: 100 });

    const history = DigestHistoryResponseSchema.parse(await stores.listReports());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: reportId, runStatus: 'reported', source: 'v2' });
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

  it('persists delivery transitions after the report commit and falls back to pending for old payloads', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('old-v2-run', 'old-v2-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:old-v2-run', 'old-v2-run', 'reported', JSON.stringify({ report: { status: 'reported', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');

    expect((await stores.listReports()).find((item) => item.id === 'v2-report:old-v2-run')?.deliveryStatus).toBe('pending');

    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const reportId = await stores.commit({
      request: { runId: 'delivery-run', slotId: 'delivery-slot' },
      cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
      signatures: plan,
      report: { status: 'reported', deliveryStatus: 'pending', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    });

    expect((await stores.listReports()).find((item) => item.id === reportId)?.deliveryStatus).toBe('pending');
    await stores.updateDeliveryStatus(reportId, 'sent');
    expect((await stores.listReports()).find((item) => item.id === reportId)?.deliveryStatus).toBe('sent');
    expect((await stores.getReport(reportId))?.summary.deliveryStatus).toBe('sent');
  });

  it('persists and projects a bounded delivery diagnostic while old failures remain reasonless', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-13T10:00:01.000Z');
    const entries = parseHomeAssistantLog(['2026-08-13 09:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-13T10:00:00.000Z');
    const reportId = await stores.commit({ request: { runId: 'diag-run', slotId: 'diag-slot' }, cursor: { dev: 1, ino: 2, size: 1, offset: 1 }, signatures: plan, report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] } });

    await stores.updateDeliveryStatus(reportId, 'failed', { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_HTTP_401', messageKey: 'telegram_auth_failed', recordedAt: '2026-08-13T10:00:01.000Z' });

    expect((await stores.listReports())[0]?.deliveryDiagnostic).toMatchObject({ errorCode: 'TELEGRAM_HTTP_401', messageKey: 'telegram_auth_failed' });
    expect((await stores.getReport(reportId))?.summary.deliveryDiagnostic).toMatchObject({ stage: 'response' });
    const row = db.prepare('select * from v2_report_delivery_attempts where report_id = ?').get(reportId);
    expect(JSON.stringify(row)).not.toContain('target');
    expect(JSON.stringify(row)).not.toContain('body');
  });

  it('persists an indeterminate Telegram response as pending and never claims it for automatic resend', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-13T10:00:01.000Z');
    const entries = parseHomeAssistantLog(['2026-08-13 09:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-13T10:00:00.000Z');
    const reportId = await stores.commit({ request: { runId: 'invalid-response-run', slotId: 'invalid-response-slot' }, cursor: { dev: 1, ino: 2, size: 1, offset: 1 }, signatures: plan, report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] } });

    await stores.updateDeliveryStatus(reportId, 'pending', { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z' });

    expect((await stores.listReports())[0]).toMatchObject({ deliveryStatus: 'pending', deliveryDiagnostic: { errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response' } });
    expect((await stores.getReport(reportId))?.summary.deliveryDiagnostic).toMatchObject({ stage: 'response' });
    await expect(stores.claimDeliveryAttempt(reportId)).resolves.toEqual({ status: 'pending', shouldSend: false });
    expect(JSON.stringify(db.prepare('select * from v2_report_delivery_attempts where report_id = ?').get(reportId))).not.toContain('response body');
  });

  it('retrieves an old v2 payload with missing findings and warnings as a valid detail', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('legacy-detail-run', 'legacy-detail-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:legacy-detail-run', 'legacy-detail-run', 'reported', JSON.stringify({ report: {}, signatures: [] }), '2026-08-05T19:00:00.000Z');

    const detail = await stores.getReport('v2-report:legacy-detail-run');

    expect(DigestDetailSchema.parse(detail)).toMatchObject({
      id: 'v2-report:legacy-detail-run',
      presentation: { mode: 'batch', status: 'reported', warnings: [], signatures: [] }
    });
  });

  it('allowlists and redacts old v2 warnings and integration status before returning detail', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const rawSecrets = ['old-warning-token-fixture', 'old-integration-secret-fixture'];
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('old-unsafe-run', 'old-unsafe-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:old-unsafe-run', 'old-unsafe-run', 'reported', JSON.stringify({
        report: {
          status: 'reported',
          warnings: [`Bearer ${rawSecrets[0]}`, { providerWarning: rawSecrets[1] }],
          integrationStatus: {
            available: true,
            providerControlled: rawSecrets[1],
            integrations: [{ domain: 'mqtt', title: `MQTT Bearer ${rawSecrets[0]}`, state: `token=${rawSecrets[1]}`, opaque: 'do-not-return' }]
          }
        },
        signatures: []
      }), '2026-08-05T19:00:00.000Z');

    const detail = await stores.getReport('v2-report:old-unsafe-run');

    expect(DigestDetailSchema.parse(detail)).toMatchObject({
      presentation: {
        mode: 'batch',
        warnings: ['Bearer [REDACTED]'],
        integrationStatus: { available: true, integrations: [{ domain: 'mqtt', title: 'MQTT Bearer [REDACTED]', state: 'token=[REDACTED]' }] }
      }
    });
    const serialized = JSON.stringify(detail);
    for (const secret of rawSecrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('providerControlled');
    expect(serialized).not.toContain('providerWarning');
    expect(serialized).not.toContain('opaque');
  });

  it('does not auto-send an old pending v2 report whose delivery attempt is unknown', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const signature = plan.signatures[0]!;
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('old-pending-run', 'old-pending-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:old-pending-run', 'old-pending-run', 'reported', JSON.stringify({ report: { status: 'reported', deliveryStatus: 'pending', findings: [{ signature: signature.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }, signatures: [signature] }), '2026-08-05T19:00:00.000Z');
    let sends = 0;
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: [], cursor: { dev: 1, ino: 2, size: 0, offset: 0 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { sends += 1; return 'sent'; } }
    });

    const outcome = await run.run({ runId: 'old-pending-run', slotId: 'old-pending-slot' });

    expect(outcome).toMatchObject({ reportId: 'v2-report:old-pending-run', deliveryStatus: 'pending' });
    expect(sends).toBe(0);
  });

  it('does not auto-send an old v2 report with missing delivery status and no attempt', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const signature = plan.signatures[0]!;
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('old-missing-status-run', 'old-missing-status-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:old-missing-status-run', 'old-missing-status-run', 'reported', JSON.stringify({ report: { status: 'reported', findings: [{ signature: signature.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }, signatures: [signature] }), '2026-08-05T19:00:00.000Z');
    let sends = 0;
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: [], cursor: { dev: 0, ino: 0, size: 0, offset: 0 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { sends += 1; return 'sent'; } }
    });

    const outcome = await run.run({ runId: 'old-missing-status-run', slotId: 'old-missing-status-slot' });

    expect(outcome).toMatchObject({ reportId: 'v2-report:old-missing-status-run', deliveryStatus: 'pending' });
    expect(sends).toBe(0);
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get('v2-report:old-missing-status-run')).toEqual({ status: 'pending' });
  });

  it('does not resend when a ready attempt is covered by a sent run tombstone', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, delivery_status, created_at) values (?, ?, ?, ?, ?, ?)')
      .run('sent-tombstone-run', 'sent-tombstone-slot', 'reported', null, 'sent', '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:sent-tombstone-run', 'sent-tombstone-run', 'reported', JSON.stringify({ report: { status: 'reported', deliveryStatus: 'sent', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
      .run('v2-report:sent-tombstone-run', 'ready', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z');

    await expect(stores.getDeliveryStatus('v2-report:sent-tombstone-run')).resolves.toBe('sent');
    await expect(stores.claimDeliveryAttempt('v2-report:sent-tombstone-run')).resolves.toEqual({ status: 'sent', shouldSend: false });
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get('v2-report:sent-tombstone-run')).toEqual({ status: 'sent' });
  });

  it('drops malformed nested v2 presentation values before detail projection', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-nested-run', 'malformed-nested-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:malformed-nested-run', 'malformed-nested-run', 'reported', JSON.stringify({
        report: { status: 'reported', findings: [{ signature: '', analysis: { summary: '', recommendation: '   ' } }], warnings: [] },
        signatures: [{ signature: '', component: '', level: 'WARNING', classification: 'new', trend: 'new', occurrences: [{ at: '2026-08-05T19:00:00.000Z', level: 'WARNING', component: '', message: '', normalizedMessage: '', signature: '' }] }]
      }), '2026-08-05T19:00:00.000Z');

    const detail = await stores.getReport('v2-report:malformed-nested-run');

    expect(DigestDetailSchema.parse(detail)).toMatchObject({ presentation: { signatures: [] } });
  });

  it('completes the job after notification succeeds when delivery status persistence fails, preventing a resend', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.exec("create trigger delivery_status_failure before update on v2_reports begin select raise(abort, 'delivery state unavailable'); end");
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const jobs = new SQLiteDigestJobStore(db, { now: () => new Date('2026-08-05T20:00:00.000Z') });
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const notifications: string[] = [];
    const batch = new BatchReportRun({
      log: { read: async () => ({ lines: ['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42'], cursor: { dev: 1, ino: 2, size: 100, offset: 100 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { notifications.push('sent'); return 'sent'; } }
    });
    const worker = new DigestWorker({
      jobs,
      analysis: { runWithStages: async () => {
        const outcome = await batch.run({ runId: 'delivery-persistence-run', slotId: 'delivery-persistence-slot' });
        if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
        return { status: 'completed', reportId: outcome.reportId };
      } }
    });
    const queued = await jobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:delivery-persistence' });

    await worker.runOnce();

    const completed = await jobs.get(queued.jobId);
    expect(completed).toMatchObject({ status: 'completed', reportId: 'v2-report:delivery-persistence-run', retryAvailable: false });
    expect((await stores.getReport('v2-report:delivery-persistence-run'))?.summary.deliveryStatus).toBe('pending');
    expect(notifications).toEqual(['sent']);
    await worker.runOnce();
    expect(notifications).toEqual(['sent']);
  });

  it('does not resend when job completion fails after a sent report and the job is retried', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const persistedJobs = new SQLiteDigestJobStore(db, { now: () => new Date('2026-08-05T20:00:00.000Z') });
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const notifications: string[] = [];
    const batch = new BatchReportRun({
      log: { read: async () => ({ lines: ['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42'], cursor: { dev: 1, ino: 2, size: 100, offset: 100 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { notifications.push('sent'); return 'sent'; } }
    });
    let completionAttempts = 0;
    const worker = new DigestWorker({
      jobs: {
        leaseNext: (options) => persistedJobs.leaseNext(options),
        setStage: (id, stage) => persistedJobs.setStage(id, stage),
        complete: async (id, reportId) => {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error('job completion storage unavailable');
          await persistedJobs.complete(id, reportId);
        },
        fail: (id, code, message) => persistedJobs.fail(id, code, message)
      },
      analysis: { runWithStages: async (_onStage, job) => {
        const outcome = await batch.run({ runId: job?.id ?? 'missing', slotId: 'completion-failure-slot' });
        if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
        return { status: 'completed', reportId: outcome.reportId };
      } }
    });
    const queued = await persistedJobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:completion-failure' });

    await worker.runOnce();
    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'failed', retryAvailable: true });
    expect((await stores.getReport(`v2-report:${queued.jobId}`))?.summary.deliveryStatus).toBe('sent');
    expect(notifications).toHaveLength(1);

    await persistedJobs.retryFailed(queued.jobId);
    await worker.runOnce();

    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'completed', retryAvailable: false });
    expect(notifications).toHaveLength(1);
  });

  it('does not resend when delivery persistence and then job completion both fail', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    db.exec("create trigger delivery_status_failure_compound before update on v2_reports begin select raise(abort, 'delivery state unavailable'); end");
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const persistedJobs = new SQLiteDigestJobStore(db, { now: () => new Date('2026-08-05T20:00:00.000Z') });
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    let sends = 0;
    let completionAttempts = 0;
    const batch = new BatchReportRun({
      log: { read: async () => ({ lines: ['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42'], cursor: { dev: 1, ino: 2, size: 100, offset: 100 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { sends += 1; return 'sent'; } }
    });
    const worker = new DigestWorker({
      jobs: {
        leaseNext: (options) => persistedJobs.leaseNext(options),
        setStage: (id, stage) => persistedJobs.setStage(id, stage),
        complete: async (id, reportId) => {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error('job completion storage unavailable');
          await persistedJobs.complete(id, reportId);
        },
        fail: (id, code, message) => persistedJobs.fail(id, code, message)
      },
      analysis: { runWithStages: async (_onStage, job) => {
        const outcome = await batch.run({ runId: job?.id ?? 'missing', slotId: 'compound-failure-slot' });
        if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
        return { status: 'completed', reportId: outcome.reportId };
      } }
    });
    const queued = await persistedJobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:compound-failure' });

    await worker.runOnce();
    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'failed', retryAvailable: true });
    expect((await stores.getReport(`v2-report:${queued.jobId}`))?.summary.deliveryStatus).toBe('pending');

    await persistedJobs.retryFailed(queued.jobId);
    await worker.runOnce();

    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'completed', retryAvailable: false });
    expect(sends).toBe(1);
  });

  it('does not resend a sent report after retention deletes its detail and the job is retried', async () => {
    let now = '2026-08-05T20:00:00.000Z';
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 1, () => now);
    const persistedJobs = new SQLiteDigestJobStore(db, { now: () => new Date(now) });
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, now);
    let sends = 0;
    const batch = new BatchReportRun({
      log: { read: async () => ({ lines: ['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42'], cursor: { dev: 1, ino: 2, size: 100, offset: 100 } }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'Found', recommendation: 'Fix' }) },
      persistence: stores,
      notifier: { notify: async () => { sends += 1; return 'sent'; } }
    });
    let completionAttempts = 0;
    const worker = new DigestWorker({
      jobs: {
        leaseNext: (options) => persistedJobs.leaseNext(options),
        setStage: (id, stage) => persistedJobs.setStage(id, stage),
        complete: async (id, reportId) => {
          completionAttempts += 1;
          if (completionAttempts === 1) throw new Error('job completion storage unavailable');
          await persistedJobs.complete(id, reportId);
        },
        fail: (id, code, message) => persistedJobs.fail(id, code, message)
      },
      analysis: { runWithStages: async (_onStage, job) => {
        const outcome = await batch.run({ runId: job?.id ?? 'missing', slotId: 'retained-slot' });
        if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
        return { status: 'completed', reportId: outcome.reportId };
      } }
    });
    const queued = await persistedJobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:retained' });

    await worker.runOnce();
    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'failed', retryAvailable: true });
    expect(sends).toBe(1);

    now = '2026-08-06T20:00:00.000Z';
    const newerPlan = await stores.classifyAndStage(entries, now);
    await stores.commit({
      request: { runId: 'newer-run', slotId: 'newer-slot' },
      cursor: { dev: 1, ino: 2, size: 200, offset: 200 },
      signatures: newerPlan,
      report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
    });
    expect(await stores.getReport(`v2-report:${queued.jobId}`)).toBeNull();

    now = '2026-08-07T20:00:00.000Z';
    await persistedJobs.retryFailed(queued.jobId);
    await worker.runOnce();
    expect(await persistedJobs.get(queued.jobId)).toMatchObject({ status: 'completed', retryAvailable: false, reportId: `v2-report:${queued.jobId}` });
    expect(sends).toBe(1);
    expect(db.prepare('select delivery_status from v2_runs where id = ?').get(queued.jobId)).toEqual({ delivery_status: 'sent' });
  });

  it('falls back to pending for a malformed persisted v2 delivery status in history and detail', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-status-run', 'malformed-status-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:malformed-status-run', 'malformed-status-run', 'reported', JSON.stringify({ report: { status: 'reported', deliveryStatus: 'not-a-delivery-status', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');

    const history = DigestHistoryResponseSchema.parse(await stores.listReports());
    const detail = DigestDetailSchema.parse(await stores.getReport('v2-report:malformed-status-run'));

    expect(history[0]?.deliveryStatus).toBe('pending');
    expect(detail.summary.deliveryStatus).toBe('pending');
  });

  it('projects malformed persisted payloads safely across history and detail seams', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-payload-run', 'malformed-payload-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:malformed-payload-run', 'malformed-payload-run', 'reported', '{not-json', '2026-08-05T19:00:00.000Z');

    const history = DigestHistoryResponseSchema.parse(await stores.listReports());
    const detail = DigestDetailSchema.parse(await stores.getReport('v2-report:malformed-payload-run'));

    expect(history).toMatchObject([{
      id: 'v2-report:malformed-payload-run',
      runStatus: 'failed',
      deliveryStatus: 'pending',
      warningCodes: ['REPORT_PAYLOAD_INVALID']
    }]);
    expect(detail).toMatchObject({
      id: 'v2-report:malformed-payload-run',
      summary: { runStatus: 'failed', deliveryStatus: 'pending', warningCodes: ['REPORT_PAYLOAD_INVALID'] },
      presentation: { mode: 'batch', status: 'failed', warnings: ['REPORT_PAYLOAD_INVALID'], signatures: [] }
    });
  });

  it('does not send or crash when claiming delivery for a malformed payload', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-claim-run', 'malformed-claim-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:malformed-claim-run', 'malformed-claim-run', 'reported', '{not-json', '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
      .run('v2-report:malformed-claim-run', 'ready', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z');

    await expect(stores.getDeliveryStatus('v2-report:malformed-claim-run')).resolves.toBe('pending');
    await expect(stores.claimDeliveryAttempt('v2-report:malformed-claim-run')).resolves.toEqual({ status: 'pending', shouldSend: false });
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get('v2-report:malformed-claim-run')).toEqual({ status: 'pending' });
  });

  it('normalizes an unknown delivery tombstone status without suppressing or triggering delivery', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('unknown-tombstone-run', 'unknown-tombstone-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:unknown-tombstone-run', 'unknown-tombstone-run', 'reported', JSON.stringify({ report: { status: 'reported', deliveryStatus: 'pending', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
      .run('v2-report:unknown-tombstone-run', 'unexpected', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z');

    await expect(stores.getDeliveryStatus('v2-report:unknown-tombstone-run')).resolves.toBe('pending');
    await expect(stores.claimDeliveryAttempt('v2-report:unknown-tombstone-run')).resolves.toEqual({ status: 'pending', shouldSend: false });
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get('v2-report:unknown-tombstone-run')).toEqual({ status: 'pending' });
  });

  it('projects unknown v2 report and run statuses as schema-valid corrupt failures with safe timestamps', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('unknown-report-status-run', 'unknown-report-status-slot', 'reported', null, 'not-a-timestamp');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:unknown-report-status-run', 'unknown-report-status-run', 'corrupt-status', JSON.stringify({ report: { status: 'reported', findings: [], warnings: [] }, signatures: [] }), 'not-a-timestamp');
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('unknown-run-status-run', 'unknown-run-status-slot', 'corrupt-status', null, 'also-not-a-timestamp');
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('corrupt-parent-run', 'corrupt-parent-slot', 'corrupt-status', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:corrupt-parent-run', 'corrupt-parent-run', 'reported', JSON.stringify({ report: { status: 'reported', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');

    const history = DigestHistoryResponseSchema.parse(await stores.listReports());
    const reportDetail = DigestDetailSchema.parse(await stores.getReport('v2-report:unknown-report-status-run'));
    const runDetail = DigestDetailSchema.parse(await stores.getReport('v2-run:unknown-run-status-run'));
    const parentStatusDetail = DigestDetailSchema.parse(await stores.getReport('v2-report:corrupt-parent-run'));

    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'v2-report:unknown-report-status-run', createdAt: '1970-01-01T00:00:00.000Z', runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] }),
      expect.objectContaining({ id: 'v2-run:unknown-run-status-run', createdAt: '1970-01-01T00:00:00.000Z', runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] })
    ]));
    expect(reportDetail).toMatchObject({
      summary: { createdAt: '1970-01-01T00:00:00.000Z', runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] },
      presentation: { status: 'failed', warnings: ['REPORT_CORRUPT'], signatures: [] }
    });
    expect(runDetail).toMatchObject({
      summary: { createdAt: '1970-01-01T00:00:00.000Z', runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] },
      presentation: { status: 'failed', warnings: ['REPORT_CORRUPT'], signatures: [] }
    });
    expect(parentStatusDetail).toMatchObject({
      summary: { runStatus: 'failed', warningCodes: ['REPORT_CORRUPT'] },
      presentation: { status: 'failed', warnings: ['REPORT_CORRUPT'], signatures: [] }
    });
  });

  it('keeps malformed v2 delivery operations pending and never auto-sends', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    const reportId = 'v2-report:malformed-delivery-status-run';
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-delivery-status-run', 'malformed-delivery-status-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run(reportId, 'malformed-delivery-status-run', 'corrupt-status', JSON.stringify({ report: { status: 'reported', deliveryStatus: 'pending', findings: [], warnings: [] }, signatures: [] }), '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
      .run(reportId, 'ready', '2026-08-05T19:00:00.000Z', '2026-08-05T19:00:00.000Z');

    await expect(stores.getDeliveryStatus(reportId)).resolves.toBe('pending');
    await expect(stores.claimDeliveryAttempt(reportId)).resolves.toEqual({ status: 'pending', shouldSend: false });
    await expect(stores.updateDeliveryStatus(reportId, 'sent')).resolves.toBeUndefined();
    await expect(stores.getDeliveryStatus(reportId)).resolves.toBe('pending');
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get(reportId)).toEqual({ status: 'pending' });
    expect(DigestDetailSchema.parse(await stores.getReport(reportId))).toMatchObject({ presentation: { status: 'failed', warnings: ['REPORT_CORRUPT'] } });
  });

  it('discards v2 notes with invalid timestamps before detail projection', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db);
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T19:00:00.000Z');
    const signature = plan.signatures[0]!;
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('malformed-note-run', 'malformed-note-slot', 'reported', null, '2026-08-05T19:00:00.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:malformed-note-run', 'malformed-note-run', 'reported', JSON.stringify({
        report: { status: 'reported', findings: [], warnings: [] },
        signatures: [signature],
        notesBySignature: {
          [signature.signature]: [
            { id: 'invalid-note', text: 'Discard me', occurredAt: 'bad-date', createdAt: '2026-08-05T19:00:00.000Z', tags: [signature.signature] },
            { id: 'valid-note', text: 'Keep me', occurredAt: '2026-08-05T21:00:00+02:00', createdAt: '2026-08-05T19:00:00Z', tags: [signature.signature] }
          ]
        }
      }), '2026-08-05T19:00:00.000Z');

    const detail = DigestDetailSchema.parse(await stores.getReport('v2-report:malformed-note-run'));

    expect(detail.presentation).toMatchObject({ signatures: [{ notes: [{ id: 'valid-note', occurredAt: '2026-08-05T19:00:00.000Z', createdAt: '2026-08-05T19:00:00.000Z' }] }] });
  });

  it('deletes one v2 report and its dependent rows while preserving neighboring reports and global memory', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const stores = new SQLiteV2Stores(db, 10, () => '2026-08-05T20:00:00.000Z');
    const jobs = new SQLiteDigestJobStore(db, { now: () => new Date('2026-08-05T20:00:00.000Z') });
    const entries = parseHomeAssistantLog(['2026-08-05 19:00:00 ERROR [homeassistant.components.demo] Failure 42']);
    const plan = await stores.classifyAndStage(entries, '2026-08-05T20:00:00.000Z');
    const reportIds: string[] = [];
    for (const suffix of ['selected', 'neighbor']) {
      reportIds.push(await stores.commit({
        request: { runId: `delete-${suffix}`, slotId: `delete-${suffix}-slot` },
        cursor: { dev: 1, ino: 2, size: 100, offset: 100 },
        signatures: plan,
        report: { status: 'reported', findings: [{ signature: entries[0]!.signature, analysis: { summary: 'Found', recommendation: 'Fix' } }], warnings: [] }
      }));
    }
    await stores.add({ text: 'Preserve this note', occurredAt: '2026-08-05T19:00:00.000Z', tags: [entries[0]!.signature] });
    await jobs.enqueue({ kind: 'manual', triggerWindowId: 'preserved-job' });

    await expect(stores.removeReport(reportIds[0]!)).resolves.toBe(true);
    await expect(stores.removeReport(reportIds[0]!)).resolves.toBe(false);

    expect(await stores.getReport(reportIds[0]!)).toBeNull();
    expect(await stores.getReport(reportIds[1]!)).not.toBeNull();
    expect(db.prepare('select count(*) as count from v2_report_signatures where report_id = ?').get(reportIds[0]!)).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from v2_report_delivery_attempts where report_id = ?').get(reportIds[0]!)).toEqual({ count: 0 });
    expect(db.prepare('select count(*) as count from v2_signatures').get()).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from notes').get()).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from digest_jobs').get()).toEqual({ count: 1 });
    expect(db.prepare('select count(*) as count from v2_runs').get()).toEqual({ count: 2 });
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
