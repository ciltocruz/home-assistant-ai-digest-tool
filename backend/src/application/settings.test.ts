import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from './settings.js';

const initial = {
  haUrl: 'http://homeassistant.local:8123',
  aiProvider: 'gemini' as const,
  secretRefs: { haTokenRef: 'secret-ha', aiKeyRef: 'secret-ai', notifierRefs: { telegram: 'secret-telegram' } },
  schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced' as const,
  retentionDays: 90
};

describe('SettingsService', () => {
  it('keeps configured secrets while atomically saving changed non-secret settings', async () => {
    const store = createStore();
    const service = new SettingsService(store, createSecrets());

    const saved = await service.update({
      homeAssistant: { url: 'http://homeassistant.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'openai', key: { operation: 'keep_current' } },
      notifications: { channel: 'telegram', chatId: '987654', botToken: { operation: 'keep_current' } },
      schedules: [{ kind: 'daily', enabled: true, time: '21:30', timezone: 'Europe/Madrid' }],
      privacyLevel: 'minimal',
      retentionDays: 14
    });

    expect(store.commit).toHaveBeenCalledWith(expect.objectContaining({ aiProvider: 'openai', retentionDays: 14 }), []);
    expect(saved).toMatchObject({ ai: { provider: 'openai', key: { configured: true, mask: '••••ai' } }, notifications: { channel: 'telegram', chatId: '987654' }, retentionDays: 14 });
    expect(JSON.stringify(saved)).not.toContain('secret-ai');
    expect(JSON.stringify(saved)).not.toContain('sentinel');
  });

  it('does not commit any related setting when a required configured secret cannot be kept', async () => {
    const store = createStore({ ...initial, secretRefs: { ...initial.secretRefs, aiKeyRef: 'unconfigured:ai' } });
    const service = new SettingsService(store, createSecrets());

    await expect(service.update({
      homeAssistant: { url: initial.haUrl, token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'none' },
      schedules: initial.schedules,
      privacyLevel: 'balanced',
      retentionDays: 90
    })).rejects.toThrow('SETTINGS_REQUIRED_SECRET');

    expect(store.commit).not.toHaveBeenCalled();
    expect(await store.get()).toEqual(expect.objectContaining({ aiProvider: 'gemini', retentionDays: 90 }));
  });

  it('passes replacement values to the atomic store without exposing them in its response', async () => {
    const store = createStore();
    const service = new SettingsService(store, createSecrets());
    const nextAiKey = 'sentinel-replacement-ai-key';

    const saved = await service.update({
      homeAssistant: { url: initial.haUrl, token: { operation: 'replace', value: 'sentinel-replacement-ha-token' } },
      ai: { provider: 'gemini', key: { operation: 'replace', value: nextAiKey } },
      notifications: { channel: 'none' },
      schedules: initial.schedules,
      privacyLevel: 'detailed',
      retentionDays: 30
    });

    expect(store.commit).toHaveBeenCalledWith(expect.any(Object), expect.arrayContaining([
      expect.objectContaining({ field: 'haTokenRef', value: 'sentinel-replacement-ha-token' }),
      expect.objectContaining({ field: 'aiKeyRef', value: nextAiKey })
    ]));
    expect(JSON.stringify(saved)).not.toContain(nextAiKey);
  });
});

function createStore(current = initial) {
  let value = structuredClone(current);
  return {
    get: vi.fn(async () => structuredClone(value)),
    commit: vi.fn(async (next) => {
      value = structuredClone(next);
      return structuredClone(value);
    })
  };
}

function createSecrets() {
  return {
    mask: async (ref: string) => ({ ref, kind: 'ai_provider' as const, mask: ref.replace('secret-', '••••') }),
    resolve: async (ref: string) => ref === 'secret-telegram' ? JSON.stringify({ botToken: 'sentinel-existing-telegram-token', chatId: '987654' }) : 'unused'
  };
}
