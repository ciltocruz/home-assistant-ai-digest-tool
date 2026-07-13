// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from './api-client.js';
import {
  OnboardingFlow,
  advanceOnboardingStep,
  completeOnboarding,
  createInitialOnboardingState,
  type OnboardingApi
} from './onboarding.js';

const validDraft = {
  haUrl: 'http://homeassistant.local:8123',
  haToken: 'sample home assistant private value',
  aiProvider: 'gemini' as const,
  aiKey: 'sample ai private value',
  notifier: 'telegram' as const,
  telegramBotToken: 'sample telegram private value',
  telegramChatId: 'sample chat reference',
  dailyTime: '08:00',
  timezone: 'Europe/Madrid',
  privacyLevel: 'balanced' as const,
  retentionDays: '90'
};

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('onboarding flow', () => {
  test('renders a Spanish multi-step onboarding UI without echoing secrets', () => {
    const html = renderToStaticMarkup(<OnboardingFlow state={createInitialOnboardingState()} />);

    expect(html).toContain('Conecta Home Assistant');
    expect(html).toContain('Proveedor de IA');
    expect(html).toContain('Canal de aviso');
    expect(html).toContain('Horario y privacidad');
    expect(html).toContain('Primer informe');
    expect(html).toContain('Token de Home Assistant');
    expect(html).toContain('Clave del proveedor');
    expect(html).toContain('Token del bot de Telegram');
    expect(html).toContain('ID del chat de Telegram');
    expect(html).toContain('Guardaremos este horario y nivel de privacidad antes de lanzar el primer informe.');
    expect(html).toContain('Hora del informe');
    expect(html).toContain('Zona horaria');
    expect(html).toContain('Nivel de privacidad');
    expect(html).toContain('Días de retención');
    expect(html).toContain('Continuar a proveedor de IA');
    expect(html).not.toContain('Validar y lanzar primer informe');
    expect(html).not.toContain(validDraft.haToken);
    expect(html).not.toContain(validDraft.aiKey);
    expect(html).not.toContain(validDraft.telegramBotToken);
  });

  test('allows the default Telegram path to progress when rendered fields are filled', () => {
    const atNotifier = {
      ...createInitialOnboardingState(),
      step: 'notifier' as const,
      draft: {
        ...createInitialOnboardingState().draft,
        haUrl: validDraft.haUrl,
        haToken: validDraft.haToken,
        aiKey: validDraft.aiKey
      }
    };

    const missingTelegram = advanceOnboardingStep(atNotifier);

    expect(missingTelegram.step).toBe('notifier');
    expect(missingTelegram.errors.telegramBotToken).toContain('Añade el token del bot de Telegram.');
    expect(missingTelegram.errors.telegramChatId).toContain('Añade el chat de Telegram.');

    const readyForSchedule = advanceOnboardingStep({
      ...atNotifier,
      draft: {
        ...atNotifier.draft,
        telegramBotToken: validDraft.telegramBotToken,
        telegramChatId: validDraft.telegramChatId
      }
    });

    expect(readyForSchedule.step).toBe('schedulePrivacy');
    expect(readyForSchedule.errors).toEqual({});
  });

  test('uses the final digest action only on the final step', () => {
    const firstDigestState = { ...createInitialOnboardingState(), step: 'firstDigest' as const, draft: validDraft };

    const html = renderToStaticMarkup(<OnboardingFlow state={firstDigestState} />);

    expect(html).toContain('Validar y lanzar primer informe');
    expect(html).not.toContain('Continuar a proveedor de IA');
  });

  test('requires schedule and privacy values before the first digest step', () => {
    const result = advanceOnboardingStep({
      ...createInitialOnboardingState(),
      step: 'schedulePrivacy',
      draft: { ...validDraft, dailyTime: '', timezone: '', retentionDays: '0' }
    });

    expect(result.step).toBe('schedulePrivacy');
    expect(result.errors.dailyTime).toContain('Indica una hora en formato HH:MM.');
    expect(result.errors.timezone).toContain('Indica una zona horaria.');
    expect(result.errors.retentionDays).toContain('Usa entre 1 y 3650 días de retención.');
  });

  test('keeps schedule/privacy controls in the draft and hard-coded setup rail counts out of the slice', () => {
    const css = readFileSync('frontend/src/styles.css', 'utf8');

    expect(createInitialOnboardingState().draft).toMatchObject({
      dailyTime: '08:00',
      timezone: 'Europe/Madrid',
      privacyLevel: 'balanced',
      retentionDays: '90'
    });
    expect(css).not.toContain('repeat(4, minmax(0, 1fr))');
    expect(css).toContain('auto-fit');
  });

  test('blocks step progression with field-level errors until required input exists', () => {
    const missingHa = advanceOnboardingStep(createInitialOnboardingState());

    expect(missingHa.step).toBe('homeAssistant');
    expect(missingHa.errors.haUrl).toContain('Indica una URL válida de Home Assistant.');
    expect(missingHa.errors.haToken).toContain('Añade un token de Home Assistant.');

    const next = advanceOnboardingStep({
      ...missingHa,
      draft: { ...missingHa.draft, haUrl: validDraft.haUrl, haToken: validDraft.haToken }
    });

    expect(next.step).toBe('aiProvider');
    expect(next.errors).toEqual({});
  });

  test('validates setup through the API client, stores only masked settings, and queues the first digest', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const api: OnboardingApi = {
      getSettings: async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini' as const,
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal' as const,
        retentionDays: 30
      }),
      updateSettings: async (body) => {
        calls.push({ method: 'updateSettings', body });
        return body;
      },
      validateSetup: async (body) => {
        calls.push({ method: 'validateSetup', body });
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: body.haUrl,
            ai: { provider: body.aiProvider, keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async (body) => {
        calls.push({ method: 'runDigest', body });
        return { jobId: 'job-first-digest', status: 'queued' };
      }
    };

    const result = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);

    expect(calls).toEqual([
      { method: 'validateSetup', body: { haUrl: validDraft.haUrl, haToken: validDraft.haToken, aiProvider: 'gemini', aiKey: validDraft.aiKey, telegram: { botToken: validDraft.telegramBotToken, chatId: validDraft.telegramChatId } } },
      { method: 'updateSettings', body: { haUrl: validDraft.haUrl, aiProvider: 'gemini', secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } }, schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }], privacyLevel: 'balanced', retentionDays: 90 } },
      { method: 'runDigest', body: expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }) }
    ]);
    expectFirstDigestWindowContract(calls[2]?.body);
    expect(result.status).toBe('complete');
    expect(result.maskedSettings?.ai.keyMask).toBe('••••-provider');
    expect(result.setupProgress).toBeUndefined();
    expect(result.firstDigestJob).toEqual({ jobId: 'job-first-digest', status: 'queued' });
    expect(JSON.stringify(result)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(result)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(result)).not.toContain(validDraft.telegramBotToken);
  });

  test('guards rapid final submits while the onboarding request is already submitting', async () => {
    const setupRequest = deferred<Awaited<ReturnType<OnboardingApi['validateSetup']>>>();
    const api: OnboardingApi = {
      getSettings: vi.fn(async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini' as const,
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal' as const,
        retentionDays: 30
      })),
      updateSettings: vi.fn(async (body) => body),
      validateSetup: vi.fn(() => setupRequest.promise),
      runDigest: vi.fn(async () => ({ jobId: 'job-first-digest', status: 'queued' as const }))
    };
    const { container } = await mountOnboardingFlow(api);
    const form = container.querySelector<HTMLFormElement>('form.onboarding-flow');
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!form || !button) throw new Error('Expected onboarding form and submit button to render.');

    await act(async () => {
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    expect(button.disabled).toBe(true);
    expect(api.validateSetup).toHaveBeenCalledTimes(1);

    await act(async () => {
      setupRequest.resolve({
        csrfToken: 'csrf sample value',
        settings: {
          haUrl: validDraft.haUrl,
          ai: { provider: 'gemini' as const, keyMask: '••••-provider', ref: 'ref-ai' },
          notifiers: [{ id: 'telegram-main', channel: 'telegram' as const, targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
        }
      });
      await setupRequest.promise;
    });

    expect(api.runDigest).toHaveBeenCalledTimes(1);
  });

  test('does not queue another first digest when submitting after completion', async () => {
    const api: OnboardingApi = {
      getSettings: vi.fn(async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini' as const,
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal' as const,
        retentionDays: 30
      })),
      updateSettings: vi.fn(async (body) => body),
      validateSetup: vi.fn(async () => ({
        csrfToken: 'csrf sample value',
        settings: {
          haUrl: validDraft.haUrl,
          ai: { provider: 'gemini' as const, keyMask: '••••-provider', ref: 'ref-ai' },
          notifiers: [{ id: 'telegram-main', channel: 'telegram' as const, targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
        }
      })),
      runDigest: vi.fn(async () => ({ jobId: 'job-first-digest', status: 'queued' as const }))
    };
    const { container } = await mountOnboardingFlow(api);
    const form = container.querySelector<HTMLFormElement>('form.onboarding-flow');
    if (!form) throw new Error('Expected onboarding form to render.');

    await act(async () => {
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);

    await act(async () => {
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    expect(api.runDigest).toHaveBeenCalledTimes(1);
  });

  test('blocks the first digest when settings persistence is not available', async () => {
    const calls: string[] = [];
    const api = {
      validateSetup: async () => {
        calls.push('validateSetup');
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: validDraft.haUrl,
            ai: { provider: 'gemini' as const, keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram' as const, targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async () => {
        calls.push('runDigest');
        return { jobId: 'job-should-not-queue', status: 'queued' as const };
      }
    };

    const result = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api as unknown as OnboardingApi);

    expect(calls).toEqual(['validateSetup']);
    expect(result.status).toBe('failed');
    expect(result.errors.form?.[0]).toContain('No se pudieron guardar los ajustes antes del primer informe.');
    expect(result.firstDigestJob).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(result)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(result)).not.toContain(validDraft.telegramBotToken);
  });

  test('keeps post-setup settings failures retryable without re-entering secrets', async () => {
    const calls: string[] = [];
    let updateAttempts = 0;
    const api: OnboardingApi = {
      getSettings: async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini',
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal',
        retentionDays: 30
      }),
      updateSettings: async (body) => {
        updateAttempts += 1;
        calls.push('updateSettings');
        if (updateAttempts === 2) return body;
        throw new ApiClientError('SETTINGS_FAILED', 'Settings persistence failed.', 'req-settings');
      },
      validateSetup: async () => {
        calls.push('validateSetup');
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: validDraft.haUrl,
            ai: { provider: 'gemini', keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async () => {
        calls.push('runDigest');
        return { jobId: 'job-first-digest', status: 'queued' };
      }
    };

    const failed = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);
    const retried = await completeOnboarding(failed, api);

    expect(calls).toEqual(['validateSetup', 'updateSettings', 'updateSettings', 'runDigest']);
    expect(failed.status).toBe('failed');
    expect(failed.errors.form?.[0]).toContain('Settings persistence failed.');
    expect(failed.maskedSettings?.ai.keyMask).toBe('••••-provider');
    expect(retried.status).toBe('complete');
    expect(retried.firstDigestJob).toEqual({ jobId: 'job-first-digest', status: 'queued' });
    expect(JSON.stringify(failed)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(failed)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(failed)).not.toContain(validDraft.telegramBotToken);
  });

  test('rebuilds schedule and privacy settings from the current draft when retrying after settings persistence fails', async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    let updateAttempts = 0;
    const api: OnboardingApi = {
      getSettings: async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini',
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal',
        retentionDays: 30
      }),
      updateSettings: async (body) => {
        updateAttempts += 1;
        calls.push({ method: 'updateSettings', body });
        if (updateAttempts === 1) throw new ApiClientError('SETTINGS_FAILED', 'Settings persistence failed.', 'req-settings');
        return body;
      },
      validateSetup: async (body) => {
        calls.push({ method: 'validateSetup', body });
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: body.haUrl,
            ai: { provider: 'gemini', keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async (body) => {
        calls.push({ method: 'runDigest', body });
        return { jobId: 'job-first-digest', status: 'queued' };
      }
    };

    const failed = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);
    const retried = await completeOnboarding({
      ...failed,
      draft: {
        ...failed.draft,
        dailyTime: '21:30',
        privacyLevel: 'detailed',
        retentionDays: '14'
      }
    }, api);

    expect(calls).toEqual([
      { method: 'validateSetup', body: { haUrl: validDraft.haUrl, haToken: validDraft.haToken, aiProvider: 'gemini', aiKey: validDraft.aiKey, telegram: { botToken: validDraft.telegramBotToken, chatId: validDraft.telegramChatId } } },
      { method: 'updateSettings', body: { haUrl: validDraft.haUrl, aiProvider: 'gemini', secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } }, schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }], privacyLevel: 'balanced', retentionDays: 90 } },
      { method: 'updateSettings', body: { haUrl: validDraft.haUrl, aiProvider: 'gemini', secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } }, schedules: [{ kind: 'daily', enabled: true, time: '21:30', timezone: 'Europe/Madrid' }], privacyLevel: 'detailed', retentionDays: 14 } },
      { method: 'runDigest', body: expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }) }
    ]);
    expect(failed.status).toBe('failed');
    expect(retried.status).toBe('complete');
    expect(JSON.stringify(retried)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(retried)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(retried)).not.toContain(validDraft.telegramBotToken);
  });

  test('validates current schedule and privacy draft before retrying post-setup persistence', async () => {
    const api: OnboardingApi = {
      getSettings: vi.fn(async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini' as const,
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal' as const,
        retentionDays: 30
      })),
      updateSettings: vi.fn(async () => {
        throw new ApiClientError('SETTINGS_FAILED', 'Settings persistence failed.', 'req-settings');
      }),
      validateSetup: vi.fn(async () => ({
        csrfToken: 'csrf sample value',
        settings: {
          haUrl: validDraft.haUrl,
          ai: { provider: 'gemini' as const, keyMask: '••••-provider', ref: 'ref-ai' },
          notifiers: [{ id: 'telegram-main', channel: 'telegram' as const, targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
        }
      })),
      runDigest: vi.fn(async () => ({ jobId: 'job-first-digest', status: 'queued' as const }))
    };

    const failed = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);
    vi.mocked(api.updateSettings).mockClear();

    const retried = await completeOnboarding({
      ...failed,
      draft: { ...failed.draft, dailyTime: '99:99', retentionDays: '0' }
    }, api);

    expect(retried.status).toBe('failed');
    expect(retried.step).toBe('schedulePrivacy');
    expect(retried.errors.dailyTime).toContain('Indica una hora en formato HH:MM.');
    expect(retried.errors.retentionDays).toContain('Usa entre 1 y 3650 días de retención.');
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.runDigest).not.toHaveBeenCalled();
  });

  test('retries first digest with the same stable window without setup validation after digest queue failure', async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const api: OnboardingApi = {
      getSettings: async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini',
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal',
        retentionDays: 30
      }),
      updateSettings: async (body) => {
        calls.push({ method: 'updateSettings', body });
        return body;
      },
      validateSetup: async () => {
        calls.push({ method: 'validateSetup' });
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: validDraft.haUrl,
            ai: { provider: 'gemini', keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async (body) => {
        calls.push({ method: 'runDigest', body });
        if (calls.filter((call) => call.method === 'runDigest').length === 2) return { jobId: 'job-first-digest', status: 'queued' };
        throw new ApiClientError('DIGEST_FAILED', 'Digest queue failed.', 'req-digest');
      }
    };

    const failed = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);
    const retried = await completeOnboarding(failed, api);
    const firstDigestCall = calls.find((call) => call.method === 'runDigest');
    const secondDigestCall = calls.filter((call) => call.method === 'runDigest')[1];

    expect(calls.map((call) => call.method)).toEqual(['validateSetup', 'updateSettings', 'runDigest', 'updateSettings', 'runDigest']);
    expect(firstDigestCall?.body).toEqual(secondDigestCall?.body);
    expect(firstDigestCall?.body).toEqual(expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }));
    expectFirstDigestWindowContract(firstDigestCall?.body);
    expectFirstDigestWindowContract(secondDigestCall?.body);
    expect(failed.status).toBe('failed');
    expect(failed.errors.form?.[0]).toContain('Digest queue failed.');
    expect(retried.status).toBe('complete');
    expect(retried.firstDigestJob).toEqual({ jobId: 'job-first-digest', status: 'queued' });
    expect(JSON.stringify(failed)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(failed)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(failed)).not.toContain(validDraft.telegramBotToken);
  });

  test('persists current schedule and privacy edits before retrying a failed first digest', async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    const api: OnboardingApi = {
      getSettings: async () => ({
        haUrl: validDraft.haUrl,
        aiProvider: 'gemini',
        secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
        schedules: [],
        privacyLevel: 'minimal',
        retentionDays: 30
      }),
      updateSettings: async (body) => {
        calls.push({ method: 'updateSettings', body });
        return body;
      },
      validateSetup: async () => {
        calls.push({ method: 'validateSetup' });
        return {
          csrfToken: 'csrf sample value',
          settings: {
            haUrl: validDraft.haUrl,
            ai: { provider: 'gemini', keyMask: '••••-provider', ref: 'ref-ai' },
            notifiers: [{ id: 'telegram-main', channel: 'telegram', targetRef: 'ref-telegram', label: 'Telegram', secretMask: '••••-bot' }]
          }
        };
      },
      runDigest: async (body) => {
        calls.push({ method: 'runDigest', body });
        if (calls.filter((call) => call.method === 'runDigest').length === 2) return { jobId: 'job-first-digest', status: 'queued' };
        throw new ApiClientError('DIGEST_FAILED', 'Digest queue failed.', 'req-digest');
      }
    };

    const failed = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);
    const retried = await completeOnboarding({
      ...failed,
      draft: { ...failed.draft, dailyTime: '21:30', privacyLevel: 'detailed', retentionDays: '14' }
    }, api);

    expect(calls).toEqual([
      { method: 'validateSetup' },
      { method: 'updateSettings', body: expect.objectContaining({ schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }], privacyLevel: 'balanced', retentionDays: 90 }) },
      { method: 'runDigest', body: expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }) },
      { method: 'updateSettings', body: expect.objectContaining({ schedules: [{ kind: 'daily', enabled: true, time: '21:30', timezone: 'Europe/Madrid' }], privacyLevel: 'detailed', retentionDays: 14 }) },
      { method: 'runDigest', body: expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }) }
    ]);
    expect(calls[2]?.body).toEqual(calls[4]?.body);
    expectFirstDigestWindowContract(calls[2]?.body);
    expectFirstDigestWindowContract(calls[4]?.body);
    expect(retried.status).toBe('complete');
    expect(JSON.stringify(retried)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(retried)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(retried)).not.toContain(validDraft.telegramBotToken);
  });

  test('keeps API validation failures actionable and secret-safe', async () => {
    const api: OnboardingApi = {
      getSettings: async () => {
        throw new Error('getSettings should not be called');
      },
      updateSettings: async () => {
        throw new Error('updateSettings should not be called');
      },
      validateSetup: async () => {
        throw new ApiClientError('VALIDATION_FAILED', 'Request validation failed.', 'req-1', {
          aiKey: ['Provider rejected sample ai private value']
        });
      },
      runDigest: async () => {
        throw new Error('runDigest should not be called');
      }
    };

    const result = await completeOnboarding({ ...createInitialOnboardingState(), draft: validDraft }, api);

    expect(result.status).toBe('failed');
    expect(result.step).toBe('aiProvider');
    expect(result.errors.aiKey?.[0]).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(validDraft.aiKey);
  });

  test('scrubs secrets when local validation fails before any API call', async () => {
    const api: OnboardingApi = {
      getSettings: async () => {
        throw new Error('getSettings should not be called');
      },
      updateSettings: async () => {
        throw new Error('updateSettings should not be called');
      },
      validateSetup: async () => {
        throw new Error('validateSetup should not be called');
      },
      runDigest: async () => {
        throw new Error('runDigest should not be called');
      }
    };

    const result = await completeOnboarding({ ...createInitialOnboardingState(), draft: { ...validDraft, haUrl: 'not a url' } }, api);

    expect(result.status).toBe('failed');
    expect(result.step).toBe('homeAssistant');
    expect(JSON.stringify(result)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(result)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(result)).not.toContain(validDraft.telegramBotToken);
  });
});

async function mountOnboardingFlow(api: OnboardingApi) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(<OnboardingFlow state={{ ...createInitialOnboardingState(), step: 'firstDigest', draft: validDraft }} api={api} />);
  });

  return { container, root };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function expectFirstDigestWindowContract(body: unknown) {
  expect(body).toEqual(expect.objectContaining({ kind: 'manual', window: { from: expect.any(String), to: expect.any(String) } }));

  const window = (body as { window: { from: string; to: string } }).window;
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);

  expect(Number.isNaN(fromMs)).toBe(false);
  expect(Number.isNaN(toMs)).toBe(false);
  expect(fromMs).toBeLessThan(toMs);
  expect(toMs - fromMs).toBe(24 * 60 * 60 * 1000);
}
