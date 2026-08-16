import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryStatusSchema, type DigestSummary, type MaskedSettings, type RedactedSettingsDto, type SetupValidationRequest } from '@ha-digest/shared';
import { runMigrations } from './adapters/persistence/migrations.js';
import { SQLiteDigestJobStore } from './adapters/persistence/sqlite-digest-job-store.js';
import { SQLiteSecretStore } from './adapters/persistence/sqlite-secret-store.js';
import { SQLiteOnboardingStore } from './adapters/persistence/sqlite-onboarding-store.js';
import type { BackendApiServices } from './http/app.js';
import type { ReportStore } from './domain/stores.js';
import type { ExecutionContext } from './domain/execution.js';
import { HomeAssistantLogDeltaReader } from './adapters/ha/log-reader.js';
import { HomeAssistantWebSocketClient, type HomeAssistantSocket } from './adapters/ha/websocket-client.js';
import { createSignatureProvider, type ProviderHttpClient } from './adapters/ai/providers.js';
import { TelegramNotifier, type NotifierHttpClient } from './adapters/notifiers/notifiers.js';
import { SQLiteV2Stores } from './adapters/persistence/sqlite-v2-stores.js';
import { SQLiteManualTelegramSendStore } from './adapters/persistence/sqlite-manual-telegram-send-store.js';
import { SQLiteAuthStore } from './adapters/persistence/sqlite-auth-store.js';
import { BatchReportRun } from './application/batch-report-run.js';
import { DigestWorker, type DigestWorkerFailureEvent } from './application/digest-worker.js';
import type { RuntimeOperationalEvent } from './runtime-logging.js';
import { SettingsService, type SecretReplacement } from './application/settings.js';
import { projectLegacyReportPresentation } from './application/report-presentation.js';
import { redactProviderError } from './domain/safe-error.js';
import { ManualTelegramSendService } from './application/manual-telegram-send.js';

export type PersistentRuntimeOptions = {
  dataDir?: string;
  now?: () => string;
  maxStoredReports?: number;
  haLogPath?: string;
  haMaxStates?: number;
  haMaxLogLines?: number;
  haMaxResponseBytes?: number;
  haAnalysisTimeoutMs?: number;
  providerHttpClient?: ProviderHttpClient;
  telegramHttpClient?: NotifierHttpClient;
  haWebSocketFactory?: (url: string) => HomeAssistantSocket;
  reportUrl?: (reportId: string) => string | undefined;
  digestFailureReporter?: (event: DigestWorkerFailureEvent) => void;
  operationalEventReporter?: (event: RuntimeOperationalEvent) => void;
};

const SETTINGS_KEY = 'runtime';
const DEFAULT_MAX_STORED_REPORTS = 1_000;

