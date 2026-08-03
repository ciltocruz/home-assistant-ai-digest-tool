import type { EditableSettingsDto, RedactedSettingsDto, SettingsUpdateCommand } from '@ha-digest/shared';
import type { SecretKind, SecretStore } from '../domain/stores.js';

export type SecretReplacement = {
  field: 'haTokenRef' | 'aiKeyRef' | 'telegramBotTokenRef';
  kind: SecretKind;
  value: string;
  currentRef?: string;
};

export type AtomicSettingsStore = {
  get(): Promise<RedactedSettingsDto>;
  commit(next: RedactedSettingsDto, replacements: SecretReplacement[]): Promise<RedactedSettingsDto>;
};

export class SettingsService {
  constructor(
    private readonly store: AtomicSettingsStore,
    private readonly secrets: Pick<SecretStore, 'mask' | 'resolve'>
  ) {}

  async get(): Promise<EditableSettingsDto> {
    return this.toEditable(await this.store.get());
  }

  async update(command: SettingsUpdateCommand): Promise<EditableSettingsDto> {
    const current = await this.store.get();
    const replacements: SecretReplacement[] = [];
    this.validateRequiredSecret(current.secretRefs.haTokenRef, command.homeAssistant.token, 'haTokenRef');
    this.validateRequiredSecret(current.secretRefs.aiKeyRef, command.ai.key, 'aiKeyRef');
    if (command.homeAssistant.token.operation === 'replace') replacements.push({ field: 'haTokenRef', kind: 'home_assistant', value: command.homeAssistant.token.value });
    if (command.ai.key.operation === 'replace') replacements.push({ field: 'aiKeyRef', kind: 'ai_provider', value: command.ai.key.value });

    const notifierRefs = { ...(current.secretRefs.notifierRefs ?? {}) };
    if (command.notifications.channel === 'none') {
      delete notifierRefs.telegram;
    } else {
      const existingTelegramRef = notifierRefs.telegram;
      this.validateRequiredSecret(existingTelegramRef, command.notifications.botToken, 'telegramBotTokenRef');
      if (command.notifications.botToken.operation === 'replace') {
        replacements.push({
          field: 'telegramBotTokenRef',
          kind: 'notifier',
          value: JSON.stringify({ botToken: command.notifications.botToken.value, chatId: command.notifications.chatId })
        });
      } else if (existingTelegramRef) {
        const existing = parseTelegram(await this.secrets.resolve(existingTelegramRef));
        if (!existing?.botToken) throw new Error('SETTINGS_REQUIRED_SECRET:telegramBotTokenRef');
        if (existing.chatId !== command.notifications.chatId) {
          replacements.push({
            field: 'telegramBotTokenRef',
            kind: 'notifier',
            currentRef: existingTelegramRef,
            value: JSON.stringify({ botToken: existing.botToken, chatId: command.notifications.chatId })
          });
        }
      }
    }

    const saved = await this.store.commit({
      haUrl: command.homeAssistant.url,
      aiProvider: command.ai.provider,
      secretRefs: { ...current.secretRefs, notifierRefs },
      schedules: command.schedules,
      privacyLevel: command.privacyLevel,
      retentionDays: command.retentionDays,
      includeWarnings: command.includeWarnings ?? current.includeWarnings ?? false
    }, replacements);
    return this.toEditable(saved);
  }

  async notificationTarget(channel: 'telegram'): Promise<string> {
    const ref = (await this.store.get()).secretRefs.notifierRefs?.[channel];
    if (!isConfigured(ref)) throw new Error('SETTINGS_REQUIRED_SECRET:telegramBotTokenRef');
    return ref;
  }

  private validateRequiredSecret(ref: string | undefined, operation: SettingsUpdateCommand['ai']['key'], field: string): void {
    if (operation.operation === 'replace') return;
    if (!isConfigured(ref)) throw new Error(`SETTINGS_REQUIRED_SECRET:${field}`);
  }

  private async toEditable(settings: RedactedSettingsDto): Promise<EditableSettingsDto> {
    const [haToken, aiKey, notifications] = await Promise.all([
      this.secretMetadata(settings.secretRefs.haTokenRef),
      this.secretMetadata(settings.secretRefs.aiKeyRef),
      this.notificationMetadata(settings.secretRefs.notifierRefs?.telegram)
    ]);
    return {
      homeAssistant: { url: settings.haUrl, token: haToken },
      ai: { provider: settings.aiProvider, key: aiKey },
      notifications,
      schedules: settings.schedules,
      privacyLevel: settings.privacyLevel,
      retentionDays: settings.retentionDays,
      includeWarnings: settings.includeWarnings ?? false
    };
  }

  private async secretMetadata(ref: string | undefined): Promise<{ configured: boolean; mask?: string }> {
    if (!isConfigured(ref)) return { configured: false };
    const stored = await this.secrets.mask(ref);
    return { configured: true, mask: stored.mask };
  }

  private async notificationMetadata(ref: string | undefined): Promise<EditableSettingsDto['notifications']> {
    if (!isConfigured(ref)) return { channel: 'none' };
    const [stored, raw] = await Promise.all([this.secrets.mask(ref), this.secrets.resolve(ref)]);
    const parsed = parseTelegram(raw);
    return parsed ? { channel: 'telegram', chatId: parsed.chatId, botToken: { configured: true, mask: stored.mask } } : { channel: 'none' };
  }
}

function isConfigured(ref: string | undefined): ref is string {
  return Boolean(ref && !ref.startsWith('unconfigured:'));
}

function parseTelegram(raw: string): { chatId: string; botToken?: string } | null {
  try {
    const value = JSON.parse(raw) as { chatId?: unknown; botToken?: unknown };
    return typeof value.chatId === 'string' && value.chatId.length > 0
      ? { chatId: value.chatId, ...(typeof value.botToken === 'string' ? { botToken: value.botToken } : {}) }
      : null;
  } catch {
    return null;
  }
}
