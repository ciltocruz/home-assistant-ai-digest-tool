import type { DatabaseSync } from 'node:sqlite';
import { OnboardingProgressSchema, type OnboardingProgress, type OnboardingStep, type OnboardingStepCommand } from '@ha-digest/shared';
import type { MaskedSettings, RedactedSettingsDto } from '@ha-digest/shared';
import type { SecretStore } from '../../domain/stores.js';

const STEPS: OnboardingStep[] = ['home_assistant', 'ai_provider', 'notifications', 'schedule', 'privacy', 'first_report'];
const SECRET_KINDS = { haToken: 'home_assistant', aiKey: 'ai_provider', telegramBotToken: 'notifier' } as const;

type Row = { current_step: OnboardingStep; completed_steps_json: string; draft_json: string; secret_refs_json: string; secret_metadata_json: string; completed: number };

export class SQLiteOnboardingStore {
  constructor(private readonly db: DatabaseSync, private readonly secrets: Pick<SecretStore, 'put'>) {}

  async get(): Promise<OnboardingProgress> {
    return this.toPublic(this.row());
  }

  async save(command: OnboardingStepCommand): Promise<OnboardingProgress> {
    const row = this.row();
    if (row.completed || row.current_step !== command.step) throw new Error('STALE_ONBOARDING_STEP');
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    const metadata = JSON.parse(row.secret_metadata_json) as OnboardingProgress['secretMetadata'];
    for (const [field, value] of Object.entries(command.secrets)) {
      if (!value) continue;
      const stored = await this.secrets.put(SECRET_KINDS[field as keyof typeof SECRET_KINDS], value);
      refs[field] = stored.ref;
      metadata[field] = { configured: true, mask: stored.mask };
    }
    const currentIndex = STEPS.indexOf(command.step);
    const completedSteps = [...new Set([...JSON.parse(row.completed_steps_json) as OnboardingStep[], command.step])];
    this.db.prepare(
      `update onboarding_state set current_step = @currentStep, completed_steps_json = @completedSteps, draft_json = @draft,
       secret_refs_json = @secretRefs, secret_metadata_json = @secretMetadata, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where singleton = 1`
    ).run({ currentStep: STEPS[Math.min(currentIndex + 1, STEPS.length - 1)], completedSteps: JSON.stringify(completedSteps), draft: JSON.stringify({ ...JSON.parse(row.draft_json), ...command.draft }), secretRefs: JSON.stringify(refs), secretMetadata: JSON.stringify(metadata) });
    return this.get();
  }

  async complete(): Promise<MaskedSettings> {
    const row = this.row();
    if (row.completed) return this.maskedSettings(row);
    if (row.current_step !== 'first_report') throw new Error('ONBOARDING_INCOMPLETE');
    const draft = JSON.parse(row.draft_json) as { haUrl?: string; aiProvider?: 'openai' | 'gemini'; notifier?: string; telegramChatId?: string; dailyTime?: string; timezone?: string; privacyLevel?: RedactedSettingsDto['privacyLevel']; retentionDays?: number; privacyAccepted?: boolean };
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    if (!draft.haUrl || !draft.aiProvider || !refs.haToken || !refs.aiKey || !draft.dailyTime || !draft.timezone || !draft.privacyLevel || !draft.retentionDays || !draft.privacyAccepted) throw new Error('ONBOARDING_INCOMPLETE');
    const settings: RedactedSettingsDto = {
      haUrl: draft.haUrl,
      aiProvider: draft.aiProvider,
      secretRefs: { haTokenRef: refs.haToken, aiKeyRef: refs.aiKey, notifierRefs: draft.notifier === 'telegram' && refs.telegramBotToken ? { telegram: refs.telegramBotToken } : {} },
      schedules: [{ kind: 'daily', enabled: true, time: draft.dailyTime, timezone: draft.timezone }],
      privacyLevel: draft.privacyLevel,
      retentionDays: draft.retentionDays
    };
    this.db.exec('begin immediate');
    try {
      this.db.prepare(`insert into settings(key, value_json, updated_at) values ('runtime', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`).run(JSON.stringify(settings));
      this.db.prepare("update onboarding_state set completed = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where singleton = 1").run();
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
    return this.maskedSettings({ ...row, completed: 1 });
  }

  private row(): Row {
    return this.db.prepare('select current_step, completed_steps_json, draft_json, secret_refs_json, secret_metadata_json, completed from onboarding_state where singleton = 1').get() as Row;
  }

  private toPublic(row: Row): OnboardingProgress {
    return OnboardingProgressSchema.parse({ currentStep: row.current_step, completedSteps: JSON.parse(row.completed_steps_json), draft: JSON.parse(row.draft_json), secretMetadata: JSON.parse(row.secret_metadata_json), completed: row.completed === 1 });
  }

  private maskedSettings(row: Row): MaskedSettings {
    const draft = JSON.parse(row.draft_json) as { haUrl?: string; aiProvider?: 'openai' | 'gemini'; notifier?: string; telegramChatId?: string };
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    const metadata = JSON.parse(row.secret_metadata_json) as OnboardingProgress['secretMetadata'];
    if (!draft.haUrl || !draft.aiProvider || !refs.aiKey || !refs.haToken || !metadata.aiKey) throw new Error('ONBOARDING_INCOMPLETE');
    return {
      haUrl: draft.haUrl,
      ai: { provider: draft.aiProvider, keyMask: metadata.aiKey.mask, ref: refs.aiKey },
      notifiers: draft.notifier === 'telegram' && draft.telegramChatId && refs.telegramBotToken && metadata.telegramBotToken
        ? [{ id: 'telegram', channel: 'telegram', targetRef: refs.telegramBotToken, label: `Telegram ${draft.telegramChatId}`, secretMask: metadata.telegramBotToken.mask }]
        : []
    };
  }
}
