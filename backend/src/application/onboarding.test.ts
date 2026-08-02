import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../adapters/persistence/migrations.js';
import { SQLiteOnboardingStore } from '../adapters/persistence/sqlite-onboarding-store.js';

describe('SQLiteOnboardingStore', () => {
  it('resumes the next screen after a restart without storing a raw secret in onboarding state', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const secrets = { put: async () => ({ ref: 'secret_ref', kind: 'home_assistant' as const, mask: 'se…et' }) };
    const first = new SQLiteOnboardingStore(db, secrets);

    await first.save({ step: 'home_assistant', draft: { haUrl: 'http://homeassistant.local:8123' }, secrets: { haToken: 'sentinel-onboarding-secret' } });
    const resumed = await new SQLiteOnboardingStore(db, secrets).get();

    expect(resumed).toEqual(expect.objectContaining({ currentStep: 'ai_provider', completedSteps: ['home_assistant'], draft: { haUrl: 'http://homeassistant.local:8123' } }));
    expect(JSON.stringify(resumed)).not.toContain('sentinel-onboarding-secret');
    expect(JSON.stringify(resumed)).not.toContain('secret_ref');
  });

  it('rejects stale checkpoints instead of silently moving the saved screen backwards', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const store = new SQLiteOnboardingStore(db, { put: async () => ({ ref: 'secret_ref', kind: 'home_assistant' as const, mask: 'se…et' }) });

    await store.save({ step: 'home_assistant', draft: { haUrl: 'http://homeassistant.local:8123' }, secrets: { haToken: 'sentinel-onboarding-secret' } });

    await expect(store.save({ step: 'home_assistant', draft: {}, secrets: {} })).rejects.toThrow('STALE_ONBOARDING_STEP');
  });

  it('completes persisted checkpoints into masked runtime settings without asking the browser for secrets again', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    runMigrations(db);
    const store = new SQLiteOnboardingStore(db, { put: async (kind) => ({ ref: `secret:${kind}`, kind, mask: `••••${kind}` }) });

    await store.save({ step: 'home_assistant', draft: { haUrl: 'http://homeassistant.local:8123' }, secrets: { haToken: 'browser-only-ha-token' } });
    await store.save({ step: 'ai_provider', draft: { aiProvider: 'gemini' }, secrets: { aiKey: 'browser-only-ai-key' } });
    await store.save({ step: 'notifications', draft: { notifier: 'markdown' }, secrets: {} });
    await store.save({ step: 'schedule', draft: { dailyTime: '09:15', timezone: 'Europe/Madrid' }, secrets: {} });
    await store.save({ step: 'privacy', draft: { privacyLevel: 'minimal', retentionDays: 45, privacyAccepted: true }, secrets: {} });

    const completed = await store.complete();

    expect(completed).toMatchObject({ ai: { provider: 'gemini', ref: 'secret:ai_provider' }, notifiers: [] });
    expect(JSON.stringify(completed)).not.toContain('browser-only-ha-token');
    expect(JSON.stringify(completed)).not.toContain('browser-only-ai-key');
    expect(db.prepare("select value_json from settings where key = 'runtime'").get()).toEqual(expect.objectContaining({ value_json: expect.stringContaining('secret:home_assistant') }));
  });
});
