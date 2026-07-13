import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { HH_MM_24_HOUR_PATTERN, MAX_RETENTION_DAYS, type AiProvider, type DigestWindowDto, type MaskedSettings, type PrivacyLevel, type RedactedSettingsDto, type RunDigestRequest, type RunDigestResponse, type SetupValidationRequest, type SetupValidationResponse } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { t, type TranslationKey } from './i18n/index.js';

export type OnboardingStep = 'homeAssistant' | 'aiProvider' | 'notifier' | 'schedulePrivacy' | 'firstDigest';

export type OnboardingDraft = {
  haUrl: string;
  haToken: string;
  aiProvider: AiProvider;
  aiKey: string;
  notifier: 'telegram' | 'markdown';
  telegramBotToken: string;
  telegramChatId: string;
  dailyTime: string;
  timezone: string;
  privacyLevel: PrivacyLevel;
  retentionDays: string;
};

export type OnboardingState = {
  step: OnboardingStep;
  status: 'editing' | 'submitting' | 'complete' | 'failed';
  draft: OnboardingDraft;
  errors: Record<string, string[]>;
  maskedSettings?: MaskedSettings;
  firstDigestJob?: RunDigestResponse;
  setupProgress?: OnboardingSetupProgress;
};

export type OnboardingApi = {
  validateSetup(input: SetupValidationRequest): Promise<SetupValidationResponse>;
  getSettings(): Promise<RedactedSettingsDto>;
  updateSettings(input: RedactedSettingsDto): Promise<RedactedSettingsDto>;
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
};

type OnboardingSetupProgress = {
  maskedSettings: MaskedSettings;
  firstDigestWindow?: DigestWindowDto;
};

const FIRST_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const steps: OnboardingStep[] = ['homeAssistant', 'aiProvider', 'notifier', 'schedulePrivacy', 'firstDigest'];
const continueActionKeys = {
  homeAssistant: 'onboarding.actions.continue.homeAssistant',
  aiProvider: 'onboarding.actions.continue.aiProvider',
  notifier: 'onboarding.actions.continue.notifier',
  schedulePrivacy: 'onboarding.actions.continue.schedulePrivacy'
} satisfies Record<Exclude<OnboardingStep, 'firstDigest'>, TranslationKey>;

export function createInitialOnboardingState(): OnboardingState {
  return {
    step: 'homeAssistant',
    status: 'editing',
    errors: {},
    draft: {
      haUrl: '',
      haToken: '',
      aiProvider: 'gemini',
      aiKey: '',
      notifier: 'telegram',
      telegramBotToken: '',
      telegramChatId: '',
      dailyTime: '08:00',
      timezone: 'Europe/Madrid',
      privacyLevel: 'balanced',
      retentionDays: '90'
    }
  };
}

export function advanceOnboardingStep(state: OnboardingState): OnboardingState {
  const errors = validateStep(state.step, state.draft);
  if (Object.keys(errors).length > 0) return { ...state, status: 'failed', errors };

  return { ...state, status: 'editing', errors: {}, step: steps[Math.min(steps.indexOf(state.step) + 1, steps.length - 1)] ?? state.step };
}

export async function completeOnboarding(state: OnboardingState, api: OnboardingApi): Promise<OnboardingState> {
  if (state.status === 'complete') return state;

  if (state.setupProgress) return persistSettingsAndQueueDigest(state, api, state.setupProgress);

  const errors = steps.slice(0, -1).reduce<Record<string, string[]>>((all, step) => ({ ...all, ...validateStep(step, state.draft) }), {});
  if (Object.keys(errors).length > 0) return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors, step: stepForField(Object.keys(errors)[0] ?? '') };

  try {
    const setup = await api.validateSetup(toSetupRequest(state.draft));
    return persistSettingsAndQueueDigest(state, api, { maskedSettings: setup.settings });
  } catch (error) {
    const fieldErrors = error instanceof ApiClientError ? redactErrors(error.fieldErrors, state.draft) : undefined;
    return {
      ...state,
      draft: scrubSecrets(state.draft),
      status: 'failed',
      step: stepForField(Object.keys(fieldErrors ?? {})[0] ?? ''),
      errors: fieldErrors ?? { form: [redactSensitiveText(error instanceof Error ? error.message : 'No se pudo completar la configuración.')] }
    };
  }
}

