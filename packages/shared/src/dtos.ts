import { z } from 'zod';

export const AiProviderSchema = z.enum(['openai', 'gemini', 'ollama']);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const NotifierChannelSchema = z.enum(['home_assistant', 'email', 'telegram', 'markdown']);
export type NotifierChannel = z.infer<typeof NotifierChannelSchema>;

export const DigestKindSchema = z.enum(['manual', 'daily', 'weekly']);
export type DigestKind = z.infer<typeof DigestKindSchema>;

export const PrivacyLevelSchema = z.enum(['minimal', 'balanced', 'detailed']);
export type PrivacyLevel = z.infer<typeof PrivacyLevelSchema>;

export const OnboardingStepSchema = z.enum(['home_assistant', 'ai_provider', 'notifications', 'schedule', 'privacy', 'first_report']);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

const OnboardingDraftSchema = z.object({
  haUrl: z.string().url().optional(),
  aiProvider: AiProviderSchema.optional(),
  notifier: z.enum(['telegram', 'markdown']).optional(),
  telegramChatId: z.string().min(1).optional(),
  dailyTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone: z.string().min(1).optional(),
  privacyLevel: PrivacyLevelSchema.optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  privacyAccepted: z.boolean().optional()
}).strict();

const OnboardingSecretsSchema = z.object({
  haToken: z.string().min(1).optional(),
  aiKey: z.string().min(1).optional(),
  telegramBotToken: z.string().min(1).optional()
}).strict();

export const OnboardingStepCommandSchema = z.object({
  step: OnboardingStepSchema,
  draft: OnboardingDraftSchema,
  secrets: OnboardingSecretsSchema
}).strict();
export type OnboardingStepCommand = z.infer<typeof OnboardingStepCommandSchema>;

export const OnboardingProgressSchema = z.object({
  currentStep: OnboardingStepSchema,
  completedSteps: z.array(OnboardingStepSchema),
  draft: OnboardingDraftSchema,
  secretMetadata: z.record(z.object({ configured: z.literal(true), mask: z.string().min(1) }).strict()),
  completed: z.boolean()
}).strict();
export type OnboardingProgress = z.infer<typeof OnboardingProgressSchema>;

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
  retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  includeWarnings: z.boolean().optional()
  })
  .strict();
export type RedactedSettingsDto = z.infer<typeof RedactedSettingsDtoSchema>;

export const SecretOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('keep_current') }).strict(),
  z.object({ operation: z.literal('replace'), value: z.string().min(1) }).strict()
]);
export type SecretOperation = z.infer<typeof SecretOperationSchema>;

const ConfiguredSecretSchema = z.object({
  configured: z.boolean(),
  mask: z.string().min(1).optional()
}).strict();

export const EditableSettingsDtoSchema = z.object({
  homeAssistant: z.object({
    url: z.string().url(),
    token: ConfiguredSecretSchema
  }).strict(),
  ai: z.object({
    provider: AiProviderSchema,
    key: ConfiguredSecretSchema
  }).strict(),
  notifications: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('none') }).strict(),
    z.object({ channel: z.literal('telegram'), chatId: z.string().min(1), botToken: ConfiguredSecretSchema }).strict()
  ]),
  schedules: z.array(ScheduleSchema),
  privacyLevel: PrivacyLevelSchema,
  retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  includeWarnings: z.boolean().optional()
}).strict();
export type EditableSettingsDto = z.infer<typeof EditableSettingsDtoSchema>;

export const SettingsUpdateCommandSchema = z.object({
  homeAssistant: z.object({
    url: z.string().url(),
    token: SecretOperationSchema
  }).strict(),
  ai: z.object({
    provider: AiProviderSchema,
    key: SecretOperationSchema
  }).strict(),
  notifications: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('none') }).strict(),
    z.object({ channel: z.literal('telegram'), chatId: z.string().min(1), botToken: SecretOperationSchema }).strict()
  ]),
  schedules: z.array(ScheduleSchema).min(1),
  privacyLevel: PrivacyLevelSchema,
    retentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
    includeWarnings: z.boolean().optional()
}).strict();
export type SettingsUpdateCommand = z.infer<typeof SettingsUpdateCommandSchema>;

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
    kind: z.literal('manual'),
    window: DigestWindowSchema.optional()
  })
  .strict();
