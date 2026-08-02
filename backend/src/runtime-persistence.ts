import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DigestSummary, MaskedSettings, RedactedSettingsDto, SetupValidationRequest } from '@ha-digest/shared';
import { runMigrations } from './adapters/persistence/migrations.js';
import { SQLiteDigestJobStore } from './adapters/persistence/sqlite-digest-job-store.js';
import { SQLiteSecretStore } from './adapters/persistence/sqlite-secret-store.js';
import { SQLiteOnboardingStore } from './adapters/persistence/sqlite-onboarding-store.js';
import type { BackendApiServices } from './http/app.js';
import type { ReportStore } from './domain/stores.js';
import type { ExecutionContext } from './domain/execution.js';
import { HomeAssistantRestClient } from './adapters/ha/rest-client.js';
import { HomeAssistantLogTailReader } from './adapters/ha/log-reader.js';
import { HomeAssistantFactsCollector, HomeAssistantIncidentDetector } from './adapters/ha/home-assistant.js';
import { FakeAIProvider, GeminiProvider, OpenAIProvider } from './adapters/ai/providers.js';
import { TelegramNotifier } from './adapters/notifiers/notifiers.js';
import { ManualAnalysis } from './application/manual-analysis.js';
import { DigestWorker } from './application/digest-worker.js';
import { SettingsService, type SecretReplacement } from './application/settings.js';
import { renderSafeMarkdown } from './application/incident-processing.js';

export type PersistentRuntimeOptions = {
  dataDir?: string;
  now?: () => string;
  maxStoredReports?: number;
  haLogPath?: string;
  haMaxStates?: number;
  haMaxLogLines?: number;
  haMaxResponseBytes?: number;
  haAnalysisTimeoutMs?: number;
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
  const settingsStore = new SQLiteRuntimeSettingsStore(db, secretStore);
  const settings = new SettingsService(settingsStore, secretStore);
  const reports = new SQLiteReportStore(db, () => settingsStore.get(), now, options.maxStoredReports ?? DEFAULT_MAX_STORED_REPORTS);

  const digestJobs = new SQLiteDigestJobStore(db, clock);
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
    onboarding: { get: () => onboarding.get(), save: (input) => onboarding.save(input), complete: () => onboarding.complete() },
    settings: {
      get: () => settings.get(),
      update: (input) => settings.update(input),
      notificationTarget: (channel) => settings.notificationTarget(channel)
    },
    digestJobs,
    reports,
    notes: {
      async add(input) { return { id: randomUUID(), ...input, createdAt: now() }; },
      async listWindow() { return []; }
    },
    ignores: {
      async add(input) { return { id: randomUUID(), match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: now() }; },
      async remove() {},
      async listActive() { return []; }
    },
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
    const manualAnalysis = new ManualAnalysis({
      collect: async (context) => {
          const current = await settingsStore.get();
        return new HomeAssistantFactsCollector({
          apiClient: new HomeAssistantRestClient({ haUrl: current.haUrl, haTokenRef: current.secretRefs.haTokenRef, secrets: secretStore, maxStates: options.haMaxStates, maxResponseBytes: options.haMaxResponseBytes }),
          logReader: new HomeAssistantLogTailReader({ path: options.haLogPath!, maxLines: options.haMaxLogLines })
        }).collect(context);
      },
      detect: (facts, context) => new HomeAssistantIncidentDetector().detect(facts, context), generate: async (input, context) => {
          const current = await settingsStore.get();
          const aiKeyRef = current.secretRefs.aiKeyRef;
          if (!aiKeyRef || aiKeyRef.startsWith('unconfigured:')) {
            return new FakeAIProvider().generate(input, context);
          }
          try {
            const apiKey = await secretStore.resolve(aiKeyRef);
            if (current.aiProvider === 'openai') {
              return new OpenAIProvider({ apiKey }).generate(input, context);
            }
            return new GeminiProvider({ apiKey }).generate(input, context);
          } catch {
            return new FakeAIProvider().generate(input, context);
          }
        }, render: (digest) => renderSafeMarkdown(digest), save: (report, context) => reports.save(report, context), privacyLevel: 'balanced', now, timeoutMs: options.haAnalysisTimeoutMs ?? 60_000
    });
    worker = new DigestWorker({ jobs: digestJobs, analysis: manualAnalysis });
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
      retentionDays: 30
    });

    return { haUrl: input.haUrl, ai: { provider: input.aiProvider, keyMask: ai.mask, ref: ai.ref }, notifiers };
  }

  async get(): Promise<RedactedSettingsDto> {
    const row = this.db.prepare('select value_json from settings where key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined;
    if (!row) return defaultSettings();
    return JSON.parse(row.value_json) as RedactedSettingsDto;
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
    this.db
      .prepare(
        `insert into reports(id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at)
         values (@id, @windowFrom, @windowTo, @severityCounts, @renderedMarkdown, @compressedPayload, @createdAt)`
      )
      .run({
        id: report.id,
        windowFrom: report.summary.window.from,
        windowTo: report.summary.window.to,
        severityCounts: JSON.stringify(report.summary.severityCounts),
        renderedMarkdown: report.rendered.body,
        compressedPayload: gzipSync(JSON.stringify(report)),
        createdAt: report.summary.createdAt
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
      deliveryStatus: deliveryStatusFromPayload(row.compressed_payload) ?? 'pending'
    }));
  }

  async get(id: string): Promise<{ id: string; rendered: { format: 'markdown'; body: string }; summary: DigestSummary } | null> {
    const row = this.db.prepare(
      'select id, window_from, window_to, severity_counts_json, rendered_markdown, compressed_payload, created_at from reports where id = ?'
    ).get(id) as { id: string; window_from: string; window_to: string; severity_counts_json: string; rendered_markdown: string; compressed_payload: Buffer | null; created_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      rendered: { format: 'markdown', body: row.rendered_markdown },
      summary: { id: row.id, window: { from: row.window_from, to: row.window_to }, severityCounts: JSON.parse(row.severity_counts_json), createdAt: row.created_at, deliveryStatus: deliveryStatusFromPayload(row.compressed_payload) ?? 'pending' }
    };
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
    return parsed.summary?.deliveryStatus ?? null;
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
    retentionDays: 30
  };
}