export function OnboardingFlow({ state: initialState, api }: { state?: OnboardingState; api?: OnboardingApi }) {
  const [state, setState] = useState(initialState ?? createInitialOnboardingState());
  const isSubmitting = useRef(state.status === 'submitting');
  const updateDraft = (field: keyof OnboardingDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setState((current) => ({ ...current, draft: { ...current.draft, [field]: event.target.value } }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.step !== 'firstDigest') return setState((current) => advanceOnboardingStep(current));
    if (!api) return;
    if (isSubmitting.current || state.status === 'submitting' || state.status === 'complete') return;
    isSubmitting.current = true;
    setState((current) => ({ ...current, status: 'submitting' }));
    void completeOnboarding(state, api).then((nextState) => {
      isSubmitting.current = nextState.status === 'submitting';
      setState(nextState);
    });
  };

  return (
    <form className="panel onboarding-flow" aria-labelledby="onboarding-title" onSubmit={submit}>
      <div className="section-heading">
        <p className="eyebrow">{t('onboarding.eyebrow')}</p>
        <h2 id="onboarding-title">{t('onboarding.title')}</h2>
      </div>
      <ol className="setup-rail" aria-label={t('onboarding.progressLabel')}>
        {steps.map((step) => <li className={step === state.step ? 'is-active' : ''} key={step}>{t(`onboarding.stepLabels.${step}`)}</li>)}
      </ol>
      <div className="setup-grid">
        <label>{t('onboarding.fields.homeAssistantUrl')}<input value={state.draft.haUrl} onChange={updateDraft('haUrl')} placeholder="http://homeassistant.local:8123" /></label>
        <label>{t('onboarding.fields.homeAssistantToken')}<input value={state.draft.haToken} onChange={updateDraft('haToken')} placeholder="••••••••" type="password" /></label>
        <label>{t('onboarding.fields.aiProvider')}<select value={state.draft.aiProvider} onChange={updateDraft('aiProvider')}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
        <label>{t('onboarding.fields.aiKey')}<input value={state.draft.aiKey} onChange={updateDraft('aiKey')} placeholder="••••••••" type="password" /></label>
        <label>{t('onboarding.fields.notifier')}<select value={state.draft.notifier} onChange={updateDraft('notifier')}><option value="telegram">{t('onboarding.notifiers.telegram')}</option><option value="markdown">{t('onboarding.notifiers.markdown')}</option></select></label>
        {state.draft.notifier === 'telegram' ? <>
          <label>{t('onboarding.fields.telegramBotToken')}<input value={state.draft.telegramBotToken} onChange={updateDraft('telegramBotToken')} placeholder="••••••••" type="password" /></label>
          <label>{t('onboarding.fields.telegramChatId')}<input value={state.draft.telegramChatId} onChange={updateDraft('telegramChatId')} placeholder="123456789" /></label>
        </> : null}
        <label>{t('onboarding.fields.dailyTime')}<input value={state.draft.dailyTime} onChange={updateDraft('dailyTime')} placeholder="08:00" /></label>
        <label>{t('onboarding.fields.timezone')}<input value={state.draft.timezone} onChange={updateDraft('timezone')} placeholder="Europe/Madrid" /></label>
        <label>{t('onboarding.fields.privacyLevel')}<select value={state.draft.privacyLevel} onChange={updateDraft('privacyLevel')}><option value="minimal">{t('onboarding.privacy.minimal')}</option><option value="balanced">{t('onboarding.privacy.balanced')}</option><option value="detailed">{t('onboarding.privacy.detailed')}</option></select></label>
        <label>{t('onboarding.fields.retentionDays')}<input value={state.draft.retentionDays} onChange={updateDraft('retentionDays')} inputMode="numeric" placeholder="90" /></label>
        <div className="privacy-card">{t('onboarding.schedulePrivacyNotice')}</div>
        <button type="submit" disabled={state.status === 'submitting' || state.status === 'complete'}>{actionLabelForState(state)}</button>
      </div>
      {Object.entries(state.errors).map(([field, messages]) => <p className="field-error" key={field}>{messages.join(' ')}</p>)}
    </form>
  );
}

function validateStep(step: OnboardingStep, draft: OnboardingDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (step === 'homeAssistant') {
    try { new URL(draft.haUrl); } catch { errors.haUrl = [t('onboarding.errors.haUrl')]; }
    if (!draft.haToken.trim()) errors.haToken = [t('onboarding.errors.haToken')];
  }
  if (step === 'aiProvider' && !draft.aiKey.trim()) errors.aiKey = [t('onboarding.errors.aiKey')];
  if (step === 'notifier' && draft.notifier === 'telegram') {
    if (!draft.telegramBotToken.trim()) errors.telegramBotToken = [t('onboarding.errors.telegramBotToken')];
    if (!draft.telegramChatId.trim()) errors.telegramChatId = [t('onboarding.errors.telegramChatId')];
  }
  if (step === 'schedulePrivacy') {
    if (!HH_MM_24_HOUR_PATTERN.test(draft.dailyTime)) errors.dailyTime = [t('onboarding.errors.dailyTime')];
    if (!draft.timezone.trim()) errors.timezone = [t('onboarding.errors.timezone')];
    const retentionDays = Number(draft.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) errors.retentionDays = [t('onboarding.errors.retentionDays')];
  }
  return errors;
}

async function persistSettingsAndQueueDigest(state: OnboardingState, api: OnboardingApi, progress: OnboardingSetupProgress): Promise<OnboardingState> {
  let nextProgress = progress;
  const errors = validateStep('schedulePrivacy', state.draft);
  if (Object.keys(errors).length > 0) {
    return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors, step: 'schedulePrivacy' };
  }

  try {
    if (!hasSettingsPersistenceApi(api)) throw new Error(t('onboarding.errors.settingsPersistenceUnavailable'));

    const settingsUpdate = toSettingsUpdate(await api.getSettings(), state.draft);
    await api.updateSettings(settingsUpdate);
    nextProgress = { ...nextProgress, firstDigestWindow: nextProgress.firstDigestWindow ?? createFirstDigestWindow() };

    const firstDigestJob = await api.runDigest({ kind: 'manual', window: nextProgress.firstDigestWindow });
    return {
      ...state,
      draft: scrubSecrets(state.draft),
      step: 'firstDigest',
      status: 'complete',
      errors: {},
      maskedSettings: nextProgress.maskedSettings,
      firstDigestJob
    };
  } catch (error) {
    const fieldErrors = error instanceof ApiClientError ? redactErrors(error.fieldErrors, state.draft) : undefined;
    return {
      ...state,
      draft: scrubSecrets(state.draft),
      status: 'failed',
      step: stepForField(Object.keys(fieldErrors ?? {})[0] ?? ''),
      errors: fieldErrors ?? { form: [redactSensitiveText(error instanceof Error ? error.message : 'No se pudo completar la configuración.')] },
      maskedSettings: nextProgress.maskedSettings,
      setupProgress: nextProgress,
      firstDigestJob: undefined
    };
  }
}

