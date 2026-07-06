import { describe, expect, it } from 'vitest';
import {
  DigestSummarySchema,
  DigestWindowSchema,
  ErrorDtoSchema,
  RedactedSettingsDtoSchema,
  ScheduleSchema,
  SetupValidationRequestSchema,
  SetupValidationResponseSchema
} from './dtos';

describe('shared DTOs', () => {
  it('accepts raw secrets only in setup validation requests', () => {
    const request = SetupValidationRequestSchema.parse({
      haUrl: 'https://home-assistant.local:8123',
      haToken: 'raw-ha-token',
      aiProvider: 'gemini',
      aiKey: 'raw-ai-key',
      telegram: {
        botToken: 'raw-bot-token',
        chatId: '123456'
      }
    });

    expect(request.haToken).toBe('raw-ha-token');
    expect(request.aiKey).toBe('raw-ai-key');
    expect(request.telegram?.botToken).toBe('raw-bot-token');
  });

  it('rejects raw secrets in setup validation responses', () => {
    const parsed = SetupValidationResponseSchema.parse({
      settings: {
        haUrl: 'https://home-assistant.local:8123',
        ai: {
          provider: 'openai',
          keyMask: 'sk-...abcd',
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
    expect(JSON.stringify(settings)).not.toContain('raw-ai-key');
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
    expect(JSON.stringify(error)).not.toContain('raw-ai-key');
  });

  it('rejects raw secret fields in response DTOs', () => {
    expect(() =>
      SetupValidationResponseSchema.parse({
        settings: {
          haUrl: 'https://home-assistant.local:8123',
          haToken: 'raw-ha-token',
          ai: {
            provider: 'openai',
            keyMask: 'sk-...abcd',
            ref: 'secret_ai_openai',
            aiKey: 'raw-ai-key'
          },
          notifiers: []
        }
      })
    ).toThrow();
  });
});
