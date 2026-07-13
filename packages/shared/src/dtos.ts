import { z } from 'zod';

export const AiProviderSchema = z.enum(['openai', 'gemini']);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const NotifierChannelSchema = z.enum(['home_assistant', 'email', 'telegram', 'markdown']);
export type NotifierChannel = z.infer<typeof NotifierChannelSchema>;

export const DigestKindSchema = z.enum(['manual', 'daily', 'weekly']);
export type DigestKind = z.infer<typeof DigestKindSchema>;

export const PrivacyLevelSchema = z.enum(['minimal', 'balanced', 'detailed']);
export type PrivacyLevel = z.infer<typeof PrivacyLevelSchema>;

export const DeliveryStatusSchema = z.enum(['pending', 'sent', 'failed', 'skipped']);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const SecretRefSchema = z.string().min(1);
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const HH_MM_24_HOUR_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const MAX_RETENTION_DAYS = 3650;
const MAX_NOTIFIER_TEST_MESSAGE_LENGTH = 2000;
const MAX_IGNORE_REASON_LENGTH = 500;
const MAX_NOTE_TEXT_LENGTH = 4000;

export const SCHEDULE_DAY_OF_WEEK = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6
} as const;

const DayOfWeekSchema = z
  .number()
  .int()
  .min(SCHEDULE_DAY_OF_WEEK.SUNDAY)
  .max(SCHEDULE_DAY_OF_WEEK.SATURDAY);

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const DigestWindowSchema = z
  .object({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema
  })
  .strict()
  .refine((window) => Date.parse(window.from) < Date.parse(window.to), {
    message: 'Digest window from must be before to',
    path: ['to']
  });
export type DigestWindowDto = z.infer<typeof DigestWindowSchema>;

export const ScheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('daily'),
      enabled: z.boolean(),
      time: z.string().regex(HH_MM_24_HOUR_PATTERN, 'Schedule time must use HH:mm in 24-hour format'),
      timezone: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      enabled: z.boolean(),
      time: z.string().regex(HH_MM_24_HOUR_PATTERN, 'Schedule time must use HH:mm in 24-hour format'),
      timezone: z.string().min(1),
      // Home Assistant convention: Sunday is 0, Saturday is 6.
      dayOfWeek: DayOfWeekSchema
    })
    .strict()
]);
export type ScheduleDto = z.infer<typeof ScheduleSchema>;

export const TelegramSetupRequestSchema = z
  .object({
    botToken: z.string().min(1),
    chatId: z.string().min(1)
  })
  .strict();

export const SetupValidationRequestSchema = z
  .object({
    haUrl: z.string().url(),
    haToken: z.string().min(1),
    aiProvider: AiProviderSchema,
    aiKey: z.string().min(1),
    telegram: TelegramSetupRequestSchema.optional()
  })
  .strict();
export type SetupValidationRequest = z.infer<typeof SetupValidationRequestSchema>;

export const MaskedAiSettingsSchema = z
  .object({
    provider: AiProviderSchema,
    keyMask: z.string().min(1),
    ref: SecretRefSchema
  })
  .strict();

export const MaskedNotifierSettingsSchema = z
  .object({
    id: z.string().min(1),
    channel: NotifierChannelSchema,
    targetRef: SecretRefSchema,
    label: z.string().min(1),
    secretMask: z.string().min(1).optional()
  })
  .strict();
export type MaskedNotifierSettings = z.infer<typeof MaskedNotifierSettingsSchema>;

export const MaskedSettingsSchema = z
  .object({
    haUrl: z.string().url(),
    ai: MaskedAiSettingsSchema,
    notifiers: z.array(MaskedNotifierSettingsSchema)
  })
  .strict();
export type MaskedSettings = z.infer<typeof MaskedSettingsSchema>;

export const SetupValidationResponseSchema = z
  .object({
    settings: MaskedSettingsSchema,
    csrfToken: z.string().min(1)
  })
  .strict();
export type SetupValidationResponse = z.infer<typeof SetupValidationResponseSchema>;

