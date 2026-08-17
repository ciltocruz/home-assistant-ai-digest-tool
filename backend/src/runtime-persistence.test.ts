import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DigestDetailSchema, DigestHistoryResponseSchema } from '@ha-digest/shared';
import { runMigrations } from './adapters/persistence/migrations.js';
import { SQLiteSecretStore } from './adapters/persistence/sqlite-secret-store.js';
import { parseHomeAssistantLog } from './domain/batch.js';
import type { ReportStore } from './domain/stores.js';
import { createApp } from './http/app.js';
import { createPersistentRuntimeServices, toScheduleDefinitions } from './runtime-persistence.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

const NOW = '2026-07-12T10:00:00.000Z';
const HA_SECRET = 'sentinel-ha-credential-value';
const AI_SECRET = 'sentinel-ai-credential-value';
const TELEGRAM_SECRET = 'sentinel-telegram-credential-value';

describe('persistent runtime services', () => {
  it('initializes /data SQLite state and persists setup through masked secret refs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-data-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });

    const setup = await services.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'gemini',
      aiKey: AI_SECRET,
      telegram: { botToken: TELEGRAM_SECRET, chatId: '123456' }
    });
    const settings = await services.settings.get();

    expect(setup.haUrl).toBe('http://homeassistant.local:8123');
    expect(setup.ai).toMatchObject({ provider: 'gemini' });
    expect(setup.notifiers[0]).toMatchObject({ channel: 'telegram' });
    expect(JSON.stringify({ setup, settings })).not.toContain(HA_SECRET);
    expect(JSON.stringify({ setup, settings })).not.toContain(AI_SECRET);
    expect(JSON.stringify({ setup, settings })).not.toContain(TELEGRAM_SECRET);
    expect(settings).toMatchObject({
      homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true } },
      ai: { provider: 'gemini', key: { configured: true } },
      privacyLevel: 'balanced',
      retentionDays: 30
    });
    expect(settings.ai).not.toHaveProperty('model');
    expect(await readFile(join(dataDir, 'app.db'), 'utf8')).not.toContain(AI_SECRET);
  });

  it('reopens the same /data database for settings, digest jobs, and report history', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-reopen-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'openai',
      aiKey: AI_SECRET
    });
    const firstJob = await first.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:runtime-window' });

    await (first.reports as unknown as ReportStore).save({
      id: 'digest-later',
      rendered: { format: 'markdown', body: '# Later digest' },
      summary: {
        id: 'digest-later',
        window: { from: '2026-07-12T08:00:00.000Z', to: '2026-07-12T09:00:00.000Z' },
        severityCounts: { critical: 1, warning: 2, info: 3 },
        createdAt: '2026-07-12T09:01:00.000Z',
        deliveryStatus: 'sent',
        source: 'legacy'
      }
    });
    await (first.reports as unknown as ReportStore).save({
      id: 'digest-earlier',
      rendered: { format: 'markdown', body: '# Earlier digest' },
      summary: {
        id: 'digest-earlier',
        window: { from: '2026-07-12T07:00:00.000Z', to: '2026-07-12T08:00:00.000Z' },
        severityCounts: { critical: 0, warning: 1, info: 4 },
        createdAt: '2026-07-12T08:01:00.000Z',
        deliveryStatus: 'pending',
        source: 'legacy'
      }
    });

    const reopened = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const duplicateJob = await reopened.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'manual:runtime-window' });
    const settings = await reopened.settings.get();
    const history = await reopened.reports.list();

    expect(settings.ai.provider).toBe('openai');
    expect(duplicateJob).toEqual({ status: 'already_queued', jobId: firstJob.jobId });
    expect(history).toEqual([
      {
        id: 'digest-later',
        window: { from: '2026-07-12T08:00:00.000Z', to: '2026-07-12T09:00:00.000Z' },
        severityCounts: { critical: 1, warning: 2, info: 3 },
        createdAt: '2026-07-12T09:01:00.000Z',
        deliveryStatus: 'sent',
        source: 'legacy'
      },
      {
        id: 'digest-earlier',
        window: { from: '2026-07-12T07:00:00.000Z', to: '2026-07-12T08:00:00.000Z' },
        severityCounts: { critical: 0, warning: 1, info: 4 },
        createdAt: '2026-07-12T08:01:00.000Z',
        deliveryStatus: 'pending',
        source: 'legacy'
      }
    ]);
  });

  it('reopens persisted onboarding at the next screen with secret metadata only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-onboarding-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    if (!first.onboarding) throw new Error('Expected persisted onboarding service.');

    await first.onboarding.save({ step: 'home_assistant', draft: { haUrl: 'http://homeassistant.local:8123' }, secrets: { haToken: HA_SECRET } });
    const reopened = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const progress = await reopened.onboarding?.get();

    expect(progress).toEqual(expect.objectContaining({ currentStep: 'ai_provider', completedSteps: ['home_assistant'], draft: { haUrl: 'http://homeassistant.local:8123' } }));
    expect(JSON.stringify(progress)).not.toContain(HA_SECRET);
  });

  it('retrieves stored report content after a runtime restart without exposing credentials', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-detail-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await (first.reports as unknown as ReportStore).save(report('digest-detail', NOW));
    const reopened = await createPersistentRuntimeServices({ dataDir, now: () => NOW });

    const detail = await (reopened.reports as unknown as ReportStore).get('digest-detail');
    expect(detail).toEqual(expect.objectContaining({ id: 'digest-detail', rendered: { format: 'markdown', body: '# digest-detail' } }));
    expect(JSON.stringify(detail)).not.toContain(HA_SECRET);
  });

  it('deletes one legacy report while preserving its neighbor and runtime configuration', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-delete-legacy-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await services.setup.complete({ haUrl: 'http://homeassistant.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });
    await (services.reports as unknown as ReportStore).save(report('legacy-selected', NOW));
    await (services.reports as unknown as ReportStore).save(report('legacy-neighbor', '2026-07-12T09:00:00.000Z'));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    db.prepare('insert into deliveries(id, digest_id, target_ref, status, created_at) values (?, ?, ?, ?, ?)').run('delivery-selected', 'legacy-selected', 'ref:selected', 'failed', NOW);
    db.prepare('insert into deliveries(id, digest_id, target_ref, status, created_at) values (?, ?, ?, ?, ?)').run('delivery-neighbor', 'legacy-neighbor', 'ref:neighbor', 'sent', NOW);
    db.close();
    const settingsBefore = await services.settings.get();

    await expect(services.reports.remove('legacy-selected')).resolves.toBe(true);
    await expect(services.reports.remove('legacy-selected')).resolves.toBe(false);

    expect(await services.reports.get('legacy-selected')).toBeNull();
    expect(await services.reports.get('legacy-neighbor')).not.toBeNull();
    expect(await services.settings.get()).toEqual(settingsBefore);
    const verificationDb = new DatabaseSync(join(dataDir, 'app.db'));
    expect(verificationDb.prepare('select digest_id from deliveries order by digest_id').all()).toEqual([{ digest_id: 'legacy-neighbor' }]);
    verificationDb.close();
  });

  it('removes expired history on save using configured retention without changing settings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-retention-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await services.setup.complete({ haUrl: 'http://homeassistant.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });
    const settings = await services.settings.get();
    await services.settings.update(settingsUpdate(settings, 7));

    await (services.reports as unknown as ReportStore).save(report('digest-expired', '2026-07-01T10:00:00.000Z'));
    await (services.reports as unknown as ReportStore).save(report('digest-current', '2026-07-10T10:00:00.000Z'));

    expect(await services.reports.list()).toEqual([expect.objectContaining({ id: 'digest-current' })]);
    expect(await services.settings.get()).toMatchObject({ retentionDays: 7 });
  });

  it('keeps history at the retention boundary while removing older entries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-retention-boundary-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await services.setup.complete({ haUrl: 'http://homeassistant.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });
    const settings = await services.settings.get();
    await services.settings.update(settingsUpdate(settings, 1));

    await (services.reports as unknown as ReportStore).save(report('digest-before-boundary', '2026-07-11T09:59:59.999Z'));
    await (services.reports as unknown as ReportStore).save(report('digest-at-boundary', '2026-07-11T10:00:00.000Z'));

    expect((await services.reports.list()).map((item) => item.id)).toEqual(['digest-at-boundary']);
  });

  it('caps stored reports at the configured storage limit after preserving current retention', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-storage-limit-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW, maxStoredReports: 2 });

    await (services.reports as unknown as ReportStore).save(report('digest-oldest', '2026-07-10T08:00:00.000Z'));
    await (services.reports as unknown as ReportStore).save(report('digest-middle', '2026-07-10T09:00:00.000Z'));
    await (services.reports as unknown as ReportStore).save(report('digest-newest', '2026-07-10T10:00:00.000Z'));

    expect((await services.reports.list()).map((item) => item.id)).toEqual(['digest-newest', 'digest-middle']);
  });

  it('fails startup when an existing database has encrypted secrets but app.key is missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-missing-key-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'gemini',
      aiKey: AI_SECRET
    });
    await unlink(join(dataDir, 'app.key'));

    await expect(createPersistentRuntimeServices({ dataDir, now: () => NOW })).rejects.toThrow(/app\.key.*existing encrypted secrets/i);
  });

  it('fails startup/readiness construction when app.key is corrupt before secret use', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-corrupt-key-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'gemini',
      aiKey: AI_SECRET
    });
    await writeFile(join(dataDir, 'app.key'), Buffer.from('wrong-size-key').toString('base64'));

    await expect(createPersistentRuntimeServices({ dataDir, now: () => NOW })).rejects.toThrow(/app\.key.*32-byte.*AES-256/i);
  });

  it('fails startup/readiness construction when a valid-length app.key cannot decrypt existing secrets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-wrong-key-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'gemini',
      aiKey: AI_SECRET
    });
    await writeFile(join(dataDir, 'app.key'), randomBytes(32).toString('base64'));

    await expect(createPersistentRuntimeServices({ dataDir, now: () => NOW })).rejects.toThrow(/app\.key.*decrypt.*existing encrypted secrets/i);
  });

  it('serves persisted report history through the authenticated API after recreating persistent runtime services', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-api-history-'));
    const firstServices = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await (firstServices.reports as unknown as ReportStore).save({
      id: 'digest-api-history',
      rendered: { format: 'markdown', body: '# API history digest' },
      summary: {
        id: 'digest-api-history',
        window: { from: '2026-07-12T08:00:00.000Z', to: '2026-07-12T09:00:00.000Z' },
        severityCounts: { critical: 0, warning: 2, info: 1 },
        createdAt: '2026-07-12T09:01:00.000Z',
        deliveryStatus: 'sent',
        source: 'legacy'
      }
    });

    const firstApp = createApp({ services: firstServices, auth: authOptions(), now: () => NOW });
    const firstHistory = await authenticatedGet(firstApp, '/api/digests/history');
    await firstApp.close();

    const reopenedServices = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const reopenedApp = createApp({ services: reopenedServices, auth: authOptions(), now: () => NOW });
    const reopenedHistory = await authenticatedGet(reopenedApp, '/api/digests/history');
    await reopenedApp.close();

    expect(firstHistory.statusCode).toBe(200);
    expect(reopenedHistory.statusCode).toBe(200);
    expect(reopenedHistory.json()).toEqual(firstHistory.json());
    expect(reopenedHistory.json()).toEqual([
      {
        id: 'digest-api-history',
        window: { from: '2026-07-12T08:00:00.000Z', to: '2026-07-12T09:00:00.000Z' },
        severityCounts: { critical: 0, warning: 2, info: 1 },
        createdAt: '2026-07-12T09:01:00.000Z',
        deliveryStatus: 'sent',
        source: 'legacy'
      }
    ]);
  });

  it('keeps setup secret refs decryptable after recreating services with the same /data database and app.key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-secret-reopen-'));
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.setup.complete({
      haUrl: 'http://homeassistant.local:8123',
      haToken: HA_SECRET,
      aiProvider: 'gemini',
      aiKey: AI_SECRET,
      telegram: { botToken: TELEGRAM_SECRET, chatId: '123456' }
    });

    const reopened = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const settings = await reopened.settings.get();

    expect(settings).toMatchObject({
      homeAssistant: { token: { configured: true } },
      ai: { key: { configured: true } },
      notifications: { channel: 'telegram', chatId: '123456', botToken: { configured: true } }
    });
    expect(JSON.stringify(settings)).not.toContain(HA_SECRET);
    expect(JSON.stringify(settings)).not.toContain(AI_SECRET);
    expect(JSON.stringify(settings)).not.toContain(TELEGRAM_SECRET);
  });

  it('rejects an aborted analysis store save before the SQLite insert and leaves history unchanged', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-runtime-aborted-save-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const controller = new AbortController();
    controller.abort(new Error('ANALYSIS_DEADLINE_EXCEEDED'));

    await expect((services.reports as unknown as ReportStore).save(report('late-report', NOW), {
      signal: controller.signal,
      checkpoint: () => { throw controller.signal.reason; },
      deadlineAtMs: Date.now(),
      dispose: () => undefined
    })).rejects.toThrow('ANALYSIS_DEADLINE_EXCEEDED');
    expect(await services.reports.list()).toEqual([]);
  });

  it('runs the v2 worker against fake HA, AI, and Telegram endpoints without a fake-provider fallback', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-runtime-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-07-12 10:00:00 ERROR [mqtt] connection token=do-not-send\n');
    const events = { configEntries: 0, ai: 0, telegram: 0 };
    const telegramBodies: unknown[] = [];
    const providerPrompts: string[] = [];
    const services = await createPersistentRuntimeServices({
      dataDir, now: () => NOW, haLogPath: logPath,
      haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async (request) => {
        events.ai += 1;
        providerPrompts.push(JSON.stringify(request.body));
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) };
      },
      telegramHttpClient: async (request) => { events.telegram += 1; telegramBodies.push(request.body); return { status: 200, json: async () => ({ ok: true }) }; },
      reportUrl: (reportId) => `https://digest.local/reports/${encodeURIComponent(reportId)}`
    });
    await services.auth?.createAdmin('runtime-language-password', 'es');
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    const queued = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:success' });

    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();

    expect(queued.status).toBe('queued');
    expect(events).toEqual({ configEntries: 1, ai: 1, telegram: 1 });
    expect(providerPrompts[0]).toContain('Write both string values in neutral professional Spanish.');
    expect(providerPrompts[0]).not.toContain(AI_SECRET);
    await expect(services.digestJobs.get(queued.jobId)).resolves.toMatchObject({ status: 'completed', reportId: expect.stringMatching(/^v2-report:/) });
    const committedReportId = (await services.digestJobs.get(queued.jobId))?.reportId;
    expect(telegramBodies).toEqual([expect.objectContaining({
      parse_mode: 'MarkdownV2',
      text: expect.stringContaining(`[Abrir informe](https://digest.local/reports/${encodeURIComponent(committedReportId ?? '')})`)
    })]);
    const successfulReport = await services.reports.get((await services.digestJobs.get(queued.jobId))?.reportId ?? 'missing');
    expect(successfulReport?.summary.deliveryStatus).toBe('sent');

    await (services.reports as unknown as ReportStore).save({
      id: 'legacy-report',
      rendered: { format: 'markdown', body: '# Legacy report' },
      summary: {
        id: 'legacy-report',
        window: { from: '2026-07-12T09:59:59.999Z', to: NOW },
        severityCounts: { critical: 0, warning: 0, info: 1 },
        createdAt: NOW,
        deliveryStatus: 'pending'
      }
    });
    const history = DigestHistoryResponseSchema.parse(await services.reports.list());
    expect(history.map((item) => item.id)).toEqual(expect.arrayContaining(['legacy-report', expect.stringMatching(/^v2-report:/)]));
    DigestDetailSchema.parse(await services.reports.get('legacy-report'));
    DigestDetailSchema.parse(await services.reports.get(history.find((item) => item.id.startsWith('v2-report:'))?.id ?? 'missing'));
  });

  it('ticks a due daily schedule into a v2 run and persists schedule state idempotently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-schedule-tick-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-08-17 05:30:00 ERROR [mqtt] connection token=do-not-send\n');
    const events = { configEntries: 0, ai: 0, telegram: 0 };
    const schedNow = '2026-08-17T07:00:00.000Z'; // 09:00 Europe/Madrid, after the 08:00 slot
    const services = await createPersistentRuntimeServices({
      dataDir, now: () => schedNow, haLogPath: logPath,
      haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async (request) => {
        events.ai += 1;
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) };
      },
      telegramHttpClient: async (request) => { events.telegram += 1; return { status: 200, json: async () => ({ ok: true }) }; }
    });
    await services.auth?.createAdmin('schedule-tick-password', 'es');
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    await services.settings.update({
      homeAssistant: { url: 'http://ha.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '42', botToken: { operation: 'keep_current' } },
      schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
      privacyLevel: 'balanced',
      retentionDays: 30
    });

    await (services.scheduleTicker as { tick(): Promise<void> } | undefined)?.tick();
    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(db);
    const scheduled = db.prepare(`select slot_id from v2_runs where slot_id like 'v2:schedule:%' order by created_at desc limit 1`).get() as { slot_id: string } | undefined;
    const state = db.prepare(`select last_scheduled_at from schedule_state where schedule_id = 'schedule:daily:08:00:Europe/Madrid'`).get() as { last_scheduled_at: string } | undefined;
    db.close();

    expect(scheduled?.slot_id).toMatch(/^v2:schedule:daily:08:00:Europe\/Madrid:/);
    expect(state?.last_scheduled_at).toBe('2026-08-17T06:00:00Z');

    await (services.scheduleTicker as { tick(): Promise<void> } | undefined)?.tick();
    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();
    const reopened = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(reopened);
    const count = (reopened.prepare(`select count(*) as c from v2_runs where slot_id like 'v2:schedule:%'`).get() as { c: number }).c;
    reopened.close();
    expect(count).toBe(1);

    await services.close?.();
  });

  it('marks the first run as enqueued without a spurious initial run when v2 reports already exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-schedule-seed-existing-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-08-17 05:30:00 ERROR [mqtt] connection token=do-not-send\n');
    const events = { configEntries: 0, ai: 0, telegram: 0 };
    const schedNow = '2026-08-17T07:00:00.000Z';
    const services = await createPersistentRuntimeServices({
      dataDir, now: () => schedNow, haLogPath: logPath,
      haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async (request) => {
        events.ai += 1;
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) };
      },
      telegramHttpClient: async (request) => { events.telegram += 1; return { status: 200, json: async () => ({ ok: true }) }; }
    });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    await services.settings.update({
      homeAssistant: { url: 'http://ha.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '42', botToken: { operation: 'keep_current' } },
      schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
      privacyLevel: 'balanced',
      retentionDays: 30
    });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const seed = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(seed);
    seed.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('existing-run', 'manual:seed', 'reported', null, '2026-08-16T00:00:00.000Z');
    seed.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:existing', 'existing-run', 'reported', JSON.stringify({ report: { warnings: [] }, signatures: [] }), '2026-08-16T00:00:00.000Z');
    seed.close();

    await (services.scheduleTicker as { tick(): Promise<void> } | undefined)?.tick();
    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();

    const db = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(db);
    const initialCount = (db.prepare(`select count(*) as c from v2_runs where slot_id = 'v2:initial'`).get() as { c: number }).c;
    const scheduledCount = (db.prepare(`select count(*) as c from v2_runs where slot_id like 'v2:schedule:%'`).get() as { c: number }).c;
    const seeded = db.prepare(`select first_run_enqueued_at from schedule_state where schedule_id = '__initial__'`).get() as { first_run_enqueued_at: string } | undefined;
    db.close();

    expect(initialCount).toBe(0);
    expect(scheduledCount).toBe(1);
    expect(seeded?.first_run_enqueued_at).toBe(schedNow);

    await services.close?.();
  });

  it('enqueues the v2 initial run on the first tick of a fresh install with a schedule', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-schedule-seed-fresh-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-08-17 05:30:00 ERROR [mqtt] connection token=do-not-send\n');
    const events = { configEntries: 0, ai: 0, telegram: 0 };
    const schedNow = '2026-08-17T07:00:00.000Z';
    const services = await createPersistentRuntimeServices({
      dataDir, now: () => schedNow, haLogPath: logPath,
      haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async (request) => {
        events.ai += 1;
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) };
      },
      telegramHttpClient: async (request) => { events.telegram += 1; return { status: 200, json: async () => ({ ok: true }) }; }
    });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    await services.settings.update({
      homeAssistant: { url: 'http://ha.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '42', botToken: { operation: 'keep_current' } },
      schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
      privacyLevel: 'balanced',
      retentionDays: 30
    });

    await (services.scheduleTicker as { tick(): Promise<void> } | undefined)?.tick();
    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(db);
    const initialCount = (db.prepare(`select count(*) as c from v2_runs where slot_id = 'v2:initial'`).get() as { c: number }).c;
    const scheduledCount = (db.prepare(`select count(*) as c from v2_runs where slot_id like 'v2:schedule:%'`).get() as { c: number }).c;
    const seeded = db.prepare(`select first_run_enqueued_at from schedule_state where schedule_id = '__initial__'`).get() as { first_run_enqueued_at: string } | undefined;
    db.close();

    expect(initialCount).toBe(1);
    expect(scheduledCount).toBe(1);
    expect(seeded?.first_run_enqueued_at).toBe(schedNow);

    await services.close?.();
  });

  it('maps persisted schedule DTOs to stable scheduler definitions with the HA day shift', () => {
    expect(toScheduleDefinitions([{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }])).toEqual([
      { id: 'schedule:daily:08:00:Europe/Madrid', mode: 'preset', preset: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }
    ]);
    expect(toScheduleDefinitions([{ kind: 'weekly', enabled: true, time: '09:00', timezone: 'Europe/Madrid', dayOfWeek: 0 }])).toEqual([
      { id: 'schedule:weekly:09:00:Europe/Madrid', mode: 'preset', preset: 'weekly', enabled: true, time: '09:00', timezone: 'Europe/Madrid', dayOfWeek: 1 }
    ]);
    expect(toScheduleDefinitions([{ kind: 'weekly', enabled: true, time: '09:00', timezone: 'Europe/Madrid', dayOfWeek: 6 }])).toEqual([
      { id: 'schedule:weekly:09:00:Europe/Madrid', mode: 'preset', preset: 'weekly', enabled: true, time: '09:00', timezone: 'Europe/Madrid', dayOfWeek: 7 }
    ]);
  });

  it('returns schema-valid combined history after repairing legacy reports beside failed and successful v2 entries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-combined-history-'));
    const initial = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await initial.close?.();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(db);
    db.prepare(`insert into reports(
      id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`).run(
      'legacy-invalid',
      '2026-07-31T21:46:10.471Z',
      '2026-07-31T21:46:10.471Z',
      '{"critical":0,"warning":1,"info":0}',
      '# Legacy report',
      null,
      '2026-07-31T21:46:10.471Z'
    );
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('successful-v2', 'slot-successful-v2', 'reported', null, '2026-07-31T21:46:11.000Z');
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:successful-v2', 'successful-v2', 'reported', JSON.stringify({ report: { warnings: [] }, signatures: [] }), '2026-07-31T21:46:11.000Z');
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('failed-v2', 'slot-failed-v2', 'failed', 'REPORT_MISSING', '2026-07-31T21:46:12.000Z');
    db.close();

    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    try {
      const history = DigestHistoryResponseSchema.parse(await services.reports.list());

      expect(history).toHaveLength(3);
      expect(history.map((item) => item.id)).toEqual(expect.arrayContaining(['legacy-invalid', 'v2-report:successful-v2', 'v2-run:failed-v2']));
      expect(history.find((item) => item.id === 'legacy-invalid')).toMatchObject({ source: 'legacy' });
      expect(history.find((item) => item.id === 'legacy-invalid')?.window).toEqual({
        from: '2026-07-31T21:46:10.470Z',
        to: '2026-07-31T21:46:10.471Z'
      });
      expect(history.find((item) => item.id === 'v2-report:successful-v2')).toMatchObject({ runStatus: 'reported', source: 'v2' });
      expect(history.find((item) => item.id === 'v2-run:failed-v2')).toMatchObject({ runStatus: 'failed', source: 'v2', warningCodes: ['REPORT_MISSING'] });
    } finally {
      await services.close?.();
    }
  });

  it('normalizes an invalid legacy delivery status before history and detail projection', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-legacy-status-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await (services.reports as unknown as ReportStore).save({
      id: 'legacy-invalid-delivery',
      rendered: { format: 'markdown', body: '# Legacy report' },
      summary: {
        id: 'legacy-invalid-delivery',
        window: { from: '2026-07-12T09:00:00.000Z', to: '2026-07-12T09:01:00.000Z' },
        severityCounts: { critical: 0, warning: 0, info: 1 },
        createdAt: NOW,
        deliveryStatus: 'pending'
      }
    });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const connection = new DatabaseSync(join(dataDir, 'app.db'));
    connection.prepare('update reports set compressed_payload = ? where id = ?').run(gzipSync(JSON.stringify({ summary: { deliveryStatus: 'corrupt-delivery' } })), 'legacy-invalid-delivery');
    connection.close();

    const history = DigestHistoryResponseSchema.parse(await services.reports.list());
    const detail = DigestDetailSchema.parse(await services.reports.get('legacy-invalid-delivery'));

    expect(history.find((item) => item.id === 'legacy-invalid-delivery')?.deliveryStatus).toBe('pending');
    expect(detail.summary.deliveryStatus).toBe('pending');
    await services.close?.();
  });

  it('sanitizes v2 payload, service detail, and API presentation with the configured provider key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-api-boundary-'));
    const initial = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const configuredKey = 'opaque-runtime-provider-key-fixture';
    await initial.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: configuredKey });
    await initial.close?.();

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    runMigrations(db);
    const [entry] = parseHomeAssistantLog(['2026-07-12 10:00:00 ERROR [mqtt] connection failed']);
    if (!entry) throw new Error('Expected a parsed test entry.');
    db.prepare(`insert into v2_signatures(signature, component, level, normalized_message, first_seen_at, last_seen_at, total_count, previous_period_count)
      values (?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.signature, entry.component, entry.level, entry.normalizedMessage, entry.at, entry.at, 1, 0);
    db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run('api-boundary-run', 'api-boundary-slot', 'reported', null, NOW);
    db.prepare('insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)')
      .run('v2-report:api-boundary-run', 'api-boundary-run', 'reported', JSON.stringify({
        report: {
          status: 'reported',
          warnings: [],
          findings: [{ signature: entry.signature, analysis: { summary: `Summary ${configuredKey}`, recommendation: `Recommendation ${configuredKey}` }, providerControlled: configuredKey }]
        },
        signatures: [{ signature: entry.signature, component: entry.component, level: entry.level, normalizedMessage: entry.normalizedMessage, classification: 'new', trend: 'new', occurrences: [entry] }]
      }), NOW);
    db.close();

    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const detail = await services.reports.get('v2-report:api-boundary-run');
    const app = createApp({ services, auth: authOptions(), now: () => NOW });
    const response = await authenticatedGet(app, '/api/digests/v2-report:api-boundary-run');

    expect(JSON.stringify(detail)).not.toContain(configuredKey);
    expect(JSON.stringify(detail)).not.toContain('providerControlled');
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(configuredKey);
    expect(JSON.stringify(response.json())).not.toContain('providerControlled');
    DigestDetailSchema.parse(response.json());
    await app.close();
    await services.close?.();
  });

  it('applies the configured warning toggle to real queued batch runs while preserving the default exclusion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-warning-toggle-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-07-12 10:00:00 WARNING [mqtt] transient warning one\n');
    const events = { configEntries: 0, ai: 0 };
    const services = await createPersistentRuntimeServices({
      dataDir, now: () => NOW, haLogPath: logPath, haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async () => {
        events.ai += 1;
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT warning', recommendation: 'Monitor MQTT' }) }] } }] }) };
      }
    });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });

    const excluded = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:warnings-excluded' });
    await (services.digestWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    await expect(services.digestJobs.get(excluded.jobId)).resolves.toMatchObject({ status: 'completed', reportId: expect.stringMatching(/^v2-report:/) });
    expect(events.ai).toBe(0);
    const excludedJob = await services.digestJobs.get(excluded.jobId);
    await expect(services.reports.get(excludedJob?.reportId ?? 'missing')).resolves.toMatchObject({ summary: { deliveryStatus: 'skipped' }, presentation: { mode: 'batch', signatures: [] } });

    const current = await services.settings.get();
    await services.settings.update({ ...settingsUpdate(current, current.retentionDays), includeWarnings: true });
    await writeFile(logPath, '2026-07-12 10:01:00 WARNING [mqtt] transient warning two\n', { flag: 'a' });
    const included = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:warnings-included' });
    await (services.digestWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    expect(events.ai).toBe(1);
    const job = await services.digestJobs.get(included.jobId);
    const report = await services.reports.get(job?.reportId ?? 'missing');
    expect(report?.presentation).toMatchObject({ mode: 'batch', signatures: [expect.objectContaining({ level: 'WARNING' })] });
  });

  it('persists ignored signatures and tagged notes across a restart for the next v2 report', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-context-rules-'));
    const logPath = join(dataDir, 'home-assistant.log');
    const lines = [
      '2026-07-12 10:00:00 ERROR [mqtt] ignored connection failure',
      '2026-07-12 10:01:00 ERROR [zwave] reviewed connection failure'
    ];
    const [ignored, noted] = parseHomeAssistantLog(lines);
    if (!ignored || !noted) throw new Error('Expected test signatures.');
    const first = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    await first.ignores.add({ match: ignored.signature });
    await first.notes.add({ text: 'Operator already checked this device.', occurredAt: NOW, tags: [noted.signature] });
    await first.close?.();

    await writeFile(logPath, `${lines.join('\n')}\n`);
    const events = { configEntries: 0, ai: 0 };
    const reopened = await createPersistentRuntimeServices({
      dataDir, now: () => NOW, haLogPath: logPath, haWebSocketFactory: () => fakeHaSocket(events),
      providerHttpClient: async () => {
        events.ai += 1;
        return { status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Z-Wave failure', recommendation: 'Inspect Z-Wave' }) }] } }] }) };
      }
    });
    await reopened.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });
    const queued = await reopened.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:context-rules' });
    await (reopened.digestWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    expect(events.ai).toBe(1);
    const job = await reopened.digestJobs.get(queued.jobId);
    const report = await reopened.reports.get(job?.reportId ?? 'missing');
    expect(report?.presentation).toMatchObject({
      mode: 'batch',
      signatures: [expect.objectContaining({
        signature: noted.signature,
        notes: [expect.objectContaining({ text: 'Operator already checked this device.' })]
      })]
    });
  });

  it('stores a usable partial report instead of provider failure text when every AI call fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-no-fallback-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-07-12 10:00:00 ERROR [mqtt] connection failed\n');
    const rawProviderMessage = "models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent. token=AIzaSyA1B2C3D4E5F6G7H8";
    const failures: Array<{ errorCode: string; errorMessage: string }> = [];
     const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW, haLogPath: logPath, digestFailureReporter: (event) => failures.push(event), providerHttpClient: async () => ({ status: 404, json: async () => ({ error: { message: rawProviderMessage } }) }) });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET });
    const queued = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:no-fallback' });

    await (services.digestWorker as { runOnce(): Promise<void> } | undefined)?.runOnce();

    const stored = await services.digestJobs.get(queued.jobId);
    expect(stored).toMatchObject({ status: 'completed', reportId: `v2-report:${queued.jobId}` });
    expect(stored?.errorMessage).toBeUndefined();
    expect(failures).toEqual([]);

    const app = createApp({ services, auth: authOptions() });
    const response = await authenticatedGet(app, `/api/digests/jobs/${queued.jobId}`);
    const partialReport = DigestDetailSchema.parse(await services.reports.get(`v2-report:${queued.jobId}`));
    expect(partialReport.presentation).toMatchObject({ mode: 'batch', status: 'partial', warnings: expect.arrayContaining(['AI_ANALYSIS_UNAVAILABLE']), signatures: [expect.objectContaining({ occurrences: 1 })] });
    expect(JSON.stringify(partialReport)).not.toContain(rawProviderMessage);
    expect(JSON.stringify(partialReport)).not.toContain(AI_SECRET);
    const detailResponse = await authenticatedGet(app, `/api/digests/v2-report:${queued.jobId}`);
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({ presentation: { status: 'partial', warnings: expect.arrayContaining(['AI_ANALYSIS_UNAVAILABLE']) } });
    expect(JSON.stringify(detailResponse.json())).not.toContain(rawProviderMessage);
    await app.close();
    await services.close?.();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'completed', reportId: `v2-report:${queued.jobId}` });
    expect(JSON.stringify(response.json())).not.toContain(AI_SECRET);
  });

  it('records failed Telegram delivery after committing the v2 report', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-v2-delivery-failure-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-07-12 10:00:00 ERROR [mqtt] connection failed\n');
    const services = await createPersistentRuntimeServices({
      dataDir,
      now: () => NOW,
      haLogPath: logPath,
      providerHttpClient: async () => ({ status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) }),
      telegramHttpClient: async () => ({ status: 500, json: async () => ({ ok: false }) })
    });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    const queued = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:delivery-failure' });

    await (services.digestWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const job = await services.digestJobs.get(queued.jobId);
    const report = await services.reports.get(job?.reportId ?? 'missing');
    expect(job).toMatchObject({ status: 'completed', reportId: expect.stringMatching(/^v2-report:/) });
    expect(report?.summary.deliveryStatus).toBe('failed');
  });

  it('projects old stored Markdown as legacy and redacts it at service and API boundaries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-legacy-boundary-'));
    const services = await createPersistentRuntimeServices({ dataDir, now: () => NOW });
    const rawSecrets = ['legacy-bearer-fixture', 'legacy-token-fixture', 'legacy-api-key-fixture', 'legacy-query-token-fixture'];
    const body = `# Home Assistant Digest\n\n**Severity:** warning\n\nReview model retired classification.\n\n## Attention items\n\n- **Provider failure** (warning): Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api-key: ${rawSecrets[2]} https://provider.test/run?token=${rawSecrets[3]}`;
    await (services.reports as unknown as ReportStore).save({
      id: 'legacy-unsafe',
      rendered: { format: 'markdown', body },
      summary: { id: 'legacy-unsafe', window: { from: '2026-07-12T09:00:00.000Z', to: NOW }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: NOW, deliveryStatus: 'pending' }
    });

    const detail = await services.reports.get('legacy-unsafe');
    expect(detail).toMatchObject({ source: 'legacy', presentation: { version: 1, mode: 'legacy_markdown' } });
    expect(JSON.stringify(detail)).toContain('model retired');
    for (const secret of rawSecrets) expect(JSON.stringify(detail)).not.toContain(secret);

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    const stored = db.prepare('select rendered_markdown, compressed_payload from reports where id = ?').get('legacy-unsafe') as { rendered_markdown: string; compressed_payload: Buffer };
    const persistedDetail = `${stored.rendered_markdown}\n${gunzipSync(stored.compressed_payload).toString('utf8')}`;
    for (const secret of rawSecrets) expect(persistedDetail).not.toContain(secret);
    db.close();

    const app = createApp({ services, auth: authOptions(), now: () => NOW });
    const response = await authenticatedGet(app, '/api/digests/legacy-unsafe');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ source: 'legacy', presentation: { version: 1, mode: 'legacy_markdown' } });
    for (const secret of rawSecrets) expect(JSON.stringify(response.json())).not.toContain(secret);
    await app.close();
    await services.close?.();
  });

  it('persists manual Telegram actions separately without mutating automatic generation state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-manual-telegram-'));
    const logPath = join(dataDir, 'home-assistant.log');
    await writeFile(logPath, '2026-07-12 10:00:00 ERROR [mqtt] private trace content\n');
    const requests: Array<{ body: unknown }> = [];
    const operationalEvents: unknown[] = [];
    const services = await createPersistentRuntimeServices({
      dataDir,
      now: () => NOW,
      haLogPath: logPath,
      providerHttpClient: async () => ({ status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'MQTT failed', recommendation: 'Restart MQTT' }) }] } }] }) }),
      telegramHttpClient: async (request) => { requests.push({ body: request.body }); return { status: 200, json: async () => ({ ok: true }) }; },
      operationalEventReporter: (event) => operationalEvents.push(event),
      reportUrl: (reportId) => `https://digest.test/reports/${encodeURIComponent(reportId)}`
    });
    await services.setup.complete({ haUrl: 'http://ha.local:8123', haToken: HA_SECRET, aiProvider: 'gemini', aiKey: AI_SECRET, telegram: { botToken: TELEGRAM_SECRET, chatId: '42' } });
    const queued = await services.digestJobs.enqueue({ kind: 'manual', triggerWindowId: 'v2:manual-telegram' });
    await (services.digestWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    const job = await services.digestJobs.get(queued.jobId);
    const reportId = job?.reportId ?? 'missing';
    const before = DigestDetailSchema.parse(await services.reports.get(reportId));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'app.db'));
    const payloadBeforeManualSends = (db.prepare('select payload_json from v2_reports where id = ?').get(reportId) as { payload_json: string }).payload_json;
    const firstAction = '11111111-1111-4111-8111-111111111111';
    const secondAction = '22222222-2222-4222-8222-222222222222';

    await services.manualTelegram?.send(reportId, firstAction);
    await services.manualTelegram?.send(reportId, firstAction);
    await services.manualTelegram?.send(reportId, secondAction);

    const after = DigestDetailSchema.parse(await services.reports.get(reportId));
    expect(requests).toHaveLength(3);
    expect(after.summary.deliveryStatus).toBe(before.summary.deliveryStatus);
    expect(after.summary.deliveryStatus).toBe('sent');
    expect(after.manualTelegram).toMatchObject({ configured: true, attempts: [
      expect.objectContaining({ actionId: secondAction, status: 'sent' }),
      expect.objectContaining({ actionId: firstAction, status: 'sent' })
    ] });
    expect(JSON.stringify(requests.map(({ body }) => body))).not.toContain('private trace content');
    expect(JSON.stringify(after)).not.toContain(TELEGRAM_SECRET);
    expect(JSON.stringify(operationalEvents)).not.toMatch(/private trace content|sentinel-telegram|chat/i);

    expect(db.prepare('select delivery_status from v2_runs where id = ?').get(queued.jobId)).toEqual({ delivery_status: 'sent' });
    expect(db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get(reportId)).toEqual({ status: 'sent' });
    const payloadBeforeDelete = db.prepare('select payload_json from v2_reports where id = ?').get(reportId) as { payload_json: string };
    expect(payloadBeforeDelete.payload_json).toBe(payloadBeforeManualSends);
    expect(JSON.parse(payloadBeforeDelete.payload_json)).toMatchObject({ report: { deliveryStatus: 'sent' } });
    const rows = db.prepare('select * from manual_telegram_sends where report_id = ?').all(reportId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0] ?? {})).not.toEqual(expect.arrayContaining(['target_ref', 'token', 'chat_id', 'message_text', 'response_body', 'request_url', 'ip']));
    expect(JSON.stringify(rows)).not.toMatch(/private trace content|sentinel-telegram|owner@example|192\.0\.2\.10/);

    await services.reports.remove(reportId);
    expect(db.prepare('select count(*) as count from manual_telegram_sends where report_id = ?').get(reportId)).toEqual({ count: 0 });
    db.close();
    await services.close?.();
  });
});

