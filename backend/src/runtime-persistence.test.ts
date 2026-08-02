import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './adapters/persistence/migrations.js';
import { SQLiteSecretStore } from './adapters/persistence/sqlite-secret-store.js';
import type { ReportStore } from './domain/stores.js';
import { createApp } from './http/app.js';
import { createPersistentRuntimeServices } from './runtime-persistence.js';

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
        deliveryStatus: 'sent'
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
        deliveryStatus: 'pending'
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
        deliveryStatus: 'sent'
      },
      {
        id: 'digest-earlier',
        window: { from: '2026-07-12T07:00:00.000Z', to: '2026-07-12T08:00:00.000Z' },
        severityCounts: { critical: 0, warning: 1, info: 4 },
        createdAt: '2026-07-12T08:01:00.000Z',
        deliveryStatus: 'pending'
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
        deliveryStatus: 'sent'
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
        deliveryStatus: 'sent'
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
});

function authOptions() {
  return { adminToken: 'admin-sentinel-value', setupToken: 'setup-sentinel-value', sessionTtlMs: 60_000 };
}

async function authenticatedGet(app: ReturnType<typeof createApp>, url: string) {
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { adminToken: 'admin-sentinel-value' } });
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