export const RedactedSettingsDtoSchema = z
  .object({
    haUrl: z.string().url(),
    aiProvider: AiProviderSchema,
    secretRefs: z
      .object({
        haTokenRef: SecretRefSchema,
        aiKeyRef: SecretRefSchema,
        notifierRefs: z.record(SecretRefSchema).optional()
      })
      .strict(),
    schedules: z.array(ScheduleSchema),
    privacyLevel: PrivacyLevelSchema,
    retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS)
  })
  .strict();
export type RedactedSettingsDto = z.infer<typeof RedactedSettingsDtoSchema>;

export const NotifierTestRequestSchema = z
  .object({
    channel: NotifierChannelSchema,
    targetRef: SecretRefSchema,
    message: z.string().max(MAX_NOTIFIER_TEST_MESSAGE_LENGTH).optional()
  })
  .strict();
export type NotifierTestRequest = z.infer<typeof NotifierTestRequestSchema>;

export const TestResultSchema = z
  .object({
    status: z.enum(['success', 'failed']),
    message: z.string(),
    checkedAt: IsoDateTimeSchema
  })
  .strict();
export type TestResult = z.infer<typeof TestResultSchema>;

export const SendDigestRequestSchema = z
  .object({
    digestId: z.string().min(1),
    targetRef: SecretRefSchema
  })
  .strict();
export type SendDigestRequest = z.infer<typeof SendDigestRequestSchema>;

export const DeliveryResultSchema = z
  .object({
    status: DeliveryStatusSchema,
    targetRef: SecretRefSchema,
    deliveredAt: IsoDateTimeSchema.optional(),
    errorCode: z.string().min(1).optional(),
    message: z.string().optional()
  })
  .strict();
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

export const RunDigestRequestSchema = z
  .object({
    kind: DigestKindSchema,
    window: DigestWindowSchema.optional()
  })
  .strict();
export type RunDigestRequest = z.infer<typeof RunDigestRequestSchema>;

export const RunDigestResponseSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.enum(['queued', 'already_queued'])
  })
  .strict();
export type RunDigestResponse = z.infer<typeof RunDigestResponseSchema>;

export const SeverityCountsSchema = z
  .object({
    critical: z.number().int().min(0),
    warning: z.number().int().min(0),
    info: z.number().int().min(0)
  })
  .strict();

export const DigestSummarySchema = z
  .object({
    id: z.string().min(1),
    window: DigestWindowSchema,
    severityCounts: SeverityCountsSchema,
    createdAt: IsoDateTimeSchema,
    deliveryStatus: DeliveryStatusSchema
  })
  .strict();
export type DigestSummary = z.infer<typeof DigestSummarySchema>;

export const DigestHistoryResponseSchema = z.array(DigestSummarySchema);
export type DigestHistoryResponse = z.infer<typeof DigestHistoryResponseSchema>;

export const IgnoreRuleTypeSchema = z.enum(['entity', 'integration', 'automation', 'area', 'message']);

export const IgnoreRuleCreateSchema = z
  .object({
    match: z.string().min(1),
    type: IgnoreRuleTypeSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
    reason: z.string().max(MAX_IGNORE_REASON_LENGTH).optional()
  })
  .strict();
export type IgnoreRuleCreate = z.infer<typeof IgnoreRuleCreateSchema>;

export const IgnoreRuleDtoSchema = z
  .object({
    id: z.string().min(1),
    match: z.string().min(1),
    type: IgnoreRuleTypeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    reason: z.string().max(MAX_IGNORE_REASON_LENGTH).optional()
  })
  .strict();
export type IgnoreRuleDto = z.infer<typeof IgnoreRuleDtoSchema>;

export const NoteCreateSchema = z
  .object({
    text: z.string().min(1).max(MAX_NOTE_TEXT_LENGTH),
    occurredAt: IsoDateTimeSchema,
    tags: z.array(z.string().min(1)).default([])
  })
  .strict();
export type NoteCreate = z.infer<typeof NoteCreateSchema>;

export const NoteDtoSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(MAX_NOTE_TEXT_LENGTH),
    occurredAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    tags: z.array(z.string().min(1))
  })
  .strict();
export type NoteDto = z.infer<typeof NoteDtoSchema>;

export const ErrorDtoSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    fieldErrors: z.record(z.array(z.string())).optional()
  })
  .strict();
export type ErrorDto = z.infer<typeof ErrorDtoSchema>;