function authOptions() {
  return { sessionTtlMs: 60_000 };
}

async function authenticatedGet(app: ReturnType<typeof createApp>, url: string) {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { password: 'persistent-runtime-password', language: 'en' } });
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { password: 'persistent-runtime-password' } });
  return app.inject({ method: 'GET', url, headers: { cookie: login.headers['set-cookie'] } });
}

async function openSecretStore(dataDir: string): Promise<SQLiteSecretStore> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  runMigrations(db);
  return SQLiteSecretStore.create({ db, dataDir });
}

function settingsUpdate(settings: Awaited<ReturnType<Awaited<ReturnType<typeof createPersistentRuntimeServices>>['settings']['get']>>, retentionDays: number) {
  return {
    homeAssistant: { url: settings.homeAssistant.url, token: { operation: 'keep_current' as const } },
    ai: { provider: settings.ai.provider, key: { operation: 'keep_current' as const } },
    notifications: settings.notifications.channel === 'telegram'
      ? { channel: 'telegram' as const, chatId: settings.notifications.chatId, botToken: { operation: 'keep_current' as const } }
      : { channel: 'none' as const },
    schedules: settings.schedules.length ? settings.schedules : [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
    privacyLevel: settings.privacyLevel,
    retentionDays
  };
}

function report(id: string, createdAt: string): Parameters<ReportStore['save']>[0] {
  return {
    id,
    rendered: { format: 'markdown', body: `# ${id}` },
    summary: {
      id,
      window: { from: createdAt, to: createdAt },
      severityCounts: { critical: 0, warning: 0, info: 1 },
      createdAt,
      deliveryStatus: 'pending'
    }
  };
}

function fakeHaSocket(events: { configEntries: number }) {
  const socket = {
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
    close: () => undefined,
    send: (data: string) => {
      const request = JSON.parse(data) as { type: string; id?: number };
      if (request.type === 'auth') queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) }));
      if (request.type === 'config_entries/get') {
        events.configEntries += 1;
        queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'result', id: request.id, success: true, result: [{ domain: 'mqtt', title: 'MQTT', state: 'loaded' }] }) }));
      }
    }
  };
  queueMicrotask(() => {
    socket.onopen?.({});
    queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ type: 'auth_required', ha_version: '2026.8.0' }) }));
  });
  return socket;
}