export async function createPersistentRuntimeServices(options: PersistentRuntimeOptions = {}): Promise<BackendApiServices> {
  const dataDir = options.dataDir ?? '/data';
  await mkdir(dataDir, { recursive: true });

  const db = new DatabaseSync(join(dataDir, 'app.db'));
  runMigrations(db);

  const now = options.now ?? (() => new Date().toISOString());
  const clock = { now: () => new Date(now()) };
  const secretStore = await SQLiteSecretStore.create({ db, dataDir });
  const onboarding = new SQLiteOnboardingStore(db, secretStore);
  const auth = new SQLiteAuthStore(db, () => Date.parse(now()));
  const settingsStore = new SQLiteRuntimeSettingsStore(db, secretStore);
  const settings = new SettingsService(settingsStore, secretStore);
  const reports = new SQLiteReportStore(db, () => settingsStore.get(), now, options.maxStoredReports ?? DEFAULT_MAX_STORED_REPORTS);

  const digestJobs = new SQLiteDigestJobStore(db, clock);
  const v2Stores = new SQLiteV2Stores(db, 10, now, async () => {
    const current = await settingsStore.get();
    if (current.secretRefs.aiKeyRef.startsWith('unconfigured:')) return undefined;
    return secretStore.resolve(current.secretRefs.aiKeyRef);
  });
  const manualTelegramAttempts = new SQLiteManualTelegramSendStore(db, now);
  const getUnifiedReport = async (id: string) => {
    const v2Report = await v2Stores.getReport(id);
    if (v2Report) return { ...v2Report, source: 'v2' as const };
    const legacyReport = await reports.get(id);
    if (!legacyReport) return null;
    const rendered = { ...legacyReport.rendered, body: redactProviderError(legacyReport.rendered.body) };
    return { ...legacyReport, source: 'legacy' as const, rendered, presentation: projectLegacyReportPresentation({ ...legacyReport, rendered }) };
  };
  const telegramConfigured = async () => {
    const current = await settingsStore.get();
    const targetRef = current.secretRefs.notifierRefs?.telegram;
    return Boolean(targetRef && !targetRef.startsWith('unconfigured:'));
  };
  const manualTelegram = new ManualTelegramSendService({
    reports: { get: getUnifiedReport },
    attempts: manualTelegramAttempts,
    notifier: {
      configured: telegramConfigured,
      send: async (summary) => {
        const current = await settingsStore.get();
        const targetRef = current.secretRefs.notifierRefs?.telegram;
        if (!targetRef || targetRef.startsWith('unconfigured:')) return { status: 'failed', targetRef: 'telegram:unconfigured', errorCode: 'configuration_failed' };
        try {
          const creds = JSON.parse(await secretStore.resolve(targetRef)) as { botToken: string; chatId: string };
          return await new TelegramNotifier({ now, httpClient: options.telegramHttpClient }).sendManualSummary(summary, { channel: 'telegram', label: 'Telegram', config: creds });
        } catch {
          return { status: 'failed', targetRef: 'telegram:configured', errorCode: 'configuration_failed' };
        }
      }
    },
    reportUrl: options.reportUrl,
    language: () => auth.language(),
    now
  });
  let worker: DigestWorker | undefined;
  const services: BackendApiServices = {
    close: async () => { await worker?.stop(); db.close(); },
    health: {
      async check() {
        try {
          db.prepare('select 1').get();
          return { ok: true as const };
        } catch {
          return { ok: false as const, reason: 'persistence_unavailable' };
        }
      }
    },
    setup: { complete: (input) => settingsStore.completeSetup(input) },
    auth,
    onboarding: { get: () => onboarding.get(), save: (input) => onboarding.save(input), complete: () => onboarding.complete() },
    settings: {
      get: () => settings.get(),
      update: (input) => settings.update(input),
      notificationTarget: (channel) => settings.notificationTarget(channel)
    },
    digestJobs,
    reports: {
      save: reports.save.bind(reports),
      list: async () => [...await v2Stores.listReports(), ...await reports.list()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      get: async (id) => {
        const report = await getUnifiedReport(id);
        if (!report) return null;
        const sendable = !id.startsWith('v2-run:') && !(report.presentation?.mode === 'batch' && report.presentation.status === 'failed');
        return sendable ? { ...report, manualTelegram: { configured: await telegramConfigured(), attempts: await manualTelegram.list(id) } } : report;
      },
      remove: async (id) => await v2Stores.removeReport(id) || await reports.remove(id),
      removeBatch: async (ids: string[]) => {
        if (ids.length === 0) return 0;
        let count = 0;
        for (const id of ids) {
          if (await v2Stores.removeReport(id) || await reports.remove(id)) count += 1;
        }
        return count;
      }
    },
    notes: v2Stores,
    ignores: {
      add: (input) => v2Stores.addIgnore(input),
      remove: (id) => v2Stores.remove(id),
      listActive: (at) => v2Stores.listActive(at)
    },
    manualTelegram: { send: (reportId, actionId) => manualTelegram.send(reportId, actionId) },
    notifiers: {
      async test(input) {
        try {
          const raw = await secretStore.resolve(input.targetRef);
          const creds = JSON.parse(raw) as { botToken: string; chatId: string };
          const target = { channel: 'telegram' as const, label: `Telegram ${creds.chatId}`, config: { botToken: creds.botToken, chatId: creds.chatId } };
          return new TelegramNotifier({ now }).test(target);
        } catch {
          return { status: 'failed', message: 'Could not resolve Telegram credentials.', checkedAt: now() };
        }
      },
      async send(input) {
        const report = await reports.get(input.digestId);
        if (!report) return { status: 'failed', targetRef: input.targetRef, message: 'Report not found.' };
        try {
          const raw = await secretStore.resolve(input.targetRef);
          const creds = JSON.parse(raw) as { botToken: string; chatId: string };
          const target = { channel: 'telegram' as const, label: `Telegram ${creds.chatId}`, config: { botToken: creds.botToken, chatId: creds.chatId } };
          return new TelegramNotifier({ now }).send({ format: 'markdown', body: report.rendered.body }, target);
        } catch {
          return { status: 'failed', targetRef: input.targetRef, message: 'Could not resolve Telegram credentials.' };
        }
      }
    }
  };
  if (options.haLogPath) {
    const logReader = new HomeAssistantLogDeltaReader({ path: options.haLogPath });
    const batch = new BatchReportRun({
      log: { read: async () => logReader.read(await v2Stores.readCursor()) },
      signatures: v2Stores,
      persistence: v2Stores,
      provider: {
        analyze: async (context, signal, language) => {
          const current = await settingsStore.get();
          if (current.secretRefs.aiKeyRef.startsWith('unconfigured:')) throw new Error('AI_PROVIDER_UNAVAILABLE');
          const apiKey = await secretStore.resolve(current.secretRefs.aiKeyRef);
          return createSignatureProvider(current.aiProvider, { apiKey, httpClient: options.providerHttpClient, timeoutMs: options.haAnalysisTimeoutMs }).analyze(context, signal, language);
        }
      },
      haStatus: {
        snapshot: async () => {
          const current = await settingsStore.get();
          return new HomeAssistantWebSocketClient({ haUrl: current.haUrl, haTokenRef: current.secretRefs.haTokenRef, secrets: secretStore, webSocketFactory: options.haWebSocketFactory }).snapshot();
        }
      },
      ignores: v2Stores,
      notes: v2Stores,
      notifier: {
        notify: async (summary) => {
          const current = await settingsStore.get();
          const targetRef = current.secretRefs.notifierRefs?.telegram;
          if (!targetRef || targetRef.startsWith('unconfigured:')) return { status: 'skipped' as const, targetRef: 'telegram:unconfigured' };
          try {
            const creds = JSON.parse(await secretStore.resolve(targetRef)) as { botToken: string; chatId: string };
            return await new TelegramNotifier({ now, httpClient: options.telegramHttpClient }).sendSummary(summary, { channel: 'telegram', label: 'Telegram', config: creds });
          } catch {
            return { status: 'failed' as const, targetRef: 'telegram:configured', errorCode: 'configuration_failed' as const, message: 'Telegram configuration could not be resolved.' };
          }
        }
      },
      reportUrl: options.reportUrl,
      language: () => auth.language(),
      now,
      eventReporter: options.operationalEventReporter
    });
    worker = new DigestWorker({
      jobs: digestJobs,
      failureReporter: options.digestFailureReporter,
      eventReporter: options.operationalEventReporter,
      analysis: {
        runWithStages: async (onStage, job) => {
          await onStage('collecting');
          const current = await settingsStore.get();
          const request = { runId: job?.id ?? randomUUID(), slotId: job?.triggerWindowId ?? `runtime:${randomUUID()}`, includeWarnings: current.includeWarnings ?? false };
          const outcome = await batch.run(request);
          if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
          await onStage('saving');
          return { status: 'completed', reportId: outcome.reportId };
        }
      }
    });
    services.digestWorker = worker;
    worker.start();
  }
  return services;
}

class SQLiteRuntimeSettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets: SQLiteSecretStore
  ) {}

  async completeSetup(input: SetupValidationRequest): Promise<MaskedSettings> {
    const ha = await this.secrets.put('home_assistant', input.haToken);
    const ai = await this.secrets.put('ai_provider', input.aiKey);
    const notifierRefs: Record<string, string> = {};
    const notifiers: MaskedSettings['notifiers'] = [];

    if (input.telegram) {
      const telegram = await this.secrets.put('notifier', JSON.stringify({ botToken: input.telegram.botToken, chatId: input.telegram.chatId }));
      notifierRefs.telegram = telegram.ref;
      notifiers.push({
        id: 'telegram',
        channel: 'telegram',
        targetRef: telegram.ref,
        label: `Telegram ${input.telegram.chatId}`,
        secretMask: telegram.mask
      });
    }

    await this.save({
      haUrl: input.haUrl,
      aiProvider: input.aiProvider,
      secretRefs: { haTokenRef: ha.ref, aiKeyRef: ai.ref, notifierRefs },
      schedules: [],
      privacyLevel: 'balanced',
      retentionDays: 30,
      includeWarnings: false
    });

    return { haUrl: input.haUrl, ai: { provider: input.aiProvider, keyMask: ai.mask, ref: ai.ref }, notifiers };
  }

  async get(): Promise<RedactedSettingsDto> {
    const row = this.db.prepare('select value_json from settings where key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined;
    if (!row) return defaultSettings();
    const saved = JSON.parse(row.value_json) as Partial<RedactedSettingsDto>;
    const defaults = defaultSettings();
    return { ...defaults, ...saved, secretRefs: { ...defaults.secretRefs, ...saved.secretRefs }, includeWarnings: saved.includeWarnings ?? false };
  }

  async update(input: RedactedSettingsDto): Promise<RedactedSettingsDto> {
    await this.save(input);
    return input;
  }

  async commit(next: RedactedSettingsDto, replacements: SecretReplacement[]): Promise<RedactedSettingsDto> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const secretRefs = { ...next.secretRefs, notifierRefs: { ...(next.secretRefs.notifierRefs ?? {}) } };
      for (const replacement of replacements) {
        if (replacement.currentRef) {
          await this.secrets.rotate(replacement.currentRef, replacement.value);
          if (replacement.field === 'telegramBotTokenRef') secretRefs.notifierRefs.telegram = replacement.currentRef;
          else secretRefs[replacement.field] = replacement.currentRef;
          continue;
        }
        const stored = await this.secrets.put(replacement.kind, replacement.value);
        if (replacement.field === 'telegramBotTokenRef') secretRefs.notifierRefs.telegram = stored.ref;
        else secretRefs[replacement.field] = stored.ref;
      }
      const saved = { ...next, secretRefs };
      await this.save(saved);
      this.db.exec('COMMIT');
      return saved;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('SETTINGS_SAVE_FAILED');
    }
  }

  private async save(settings: RedactedSettingsDto): Promise<void> {
    this.db
      .prepare(
        `insert into settings(key, value_json, updated_at)
         values (@key, @value, @updatedAt)
         on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run({ key: SETTINGS_KEY, value: JSON.stringify(settings), updatedAt: new Date().toISOString() });
  }
}

class SQLiteReportStore implements ReportStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: () => Promise<RedactedSettingsDto>,
    private readonly now: () => string,
    private readonly maxStoredReports: number
  ) {}

  async save(report: Parameters<ReportStore['save']>[0], context?: ExecutionContext): Promise<void> {
    context?.checkpoint();
    const safeReport = { ...report, rendered: { ...report.rendered, body: redactProviderError(report.rendered.body) } };
    this.db
      .prepare(
        `insert into reports(id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at)
         values (@id, @windowFrom, @windowTo, @severityCounts, @renderedMarkdown, @compressedPayload, @createdAt)`
      )
      .run({
        id: safeReport.id,
        windowFrom: safeReport.summary.window.from,
        windowTo: safeReport.summary.window.to,
        severityCounts: JSON.stringify(safeReport.summary.severityCounts),
        renderedMarkdown: safeReport.rendered.body,
        compressedPayload: gzipSync(JSON.stringify(safeReport)),
        createdAt: safeReport.summary.createdAt
      });
    await this.cleanup((await this.settings()).retentionDays);
  }

  async list(): Promise<DigestSummary[]> {
    const rows = this.db
      .prepare(
        `select id, window_from, window_to, severity_counts_json, compressed_payload, created_at
         from reports
         order by created_at desc`
      )
      .all() as Array<{ id: string; window_from: string; window_to: string; severity_counts_json: string; compressed_payload: Buffer | null; created_at: string }>;

    return rows.map((row) => ({
      id: row.id,
      window: { from: row.window_from, to: row.window_to },
      severityCounts: JSON.parse(row.severity_counts_json) as DigestSummary['severityCounts'],
      createdAt: row.created_at,
      deliveryStatus: deliveryStatusFromPayload(row.compressed_payload) ?? 'pending',
      source: 'legacy' as const
    }));
  }

  async get(id: string): Promise<{ id: string; rendered: { format: 'markdown'; body: string }; summary: DigestSummary } | null> {
    const row = this.db.prepare(
      'select id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at from reports where id = ?'
    ).get(id) as { id: string; window_from: string; window_to: string; severity_counts_json: string; rendered_markdown: string; compressed_payload: Buffer | null; created_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      rendered: { format: 'markdown', body: redactProviderError(row.rendered_markdown) },
      summary: { id: row.id, window: { from: row.window_from, to: row.window_to }, severityCounts: JSON.parse(row.severity_counts_json), createdAt: row.created_at, deliveryStatus: deliveryStatusFromPayload(row.compressed_payload) ?? 'pending', source: 'legacy' }
    };
  }

  async remove(id: string): Promise<boolean> {
    this.db.exec('begin immediate');
    try {
      const removed = this.db.prepare('delete from reports where id = ?').run(id).changes === 1;
      if (removed) this.db.prepare('delete from deliveries where digest_id = ?').run(id);
      this.db.exec('commit');
      return removed;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  async removeBatch(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let count = 0;
    for (const id of ids) {
      if (await this.remove(id)) count += 1;
    }
    return count;
  }

  private async cleanup(retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.parse(this.now()) - retentionDays * 86_400_000).toISOString();
    this.db.prepare('delete from reports where created_at < ?').run(cutoff);
    const { count } = this.db.prepare('select count(*) as count from reports').get() as { count: number };
    const excess = count - this.maxStoredReports;
    if (excess > 0) {
      this.db
        .prepare('delete from reports where id in (select id from reports order by created_at asc, id asc limit ?)')
        .run(excess);
    }
  }
}

function deliveryStatusFromPayload(payload: Buffer | null): DigestSummary['deliveryStatus'] | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(gunzipSync(payload).toString('utf8')) as { summary?: { deliveryStatus?: DigestSummary['deliveryStatus'] } };
    const status = DeliveryStatusSchema.safeParse(parsed.summary?.deliveryStatus);
    return status.success ? status.data : null;
  } catch {
    return null;
  }
}

function defaultSettings(): RedactedSettingsDto {
  return {
    haUrl: 'http://homeassistant.local:8123',
    aiProvider: 'gemini',
    secretRefs: { haTokenRef: 'unconfigured:ha', aiKeyRef: 'unconfigured:ai', notifierRefs: {} },
    schedules: [],
    privacyLevel: 'balanced',
    retentionDays: 30,
    includeWarnings: false
  };
}
