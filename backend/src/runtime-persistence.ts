import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DigestSummary, MaskedSettings, RedactedSettingsDto, SetupValidationRequest } from '@ha-digest/shared';
import { runMigrations } from './adapters/persistence/migrations.js';
import { SQLiteDigestJobStore } from './adapters/persistence/sqlite-digest-job-store.js';
import { SQLiteSecretStore } from './adapters/persistence/sqlite-secret-store.js';
import type { BackendApiServices } from './http/app.js';
import type { ReportStore } from './domain/stores.js';

export type PersistentRuntimeOptions = {
  dataDir?: string;
  now?: () => string;
};

const SETTINGS_KEY = 'runtime';

export async function createPersistentRuntimeServices(options: PersistentRuntimeOptions = {}): Promise<BackendApiServices> {
  const dataDir = options.dataDir ?? '/data';
  await mkdir(dataDir, { recursive: true });

  const db = new DatabaseSync(join(dataDir, 'app.db'));
  runMigrations(db);

  const now = options.now ?? (() => new Date().toISOString());
  const clock = { now: () => new Date(now()) };
  const secretStore = await SQLiteSecretStore.create({ db, dataDir });
  const settings = new SQLiteRuntimeSettingsStore(db, secretStore);
  const reports = new SQLiteReportStore(db);

  return {
    close: () => db.close(),
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
    setup: { complete: (input) => settings.completeSetup(input) },
    settings: {
      get: () => settings.get(),
      update: (input) => settings.update(input)
    },
    digestJobs: new SQLiteDigestJobStore(db, clock),
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
      async test() { return { status: 'failed', message: 'Runtime notification adapters are not live-wired yet.', checkedAt: now() }; },
      async send(input) { return { status: 'skipped', targetRef: input.targetRef, message: 'Runtime notification adapters are not live-wired yet.' }; }
    }
  };
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
  constructor(private readonly db: DatabaseSync) {}

  async save(report: Parameters<ReportStore['save']>[0]): Promise<void> {
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
