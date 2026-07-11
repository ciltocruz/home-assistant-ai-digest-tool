import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
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
  telegramChatId: 'sample chat reference'
};

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
    expect(html).toContain('Usaremos temporalmente un informe diario a las 08:00 de Europe/Madrid con privacidad equilibrada.');
    expect(html).not.toContain('Hora diaria');
    expect(html).not.toContain('Zona horaria');
    expect(html).not.toContain('Nivel de privacidad');
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

  test('schedule and privacy are fixed defaults until settings persistence exists', () => {
    const result = advanceOnboardingStep({
      ...createInitialOnboardingState(),
      step: 'schedulePrivacy',
      draft: validDraft
    });

    expect(result.step).toBe('firstDigest');
    expect(result.errors).toEqual({});
  });

  test('keeps stale schedule/privacy copy and hard-coded setup rail counts out of the slice', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

    expect(JSON.stringify(createInitialOnboardingState().draft)).not.toContain('dailyTime');
    expect(JSON.stringify(createInitialOnboardingState().draft)).not.toContain('timezone');
    expect(JSON.stringify(createInitialOnboardingState().draft)).not.toContain('privacyLevel');
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
      { method: 'runDigest', body: { kind: 'manual' } }
    ]);
    expect(result.status).toBe('complete');
    expect(result.maskedSettings?.ai.keyMask).toBe('••••-provider');
    expect(result.firstDigestJob).toEqual({ jobId: 'job-first-digest', status: 'queued' });
    expect(JSON.stringify(result)).not.toContain(validDraft.haToken);
    expect(JSON.stringify(result)).not.toContain(validDraft.aiKey);
    expect(JSON.stringify(result)).not.toContain(validDraft.telegramBotToken);
  });

  test('keeps API validation failures actionable and secret-safe', async () => {
    const api: OnboardingApi = {
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
