import { useState, type ChangeEvent, type FormEvent } from 'react';
import { type AiProvider, type MaskedSettings, type RunDigestRequest, type RunDigestResponse, type SetupValidationRequest, type SetupValidationResponse } from '@ha-digest/shared';
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
};

export type OnboardingState = {
  step: OnboardingStep;
  status: 'editing' | 'submitting' | 'complete' | 'failed';
  draft: OnboardingDraft;
  errors: Record<string, string[]>;
  maskedSettings?: MaskedSettings;
  firstDigestJob?: RunDigestResponse;
};

export type OnboardingApi = {
  validateSetup(input: SetupValidationRequest): Promise<SetupValidationResponse>;
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
};

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
      telegramChatId: ''
    }
  };
}

export function advanceOnboardingStep(state: OnboardingState): OnboardingState {
  const errors = validateStep(state.step, state.draft);
  if (Object.keys(errors).length > 0) return { ...state, status: 'failed', errors };

  return { ...state, status: 'editing', errors: {}, step: steps[Math.min(steps.indexOf(state.step) + 1, steps.length - 1)] ?? state.step };
}

export async function completeOnboarding(state: OnboardingState, api: OnboardingApi): Promise<OnboardingState> {
  const errors = steps.slice(0, -1).reduce<Record<string, string[]>>((all, step) => ({ ...all, ...validateStep(step, state.draft) }), {});
  if (Object.keys(errors).length > 0) return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors, step: stepForField(Object.keys(errors)[0] ?? '') };

  try {
    const setup = await api.validateSetup(toSetupRequest(state.draft));
    const firstDigestJob = await api.runDigest({ kind: 'manual' });
    return { ...state, draft: scrubSecrets(state.draft), step: 'firstDigest', status: 'complete', errors: {}, maskedSettings: setup.settings, firstDigestJob };
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
  const updateDraft = (field: keyof OnboardingDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setState((current) => ({ ...current, draft: { ...current.draft, [field]: event.target.value } }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.step !== 'firstDigest') return setState((current) => advanceOnboardingStep(current));
    if (!api) return;
    setState((current) => ({ ...current, status: 'submitting' }));
    void completeOnboarding(state, api).then(setState);
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
        <div className="privacy-card">{t('onboarding.schedulePrivacyNotice')}</div>
        <button type="submit">{actionLabelForState(state)}</button>
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
  return errors;
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
  return 'firstDigest';
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