function hasSettingsPersistenceApi(api: OnboardingApi): api is OnboardingApi {
  return typeof api.getSettings === 'function' && typeof api.updateSettings === 'function';
}

function toSetupRequest(draft: OnboardingDraft): SetupValidationRequest {
  return {
    haUrl: draft.haUrl,
    haToken: draft.haToken,
    aiProvider: draft.aiProvider,
    aiKey: draft.aiKey,
    ...(draft.notifier === 'telegram' ? { telegram: { botToken: draft.telegramBotToken, chatId: draft.telegramChatId } } : {})
  };
}

function stepForField(field: string): OnboardingStep {
  if (field.startsWith('ha')) return 'homeAssistant';
  if (field.startsWith('ai')) return 'aiProvider';
  if (field.startsWith('telegram')) return 'notifier';
  if (field === 'dailyTime' || field === 'timezone' || field === 'privacyLevel' || field === 'retentionDays') return 'schedulePrivacy';
  return 'firstDigest';
}

function toSettingsUpdate(currentSettings: RedactedSettingsDto, draft: OnboardingDraft): RedactedSettingsDto {
  return {
    ...currentSettings,
    schedules: [{ kind: 'daily', enabled: true, time: draft.dailyTime, timezone: draft.timezone }],
    privacyLevel: draft.privacyLevel,
    retentionDays: Number(draft.retentionDays)
  };
}

function createFirstDigestWindow(now = new Date()): DigestWindowDto {
  const to = now.toISOString();
  const from = new Date(now.getTime() - FIRST_DIGEST_WINDOW_MS).toISOString();
  return { from, to };
}

function actionLabelForState(state: OnboardingState): string {
  if (state.status === 'complete') return t('onboarding.actions.firstDigestQueued');
  if (state.step === 'firstDigest') return t('onboarding.actions.validateSetup');
  return t(continueActionKeys[state.step]);
}

function scrubSecrets(draft: OnboardingDraft): OnboardingDraft {
  return { ...draft, haToken: '', aiKey: '', telegramBotToken: '' };
}

function redactErrors(fieldErrors: Record<string, string[]> | undefined, draft: OnboardingDraft): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined;
  const secrets = [draft.haToken, draft.aiKey, draft.telegramBotToken].filter(Boolean);
  return Object.fromEntries(Object.entries(fieldErrors).map(([field, messages]) => [
    field,
    messages.map((message) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[redacted]'), redactSensitiveText(message)))
  ]));
}
