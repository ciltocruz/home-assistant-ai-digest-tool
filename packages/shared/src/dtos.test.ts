import { describe, expect, it } from 'vitest';
import {
  DigestSummarySchema,
  DigestWindowSchema,
  ErrorDtoSchema,
  EditableSettingsDtoSchema,
  OnboardingProgressSchema,
  OnboardingStepCommandSchema,
  ReportPresentationV1Schema,
  RedactedSettingsDtoSchema,
  ScheduleSchema,
  SettingsUpdateCommandSchema,
  SetupValidationRequestSchema,
  SetupValidationResponseSchema
} from './dtos';

describe('shared DTOs', () => {
  it('accepts resumable onboarding progress without serializing secret values or references', () => {
    const command = OnboardingStepCommandSchema.parse({
      step: 'home_assistant',
      draft: { haUrl: 'http://homeassistant.local:8123' },
      secrets: { haToken: 'sentinel-onboarding-secret' }
    });
    const progress = OnboardingProgressSchema.parse({
      currentStep: 'ai_provider',
      completedSteps: ['home_assistant'],
      draft: { haUrl: 'http://homeassistant.local:8123' },
      secretMetadata: { haToken: { configured: true, mask: 'se…et' } },
      completed: false
    });

    expect(command.secrets.haToken).toBe('sentinel-onboarding-secret');
    expect(JSON.stringify(progress)).not.toContain('sentinel-onboarding-secret');
    expect(JSON.stringify(progress)).not.toContain('secret_ref');
  });
  it('accepts raw secrets only in setup validation requests', () => {
    const request = SetupValidationRequestSchema.parse({
      haUrl: 'https://home-assistant.local:8123',
      haToken: 'sentinel-raw-ha-credential',
      aiProvider: 'gemini',
      aiKey: 'sentinel-raw-ai-credential',
      telegram: {
        botToken: 'sentinel-raw-telegram-credential',
        chatId: '123456'
      }
    });

    expect(request.haToken).toBe('sentinel-raw-ha-credential');
    expect(request.aiKey).toBe('sentinel-raw-ai-credential');
    expect(request.telegram?.botToken).toBe('sentinel-raw-telegram-credential');
  });

  it('rejects raw secrets in setup validation responses', () => {
    const parsed = SetupValidationResponseSchema.parse({
      csrfToken: 'csrf-session-code',
      settings: {
        haUrl: 'https://home-assistant.local:8123',
        ai: {
          provider: 'openai',
          keyMask: 'sentinel-redacted-abcd',
          ref: 'secret_ai_openai'
        },
        notifiers: [
          {
            id: 'notifier_telegram',
            channel: 'telegram',
            targetRef: 'secret_telegram_default',
            label: 'Telegram',
            secretMask: '123...789'
          }
        ]
      }
    });

    expect(JSON.stringify(parsed)).not.toContain('raw');
    expect(JSON.stringify(parsed)).not.toContain('botToken');
    expect(JSON.stringify(parsed)).not.toContain('haToken');
    expect(JSON.stringify(parsed)).not.toContain('aiKey');
  });

  it('accepts setup validation responses that bootstrap an authenticated CSRF token', () => {
    const parsed = SetupValidationResponseSchema.parse({
      csrfToken: 'csrf-session-code',
      settings: {
        haUrl: 'https://home-assistant.local:8123',
        ai: {
          provider: 'openai',
          keyMask: 'sentinel-redacted-abcd',
          ref: 'secret_ai_openai'
        },
        notifiers: []
      }
    });

    expect(parsed.csrfToken).toBe('csrf-session-code');
  });

  it('keeps settings redacted with secret refs and masks', () => {
    const settings = RedactedSettingsDtoSchema.parse({
      haUrl: 'https://home-assistant.local:8123',
      aiProvider: 'gemini',
      secretRefs: {
        haTokenRef: 'secret_ha_token',
        aiKeyRef: 'secret_ai_key'
      },
      schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
      privacyLevel: 'balanced',
      retentionDays: 30
    });

    expect(settings.secretRefs.aiKeyRef).toBe('secret_ai_key');
    expect(JSON.stringify(settings)).not.toContain('sentinel-raw-ai-credential');
  });

  it('accepts explicit secret operations while refusing raw values and references in editable settings', () => {
    const command = SettingsUpdateCommandSchema.parse({
      homeAssistant: { url: 'https://home-assistant.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'openai', key: { operation: 'replace', value: 'sentinel-new-provider-key' } },
      notifications: { channel: 'none' },
      schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
      privacyLevel: 'minimal',
      retentionDays: 14
    });

    expect(command.ai.key).toEqual({ operation: 'replace', value: 'sentinel-new-provider-key' });
    expect(() => EditableSettingsDtoSchema.parse({
      homeAssistant: { url: 'https://home-assistant.local:8123', token: { configured: true, mask: '••••' }, tokenRef: 'secret-ha' },
      ai: { provider: 'openai', key: { configured: true, mask: '••••' } },
      notifications: { channel: 'none' },
      schedules: command.schedules,
      privacyLevel: command.privacyLevel,
      retentionDays: command.retentionDays
    })).toThrow();
  });

  it('accepts valid schedule times at HH:mm boundaries', () => {
    expect(
      ScheduleSchema.parse({ kind: 'daily', enabled: true, time: '00:00', timezone: 'Europe/Madrid' }).time
    ).toBe('00:00');
    expect(
      ScheduleSchema.parse({ kind: 'weekly', enabled: true, time: '23:59', timezone: 'Europe/Madrid', dayOfWeek: 6 })
        .time
    ).toBe('23:59');
  });

  it('rejects weekly schedules without dayOfWeek', () => {
    expect(() =>
      ScheduleSchema.parse({ kind: 'weekly', enabled: true, time: '08:00', timezone: 'Europe/Madrid' })
    ).toThrow();
  });

  it('accepts weekly schedules with valid dayOfWeek', () => {
    const schedule = ScheduleSchema.parse({
      kind: 'weekly',
      enabled: true,
      time: '08:00',
      timezone: 'Europe/Madrid',
      dayOfWeek: 1
    });

    expect(schedule.dayOfWeek).toBe(1);
  });

  it('rejects daily schedules with dayOfWeek', () => {
    expect(() =>
      ScheduleSchema.parse({ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid', dayOfWeek: 1 })
    ).toThrow();
  });

  it.each([-1, 7, 1.5])('rejects invalid dayOfWeek %s', (dayOfWeek) => {
    expect(() =>
      ScheduleSchema.parse({ kind: 'weekly', enabled: true, time: '08:00', timezone: 'Europe/Madrid', dayOfWeek })
    ).toThrow();
  });

  it.each(['24:00', '23:60', '99:99', '-1:00', '8:00', '08:0'])('rejects invalid schedule time %s', (time) => {
    expect(() =>
      ScheduleSchema.parse({ kind: 'daily', enabled: true, time, timezone: 'Europe/Madrid' })
    ).toThrow();
  });

  it('accepts digest windows when from is before to', () => {
    const window = DigestWindowSchema.parse({
      from: '2026-07-06T00:00:00.000Z',
      to: '2026-07-06T23:59:59.999Z'
    });

    expect(window.from).toBe('2026-07-06T00:00:00.000Z');
  });

  it('rejects digest windows when from equals or follows to', () => {
    const equalWindow = {
      from: '2026-07-06T00:00:00.000Z',
      to: '2026-07-06T00:00:00.000Z'
    };
    const reversedWindow = {
      from: '2026-07-07T00:00:00.000Z',
      to: '2026-07-06T00:00:00.000Z'
    };

    expect(() => DigestWindowSchema.parse(equalWindow)).toThrow();
    expect(() => DigestWindowSchema.parse(reversedWindow)).toThrow();
  });

  it('returns digest history summaries without provider payloads', () => {
    const summary = DigestSummarySchema.parse({
      id: 'digest_2026_07_06',
      window: {
        from: '2026-07-06T00:00:00.000Z',
        to: '2026-07-06T23:59:59.999Z'
      },
      severityCounts: { critical: 0, warning: 2, info: 3 },
      createdAt: '2026-07-06T20:00:00.000Z',
      deliveryStatus: 'sent'
    });

    expect(summary.deliveryStatus).toBe('sent');
    expect(JSON.stringify(summary)).not.toContain('providerPayload');
  });

  it('accepts optional legacy and v2 report sources while keeping old summaries valid', () => {
    const summary = {
      id: 'digest-source',
      window: { from: '2026-07-06T00:00:00.000Z', to: '2026-07-06T23:59:59.999Z' },
      severityCounts: { critical: 0, warning: 0, info: 0 },
      createdAt: '2026-07-06T20:00:00.000Z',
      deliveryStatus: 'pending' as const
    };

    expect(DigestSummarySchema.parse({ ...summary, source: 'legacy' }).source).toBe('legacy');
    expect(DigestSummarySchema.parse({ ...summary, source: 'v2' }).source).toBe('v2');
    expect(DigestSummarySchema.parse(summary)).not.toHaveProperty('source');
  });

  it('accepts only durable manual job responses and credential-free report detail', async () => {
    const { RunDigestRequestSchema, RunDigestResponseSchema, DigestJobStatusSchema, DigestDetailSchema } = await import('./dtos');
    expect(RunDigestRequestSchema.parse({ kind: 'manual' })).toEqual({ kind: 'manual' });
    expect(() => RunDigestRequestSchema.parse({ kind: 'daily' })).toThrow();
    expect(RunDigestResponseSchema.parse({ status: 'queued', jobId: 'job-1' })).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(DigestJobStatusSchema.parse({ id: 'job-1', status: 'completed', stage: 'completed', attempts: 1, retryCount: 0, retryAvailable: false, reportId: 'digest-1', createdAt: '2026-07-06T01:00:00.000Z', updatedAt: '2026-07-06T01:00:00.000Z' })).toMatchObject({ reportId: 'digest-1' });
    expect(DigestDetailSchema.parse({ id: 'digest-1', summary: { id: 'digest-1', window: { from: '2026-07-06T00:00:00.000Z', to: '2026-07-06T01:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-07-06T01:00:00.000Z', deliveryStatus: 'pending' }, rendered: { format: 'markdown', body: '# Digest' } }).rendered.body).toBe('# Digest');
  });

  it('accepts versioned structured report presentations from the API', () => {
    expect(ReportPresentationV1Schema.parse({
      version: 1,
      mode: 'structured',
      overview: { title: 'Home Assistant Digest', detail: 'One condition needs review.' },
      attention: [{ id: 'attention-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
      observations: [{ id: 'observations-1', severity: 'info', title: 'Hallway temperature', detail: 'Changed more often than usual.' }],
      allGood: [],
      recommendations: [{ id: 'recommendation-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
      evidence: [{ id: 'evidence-1', title: 'Recorder window', detail: 'No gaps were reported.' }]
    })).toMatchObject({ mode: 'structured', version: 1 });
  });

  it('returns field-safe errors without secret values', () => {
    const error = ErrorDtoSchema.parse({
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      requestId: 'req_123',
      fieldErrors: {
        aiKey: ['Invalid key format']
      }
    });

    expect(error.fieldErrors?.aiKey).toEqual(['Invalid key format']);
    expect(JSON.stringify(error)).not.toContain('sentinel-raw-ai-credential');
  });

  it('accepts only bounded public Telegram delivery diagnostics', () => {
    const summary = DigestSummarySchema.parse({
      id: 'report-safe-delivery',
      window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' },
      severityCounts: { critical: 0, warning: 1, info: 0 },
      createdAt: '2026-08-13T10:00:00.000Z',
      deliveryStatus: 'failed',
      deliveryDiagnostic: {
        channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_HTTP_429',
        messageKey: 'telegram_rate_limited', recordedAt: '2026-08-13T10:00:01.000Z'
      }
    });

    expect(summary.deliveryDiagnostic).toMatchObject({ errorCode: 'TELEGRAM_HTTP_429', messageKey: 'telegram_rate_limited' });
    expect(() => DigestSummarySchema.parse({ ...summary, deliveryDiagnostic: { ...summary.deliveryDiagnostic, errorCode: 'PROVIDER_RAW_SENTINEL', rawBody: 'secret response' } })).toThrow();
  });

  it('accepts a bounded indeterminate Telegram response while preserving older diagnostics', () => {
    const base = {
      id: 'report-indeterminate-delivery',
      window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' },
      severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-13T10:00:00.000Z'
    };
    const current = DigestSummarySchema.parse({
      ...base, deliveryStatus: 'pending',
      deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z' }
    });
    const old = DigestSummarySchema.parse({
      ...base, deliveryStatus: 'failed',
      deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_REJECTED', messageKey: 'telegram_rejected', recordedAt: '2026-08-13T10:00:01.000Z' }
    });

    expect(current.deliveryDiagnostic?.errorCode).toBe('TELEGRAM_INVALID_RESPONSE');
    expect(old.deliveryDiagnostic?.errorCode).toBe('TELEGRAM_REJECTED');
  });

  it('rejects raw secret fields in response DTOs', () => {
    expect(() =>
      SetupValidationResponseSchema.parse({
        settings: {
          haUrl: 'https://home-assistant.local:8123',
          haToken: 'sentinel-raw-ha-credential',
          ai: {
            provider: 'openai',
            keyMask: 'sentinel-redacted-abcd',
            ref: 'secret_ai_openai',
            aiKey: 'sentinel-raw-ai-credential'
          },
          notifiers: []
        }
      })
    ).toThrow();
  });
});