export type RunDigestRequest = z.infer<typeof RunDigestRequestSchema>;

export const RunDigestResponseSchema = z
  .object({ jobId: z.string().min(1), status: z.enum(['queued', 'already_queued']) }).strict();
export type RunDigestResponse = z.infer<typeof RunDigestResponseSchema>;

export const DigestJobStageSchema = z.enum(['queued', 'collecting', 'detecting', 'generating', 'rendering', 'saving', 'completed', 'failed']);
export type DigestJobStage = z.infer<typeof DigestJobStageSchema>;

export const DigestJobStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  stage: DigestJobStageSchema,
  attempts: z.number().int().min(0),
  retryCount: z.number().int().min(0),
  retryAvailable: z.boolean(),
  reportId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
}).strict();
export type DigestJobStatus = z.infer<typeof DigestJobStatusSchema>;

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
    deliveryStatus: DeliveryStatusSchema,
    source: z.enum(['legacy', 'v2']).optional(),
    runStatus: z.enum(['quiet', 'reported', 'partial', 'failed']).optional(),
    warningCodes: z.array(z.string().min(1)).optional(),
    signatureCounts: z.object({ new: z.number().int().min(0), recurring: z.number().int().min(0), reactivated: z.number().int().min(0), latent: z.number().int().min(0) }).strict().optional()
  })
  .strict();
export type DigestSummary = z.infer<typeof DigestSummarySchema>;

export const DigestHistoryResponseSchema = z.array(DigestSummarySchema);
export type DigestHistoryResponse = z.infer<typeof DigestHistoryResponseSchema>;

export const ReportPresentationItemSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  title: z.string().min(1),
  detail: z.string().min(1)
}).strict();
export type ReportPresentationItem = z.infer<typeof ReportPresentationItemSchema>;

const StructuredReportPresentationV1Schema = z.object({
  version: z.literal(1),
  mode: z.literal('structured'),
  overview: z.object({ title: z.string().min(1), detail: z.string().min(1) }).strict(),
  attention: z.array(ReportPresentationItemSchema),
  observations: z.array(ReportPresentationItemSchema),
  allGood: z.array(ReportPresentationItemSchema),
  recommendations: z.array(ReportPresentationItemSchema),
  evidence: z.array(ReportPresentationItemSchema)
}).strict();

const LegacyMarkdownReportPresentationV1Schema = z.object({
  version: z.literal(1),
  mode: z.literal('legacy_markdown'),
  legacyMarkdown: z.string()
}).strict();

export const V2SignaturePresentationSchema = z.object({
  signature: z.string().min(1), component: z.string().min(1), level: z.enum(['ERROR', 'CRITICAL', 'WARNING']),
  classification: z.enum(['new', 'recurring', 'reactivated', 'latent']), trend: z.enum(['new', 'increasing', 'flat', 'decreasing']),
  occurrences: z.number().int().min(1), analysis: z.object({ summary: z.string().min(1), recommendation: z.string().min(1) }).strict().optional(),
  notes: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1).max(MAX_NOTE_TEXT_LENGTH),
    occurredAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    tags: z.array(z.string().min(1))
  }).strict()).max(10).optional()
}).strict();
export const V2ReportPresentationSchema = z.object({
  version: z.literal(2), mode: z.literal('batch'), status: z.enum(['quiet', 'reported', 'partial', 'failed']),
  warnings: z.array(z.string().min(1)), integrationStatus: z.object({ available: z.boolean(), integrations: z.array(z.object({ domain: z.string(), title: z.string().optional(), state: z.string().optional() }).strict()) }).strict().optional(),
  signatures: z.array(V2SignaturePresentationSchema), failure: z.string().min(1).optional()
}).strict();

export const ReportPresentationV1Schema = z.discriminatedUnion('mode', [
  StructuredReportPresentationV1Schema,
  LegacyMarkdownReportPresentationV1Schema,
  V2ReportPresentationSchema
]);
export type ReportPresentationV1 = z.infer<typeof ReportPresentationV1Schema>;

export const DigestDetailSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['legacy', 'v2']).optional(),
  summary: DigestSummarySchema,
  rendered: z.object({ format: z.literal('markdown'), body: z.string() }).strict(),
  presentation: ReportPresentationV1Schema.optional()
}).strict();
export type DigestDetail = z.infer<typeof DigestDetailSchema>;

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
