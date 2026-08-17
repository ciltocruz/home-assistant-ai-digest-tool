import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  HH_MM_24_HOUR_PATTERN,
  MAX_RETENTION_DAYS,
  type AiProvider,
  type DigestWindowDto,
  type EditableSettingsDto,
  type MaskedSettings,
  type OnboardingProgress,
  type PrivacyLevel,
  type RunDigestRequest,
  type RunDigestResponse,
  type SettingsUpdateCommand,
  type SetupValidationRequest,
  type SetupValidationResponse,
} from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { currentLocale, t, type TranslationKey } from './i18n/index.js';

export type OnboardingStep = 'homeAssistant' | 'aiProvider' | 'notifier' | 'schedule' | 'privacy' | 'firstDigest' | 'schedulePrivacy';

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
  privacyAccepted?: boolean;
};

export type OnboardingState = {
  step: OnboardingStep;
  status: 'editing' | 'validating' | 'saving' | 'launching' | 'queued' | 'complete' | 'failed';
  draft: OnboardingDraft;
  errors: Record<string, string[]>;
  maskedSettings?: MaskedSettings;
  firstDigestJob?: RunDigestResponse;
  setupProgress?: OnboardingSetupProgress;
};

export type OnboardingApi = {
  /** Test seam for pre-auth fixtures; the browser client uses account sessions. */
  validateSetup(input: SetupValidationRequest): Promise<SetupValidationResponse>;
  getSettings(): Promise<EditableSettingsDto>;
  updateSettings(input: SettingsUpdateCommand): Promise<EditableSettingsDto>;
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
  getOnboarding?(): Promise<OnboardingProgress>;
  saveOnboarding?(input: { step: OnboardingProgress['currentStep']; draft: Record<string, unknown>; secrets: Record<string, string> }): Promise<OnboardingProgress>;
  completeOnboarding?(): Promise<{ settings: MaskedSettings }>;
};

type OnboardingSetupProgress = {
  maskedSettings: MaskedSettings;
  firstDigestWindow?: DigestWindowDto;
};

const FIRST_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const steps: OnboardingStep[] = ['homeAssistant', 'aiProvider', 'notifier', 'schedule', 'privacy', 'firstDigest'];

const continueActionKeys = {
  homeAssistant: 'onboarding.actions.continue.homeAssistant',
  aiProvider: 'onboarding.actions.continue.aiProvider',
  notifier: 'onboarding.actions.continue.notifier',
  schedule: 'onboarding.actions.continue.schedule',
  privacy: 'onboarding.actions.continue.privacy',
  schedulePrivacy: 'onboarding.actions.continue.schedulePrivacy',
} satisfies Record<Exclude<OnboardingStep, 'firstDigest'>, TranslationKey>;

function copy(en: string, es: string): string { return currentLocale() === 'es' ? es : en; }
function stepMeta(): Record<Exclude<OnboardingStep, 'schedulePrivacy'>, { icon: string; eyebrow: string; title: string; desc: string }> { return {
  homeAssistant: {
    icon: '🏠',
    eyebrow: copy('Screen 1 of 5', 'Pantalla 1 de 5'), title: copy('Connect Home Assistant', 'Conecta Home Assistant'),
    desc: copy('Add the URL and a long-lived access token for your installation.', 'Añade la URL y un token de acceso de larga duración para tu instalación.'),
  },
  aiProvider: {
    icon: '🤖',
    eyebrow: copy('Screen 2 of 5', 'Pantalla 2 de 5'), title: copy('Choose your AI provider', 'Elige tu proveedor de IA'),
    desc: copy('The provider analyzes incidents and creates the report. Its key is always masked.', 'El proveedor analiza las incidencias y genera el informe. Su clave siempre queda enmascarada.'),
  },
  notifier: {
    icon: '📬',
    eyebrow: copy('Screen 3 of 5', 'Pantalla 3 de 5'), title: copy('Notification channel', 'Canal de notificaciones'),
    desc: copy('Reports are always available in the dashboard. Telegram is optional.', 'Los informes siempre están disponibles en el panel. Telegram es opcional.'),
  },
  schedule: {
    icon: '⏰',
    eyebrow: copy('Screen 4 of 5', 'Pantalla 4 de 5'), title: copy('Report schedule', 'Horario de informes'),
    desc: copy('Set when automatic reports run. You can always run one manually.', 'Define cuándo se generan los informes automáticos. Siempre puedes lanzar uno manualmente.'),
  },
  privacy: {
    icon: '🔒',
    eyebrow: copy('Screen 5 of 5', 'Pantalla 5 de 5'), title: copy('Privacy and retention', 'Privacidad y retención'),
    desc: copy('Choose what context can reach AI and how long local reports are retained.', 'Elige qué contexto puede enviarse a la IA y cuánto tiempo se conservan los informes locales.'),
  },
  firstDigest: {
    icon: '🚀',
    eyebrow: copy('Ready', 'Todo listo'), title: copy('Setup complete', 'Configuración completa'),
    desc: copy('Your settings are saved and the first report is queued.', 'La configuración está guardada y el primer informe está en cola.'),
  },
}; }

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
      retentionDays: '90',
      privacyAccepted: false,
    },
  };
}

export function advanceOnboardingStep(state: OnboardingState): OnboardingState {
  const errors = validateStep(state.step, state.draft);
  if (Object.keys(errors).length > 0) return { ...state, status: 'failed', errors };
  return {
    ...state,
    status: 'editing',
    errors: {},
    step: steps[Math.min(steps.indexOf(state.step) + 1, steps.length - 1)] ?? state.step,
  };
}

export function restoreOnboardingState(progress: OnboardingProgress): OnboardingState {
  const step = {
    home_assistant: 'homeAssistant',
    ai_provider: 'aiProvider',
    notifications: 'notifier',
    schedule: 'schedule',
    privacy: 'privacy',
    first_report: 'firstDigest',
  } as const;
  return {
    ...createInitialOnboardingState(),
    step: step[progress.currentStep],
    status: progress.completed ? 'complete' : 'editing',
    draft: {
      ...createInitialOnboardingState().draft,
      ...progress.draft,
      retentionDays: progress.draft.retentionDays?.toString() ?? '90',
    },
  };
}

export function createOnboardingCheckpoint(state: OnboardingState): {
  step: OnboardingProgress['currentStep'];
  draft: Record<string, unknown>;
  secrets: Record<string, string>;
} {
  const draft = state.draft;
  if (state.step === 'homeAssistant') return { step: 'home_assistant', draft: { haUrl: draft.haUrl }, secrets: { haToken: draft.haToken } };
  if (state.step === 'aiProvider') return { step: 'ai_provider', draft: { aiProvider: draft.aiProvider }, secrets: { aiKey: draft.aiKey } };
  if (state.step === 'notifier') return {
    step: 'notifications',
    draft: { notifier: draft.notifier, telegramChatId: draft.telegramChatId },
    secrets: draft.notifier === 'telegram' ? { telegramBotToken: draft.telegramBotToken } : {},
  };
  if (state.step === 'schedule') return { step: 'schedule', draft: { dailyTime: draft.dailyTime, timezone: draft.timezone }, secrets: {} };
  if (state.step === 'privacy' || state.step === 'schedulePrivacy') return {
    step: 'privacy',
    draft: { privacyLevel: draft.privacyLevel, retentionDays: Number(draft.retentionDays), privacyAccepted: draft.privacyAccepted === true },
    secrets: {},
  };
  return { step: 'first_report', draft: {}, secrets: {} };
}

export async function completeOnboarding(
  state: OnboardingState,
  api: OnboardingApi,
  onSessionCreated?: () => void,
): Promise<OnboardingState> {
  if (state.status === 'complete') return state;

  if (state.setupProgress) return persistSettingsAndQueueDigest(state, api, state.setupProgress);

  if (api.completeOnboarding) try {
    const setup = await api.completeOnboarding();
    onSessionCreated?.();
    return persistSettingsAndQueueDigest(state, api, { maskedSettings: setup.settings });
  } catch (error) {
    return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors: { form: [redactSensitiveText(error instanceof Error ? error.message : copy('Could not complete onboarding.', 'No se pudo completar la configuración.'))] } };
  }

  const errors = steps.slice(0, -1).reduce<Record<string, string[]>>(
    (all, step) => ({ ...all, ...validateStep(step, state.draft) }),
    {},
  );
  if (Object.keys(errors).length > 0) {
    return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors, step: stepForField(Object.keys(errors)[0] ?? '') };
  }

  if (!api.validateSetup) return { ...state, draft: scrubSecrets(state.draft), status: 'failed', errors: { form: ['Authenticated onboarding is unavailable.'] } };
  try {
    const setup = await api.validateSetup(toSetupRequest(state.draft));
    return persistSettingsAndQueueDigest(state, api, { maskedSettings: setup.settings });
  } catch (error) {
    const fieldErrors = error instanceof ApiClientError ? redactErrors(error.fieldErrors, state.draft) : undefined;
    return { ...state, draft: scrubSecrets(state.draft), status: 'failed', step: stepForField(Object.keys(fieldErrors ?? {})[0] ?? ''), errors: fieldErrors ?? { form: [redactSensitiveText(error instanceof Error ? error.message : copy('Could not complete onboarding.', 'No se pudo completar la configuración.'))] } };
  }
}

/* ── Main wizard component ─────────────────────────────── */

export function OnboardingFlow({
  state: initialState,
  api,
  onSessionCreated,
  onCompleted,
}: {
  state?: OnboardingState;
  api?: OnboardingApi;
  onSessionCreated?: () => void;
  onCompleted?: () => void;
}) {
  const [state, setState] = useState(initialState ?? createInitialOnboardingState());
  const isSubmitting = useRef(['validating', 'saving', 'launching'].includes(state.status));

  const updateDraft = (field: keyof OnboardingDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value =
      field === 'privacyAccepted' && event.target instanceof HTMLInputElement && event.target.type === 'checkbox'
        ? event.target.checked
        : event.target.value;
    setState((current) => ({ ...current, draft: { ...current.draft, [field]: value }, errors: {} }));
  };

  const setDraftField = (field: keyof OnboardingDraft, value: unknown) => {
    setState((current) => ({ ...current, draft: { ...current.draft, [field]: value }, errors: {} }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.step !== 'firstDigest') {
      const next = advanceOnboardingStep(state);
      if (next.status === 'failed' || !api?.saveOnboarding) return setState(next);
      void api
        .saveOnboarding(createOnboardingCheckpoint(state))
        .then((progress) => setState(restoreOnboardingState(progress)))
        .catch((error) =>
          setState({
            ...state,
            status: 'failed',
            errors: { form: [redactSensitiveText(error instanceof Error ? error.message : copy('Could not save progress.', 'No se pudo guardar el progreso.'))] },
          }),
        );
      return;
    }
    if (!api) {
      setState((current) => ({ ...current, status: 'failed', errors: { form: ['Authenticated onboarding is unavailable.'] } }));
      return;
    }
    if (isSubmitting.current || ['validating', 'saving', 'launching', 'queued', 'complete'].includes(state.status)) return;
    isSubmitting.current = true;
    setState((current) => ({ ...current, status: 'validating', errors: {} }));
    void completeOnboarding(state, api, onSessionCreated).then((nextState) => {
      isSubmitting.current = ['validating', 'saving', 'launching'].includes(nextState.status);
      setState(nextState);
      if (nextState.status === 'complete') onCompleted?.();
    });
  };

  const isBusy = ['validating', 'saving', 'launching'].includes(state.status);
  const isComplete = state.status === 'complete' || state.status === 'queued';
  const visibleSteps = steps.filter((s) => s !== 'firstDigest');
  const currentIdx = visibleSteps.indexOf(state.step as typeof visibleSteps[number]);

  return (
    <div className="onboarding-root">
      {/* Sidebar */}
      <aside className="onboarding-sidebar">
        <div className="onboarding-brand">
          <div className="onboarding-brand-icon">🏡</div>
          <div className="onboarding-brand-name">
            HA AI Digest
            <span>{copy('Initial setup', 'Configuración inicial')}</span>
          </div>
        </div>
        <ol className="onboarding-steps" aria-label={t('onboarding.progressLabel')}>
          {visibleSteps.map((step, idx) => {
            const isDone = isComplete || (currentIdx >= 0 && idx < currentIdx);
            const isActive = step === state.step && !isComplete;
            return (
              <li
                key={step}
                className={[
                  'onboarding-step',
                  isDone ? 'onboarding-step--done' : '',
                  isActive ? 'onboarding-step--active' : '',
                ].filter(Boolean).join(' ')}
              >
                <div className="step-indicator" aria-hidden="true">
                  {isDone ? '✓' : idx + 1}
                </div>
                <span className="step-label">{t(`onboarding.stepLabels.${step}`)}</span>
              </li>
            );
          })}
        </ol>
      </aside>

      {/* Main content */}
      <main className="onboarding-main" id="onboarding-flow">
        {!api && (
          <div className="onboarding-message-card" role="alert">
            Authenticated onboarding is unavailable.
          </div>
        )}

        {isComplete ? (
          <CompleteScreen job={state.firstDigestJob} onContinue={onCompleted} />
        ) : (
          <form key={state.step} className="onboarding-step-content" onSubmit={submit} aria-label={copy('Guided setup', 'Configuración guiada')} noValidate>
            <StepContent
              state={state}
              updateDraft={updateDraft}
              setDraftField={setDraftField}
              isBusy={isBusy}
            />
          </form>
        )}
      </main>
    </div>
  );
}

/* ── Step content router ─────────────────────────────────── */

function StepContent({
  state,
  updateDraft,
  setDraftField,
  isBusy,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setDraftField: (field: keyof OnboardingDraft, value: unknown) => void;
  isBusy: boolean;
}) {
  const step = state.step === 'schedulePrivacy' ? 'privacy' : state.step as Exclude<OnboardingStep, 'schedulePrivacy'>;
  const meta = stepMeta()[step];
  const hasErrors = Object.keys(state.errors).length > 0;

  return (
    <>
      <p className="onboarding-eyebrow">{meta.eyebrow}</p>
      <h1 className="onboarding-step-title" id="step-title">{meta.title}</h1>
      <p className="onboarding-step-desc">{meta.desc}</p>

      <div className="onboarding-fields">
        {state.step === 'homeAssistant' && <HomeAssistantFields state={state} updateDraft={updateDraft} />}
        {state.step === 'aiProvider' && <AiProviderFields state={state} updateDraft={updateDraft} setDraftField={setDraftField} />}
        {state.step === 'notifier' && <NotifierFields state={state} updateDraft={updateDraft} setDraftField={setDraftField} />}
        {state.step === 'schedule' && <ScheduleFields state={state} updateDraft={updateDraft} />}
        {(state.step === 'privacy' || state.step === 'schedulePrivacy') && (
          <PrivacyFields state={state} updateDraft={updateDraft} setDraftField={setDraftField} />
        )}
      </div>

      <div className="onboarding-actions">
        <button type="submit" className="btn-primary" disabled={isBusy}>
          {isBusy && <span className="spinner" aria-hidden="true" />}
          {state.step === 'firstDigest'
            ? isBusy ? copy('Validating…', 'Validando…') : t('onboarding.actions.validateSetup')
            : t(continueActionKeys[state.step as Exclude<OnboardingStep, 'firstDigest'>])}
        </button>
        {state.status === 'failed' && state.step === 'firstDigest' && (
          <button type="submit" className="btn-ghost">
            {t('onboarding.actions.retry')}
          </button>
        )}
      </div>

      {hasErrors && (
        <div className="onboarding-feedback onboarding-feedback--error" role="alert" aria-live="assertive">
          <span>⚠</span>
          <span>
            {state.errors.form?.[0] ??
              Object.values(state.errors).flat()[0] ??
              t('onboarding.progress.retry')}
          </span>
        </div>
      )}
      {!hasErrors && isBusy && (
        <p className="onboarding-feedback" aria-live="polite">
          {state.status === 'validating' && t('onboarding.progress.validating')}
          {state.status === 'saving' && t('onboarding.progress.saving')}
          {state.status === 'launching' && t('onboarding.progress.launching')}
        </p>
      )}
    </>
  );
}

/* ── Step field components ─────────────────────────────── */

function HomeAssistantFields({
  state,
  updateDraft,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
}) {
  return (
    <>
      <div className="field-group">
        <label htmlFor="haUrl">{copy('Home Assistant URL', 'URL de Home Assistant')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">🌐</span>
          <input
            id="haUrl"
            className={state.errors.haUrl ? '' : 'has-icon'}
            type="url"
            name="haUrl"
            autoComplete="url"
            required
            value={state.draft.haUrl}
            onChange={updateDraft('haUrl')}
            placeholder="http://homeassistant.local:8123"
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.haUrl && <span className="field-error-msg" role="alert">{state.errors.haUrl[0]}</span>}
      </div>

      <div className="field-group">
        <label htmlFor="haToken">{copy('Home Assistant token', 'Token de Home Assistant')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">🔑</span>
          <input
            id="haToken"
            type="password"
            name="haToken"
            autoComplete="off"
            required
            value={state.draft.haToken}
            onChange={updateDraft('haToken')}
            placeholder={copy('Paste your token…', 'Pega tu token aquí…')}
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.haToken && <span className="field-error-msg" role="alert">{state.errors.haToken[0]}</span>}
      </div>
    </>
  );
}

function AiProviderFields({
  state,
  setDraftField,
  updateDraft,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setDraftField: (field: keyof OnboardingDraft, value: unknown) => void;
}) {
  return (
    <>
      <div className="field-group">
        <label>{copy('Provider', 'Proveedor')}</label>
        <div className="provider-cards">
          {(['gemini', 'openai'] as AiProvider[]).map((provider) => (
            <button
              key={provider}
              type="button"
              className={`provider-card ${state.draft.aiProvider === provider ? 'is-selected' : ''}`}
              onClick={() => setDraftField('aiProvider', provider)}
            >
              <p className="provider-card-name">{provider === 'gemini' ? '✦ Gemini' : '⬡ OpenAI'}</p>
              <p className="provider-card-desc">
                {provider === 'gemini' ? 'Google — Gemini Pro / Flash' : 'OpenAI — GPT-4o / GPT-4'}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="field-group">
        <label htmlFor="aiKey">{copy('Provider API key', 'Clave API del proveedor')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">🔐</span>
          <input
            id="aiKey"
            type="password"
            name="aiKey"
            autoComplete="off"
            required
            value={state.draft.aiKey}
            onChange={updateDraft('aiKey')}
            placeholder={copy('Paste your key…', 'Pega tu clave aquí…')}
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.aiKey && <span className="field-error-msg" role="alert">{state.errors.aiKey[0]}</span>}
      </div>
    </>
  );
}

function NotifierFields({
  state,
  updateDraft,
  setDraftField,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setDraftField: (field: keyof OnboardingDraft, value: unknown) => void;
}) {
  return (
    <>
      <div className="field-group">
        <label>{copy('Notification channel', 'Canal de notificaciones')}</label>
        <div className="notifier-options">
          <button
            type="button"
            className={`notifier-option ${state.draft.notifier === 'markdown' ? 'is-selected' : ''}`}
            onClick={() => setDraftField('notifier', 'markdown')}
          >
            <div className="notifier-option-icon">📄</div>
            <div className="notifier-option-info">
              <p className="notifier-option-name">{copy('Dashboard only', 'Solo panel web')}</p>
              <p className="notifier-option-desc">{copy('Reports are saved and visible in this dashboard.', 'Los informes se guardan y son visibles desde este panel.')}</p>
            </div>
          </button>
          <button
            type="button"
            className={`notifier-option ${state.draft.notifier === 'telegram' ? 'is-selected' : ''}`}
            onClick={() => setDraftField('notifier', 'telegram')}
          >
            <div className="notifier-option-icon">✈️</div>
            <div className="notifier-option-info">
              <p className="notifier-option-name">Telegram</p>
              <p className="notifier-option-desc">{copy('Receive the summary in Telegram as well as the dashboard.', 'Recibe el resumen por Telegram además del panel.')}</p>
            </div>
          </button>
        </div>
      </div>

      {state.draft.notifier === 'telegram' && (
        <>
          <div className="field-group">
            <label htmlFor="telegramBotToken">{copy('Telegram bot token', 'Token del bot de Telegram')}</label>
            <div className="field-input-wrap">
              <span className="field-input-icon" aria-hidden="true">🤖</span>
              <input
                id="telegramBotToken"
                type="password"
                name="telegramBotToken"
                autoComplete="off"
                value={state.draft.telegramBotToken}
                onChange={updateDraft('telegramBotToken')}
                placeholder="123456:ABC-DEF…"
                style={{ paddingLeft: '2.75rem' }}
              />
            </div>
            {state.errors.telegramBotToken && <span className="field-error-msg" role="alert">{state.errors.telegramBotToken[0]}</span>}
          </div>

          <div className="field-group">
            <label htmlFor="telegramChatId">{copy('Telegram chat ID', 'ID del chat de Telegram')}</label>
            <div className="field-input-wrap">
              <span className="field-input-icon" aria-hidden="true">#</span>
              <input
                id="telegramChatId"
                name="telegramChatId"
                inputMode="numeric"
                autoComplete="off"
                value={state.draft.telegramChatId}
                onChange={updateDraft('telegramChatId')}
                placeholder="-100123456789"
                style={{ paddingLeft: '2.75rem' }}
              />
            </div>
            {state.errors.telegramChatId && <span className="field-error-msg" role="alert">{state.errors.telegramChatId[0]}</span>}
          </div>
        </>
      )}
    </>
  );
}

function ScheduleFields({
  state,
  updateDraft,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
}) {
  return (
    <>
      <div className="field-group">
        <label htmlFor="dailyTime">{copy('Daily report time', 'Hora del informe diario')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">🕗</span>
          <input
            id="dailyTime"
            type="time"
            name="dailyTime"
            required
            value={state.draft.dailyTime}
            onChange={updateDraft('dailyTime')}
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.dailyTime && <span className="field-error-msg" role="alert">{state.errors.dailyTime[0]}</span>}
      </div>

      <div className="field-group">
        <label htmlFor="timezone">{copy('Timezone', 'Zona horaria')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">🌍</span>
          <input
            id="timezone"
            name="timezone"
            required
            value={state.draft.timezone}
            onChange={updateDraft('timezone')}
            placeholder="Europe/Madrid"
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.timezone && <span className="field-error-msg" role="alert">{state.errors.timezone[0]}</span>}
      </div>
    </>
  );
}

function PrivacyFields({
  state,
  updateDraft,
  setDraftField,
}: {
  state: OnboardingState;
  updateDraft: (field: keyof OnboardingDraft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  setDraftField: (field: keyof OnboardingDraft, value: unknown) => void;
}) {
  const privacyOptions: { value: PrivacyLevel; name: string; desc: string; dot: string }[] = [
    { value: 'minimal', name: copy('Minimal', 'Mínima'), desc: copy('Only counts and entity types. No names or values.', 'Solo conteos y tipos de entidades. Sin nombres ni valores.'), dot: 'privacy-dot--minimal' },
    { value: 'balanced', name: copy('Balanced', 'Equilibrada'), desc: copy('Entity types and failure patterns, without personal data.', 'Tipos de entidades y patrones de fallo, sin datos personales.'), dot: 'privacy-dot--balanced' },
    { value: 'detailed', name: copy('Detailed', 'Detallada'), desc: copy('Full context including entity names and values.', 'Contexto completo incluyendo nombres de entidades y valores.'), dot: 'privacy-dot--detailed' },
  ];

  return (
    <>
      <div className="field-group">
        <label>{copy('Privacy level', 'Nivel de privacidad')}</label>
        <div className="privacy-options">
          {privacyOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`privacy-option ${state.draft.privacyLevel === opt.value ? 'is-selected' : ''}`}
              onClick={() => setDraftField('privacyLevel', opt.value)}
            >
              <div className={`privacy-dot ${opt.dot}`} aria-hidden="true" />
              <span className="privacy-option-name">{opt.name}</span>
              <span className="privacy-option-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
        {state.errors.privacyLevel && <span className="field-error-msg" role="alert">{state.errors.privacyLevel[0]}</span>}
      </div>

      <div className="field-group">
        <label htmlFor="retentionDays">{copy('Report retention days', 'Días de retención de informes')}</label>
        <div className="field-input-wrap">
          <span className="field-input-icon" aria-hidden="true">📅</span>
          <input
            id="retentionDays"
            type="number"
            name="retentionDays"
            inputMode="numeric"
            required
            value={state.draft.retentionDays}
            onChange={updateDraft('retentionDays')}
            placeholder="90"
            min="1"
            max={MAX_RETENTION_DAYS}
            style={{ paddingLeft: '2.75rem' }}
          />
        </div>
        {state.errors.retentionDays && <span className="field-error-msg" role="alert">{state.errors.retentionDays[0]}</span>}
      </div>

      <label className="consent-checkbox">
        <input
          type="checkbox"
          name="privacyAccepted"
          checked={state.draft.privacyAccepted ?? false}
          onChange={updateDraft('privacyAccepted')}
        />
        <span className="consent-checkbox-label">
          {t('onboarding.fields.privacyAccepted')}
        </span>
      </label>
      {state.errors.privacyAccepted && <span className="field-error-msg" role="alert">{state.errors.privacyAccepted[0]}</span>}
    </>
  );
}

/* ── Complete screen ─────────────────────────────────────── */

function CompleteScreen({ job, onContinue }: { job?: RunDigestResponse; onContinue?: () => void }) {
  return (
    <div className="onboarding-complete onboarding-step-content">
      <div className="onboarding-complete-icon" aria-hidden="true">✓</div>
      <p className="onboarding-eyebrow">{copy('Ready', 'Todo listo')}</p>
      <h1 className="onboarding-step-title" id="step-title">{copy('Settings saved', 'Configuración guardada')}</h1>
      <p className="onboarding-step-desc">
        {job
          ? copy('Your first report is queued. Open the dashboard to follow its progress.', 'Tu primer informe está en cola. Abre el panel para seguir su progreso.')
          : copy('Your settings are saved. You can open the dashboard now.', 'La configuración está guardada. Ya puedes abrir el panel.')}
      </p>
      <div className="onboarding-actions">
        <button type="button" className="btn-primary" onClick={onContinue}>
          {copy('Open dashboard →', 'Ir al panel →')}
        </button>
      </div>
    </div>
  );
}

/* ── Pure logic helpers (unchanged from original) ─────── */

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
  if (step === 'schedule' || step === 'schedulePrivacy') {
    if (!HH_MM_24_HOUR_PATTERN.test(draft.dailyTime)) errors.dailyTime = [t('onboarding.errors.dailyTime')];
    if (!draft.timezone.trim()) errors.timezone = [t('onboarding.errors.timezone')];
  }
  if (step === 'privacy' || step === 'schedulePrivacy') {
    if (draft.privacyAccepted === false) errors.privacyAccepted = [t('onboarding.errors.privacyAccepted')];
    const retentionDays = Number(draft.retentionDays);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
      errors.retentionDays = [t('onboarding.errors.retentionDays')];
    }
  }
  return errors;
}

async function persistSettingsAndQueueDigest(
  state: OnboardingState,
  api: OnboardingApi,
  progress: OnboardingSetupProgress,
): Promise<OnboardingState> {
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
      firstDigestJob,
    };
  } catch (error) {
    const fieldErrors = error instanceof ApiClientError ? redactErrors(error.fieldErrors, state.draft) : undefined;
    return {
      ...state,
      draft: scrubSecrets(state.draft),
      status: 'failed',
      step: stepForField(Object.keys(fieldErrors ?? {})[0] ?? ''),
      errors: fieldErrors ?? { form: [redactSensitiveText(error instanceof Error ? error.message : copy('Could not complete onboarding.', 'No se pudo completar la configuración.'))] },
      maskedSettings: nextProgress.maskedSettings,
      setupProgress: nextProgress,
      firstDigestJob: undefined,
    };
  }
}

function hasSettingsPersistenceApi(api: OnboardingApi): api is OnboardingApi {
  return typeof api.getSettings === 'function' && typeof api.updateSettings === 'function';
}

function stepForField(field: string): OnboardingStep {
  if (field.startsWith('ha')) return 'homeAssistant';
  if (field.startsWith('ai')) return 'aiProvider';
  if (field.startsWith('telegram')) return 'notifier';
  if (field === 'dailyTime' || field === 'timezone') return 'schedule';
  if (field === 'privacyLevel' || field === 'retentionDays' || field === 'privacyAccepted') return 'privacy';
  return 'firstDigest';
}

function toSetupRequest(draft: OnboardingDraft): SetupValidationRequest {
  return { haUrl: draft.haUrl, haToken: draft.haToken, aiProvider: draft.aiProvider, aiKey: draft.aiKey, ...(draft.notifier === 'telegram' ? { telegram: { botToken: draft.telegramBotToken, chatId: draft.telegramChatId } } : {}) };
}

function toSettingsUpdate(currentSettings: EditableSettingsDto, draft: OnboardingDraft): SettingsUpdateCommand {
  return {
    homeAssistant: { url: currentSettings.homeAssistant.url, token: { operation: 'keep_current' } },
    ai: { provider: currentSettings.ai.provider, key: { operation: 'keep_current' } },
    notifications: currentSettings.notifications.channel === 'telegram'
      ? { channel: 'telegram', chatId: currentSettings.notifications.chatId, botToken: { operation: 'keep_current' } }
      : { channel: 'none' },
    schedules: [{ kind: 'daily', enabled: true, time: draft.dailyTime, timezone: draft.timezone }],
    privacyLevel: draft.privacyLevel,
    retentionDays: Number(draft.retentionDays),
  };
}

function createFirstDigestWindow(now = new Date()): DigestWindowDto {
  return {
    to: now.toISOString(),
    from: new Date(now.getTime() - FIRST_DIGEST_WINDOW_MS).toISOString(),
  };
}

function scrubSecrets(draft: OnboardingDraft): OnboardingDraft {
  return { ...draft, haToken: '', aiKey: '', telegramBotToken: '' };
}

function redactErrors(
  fieldErrors: Record<string, string[]> | undefined,
  draft: OnboardingDraft,
): Record<string, string[]> | undefined {
  if (!fieldErrors) return undefined;
  const secrets = [draft.haToken, draft.aiKey, draft.telegramBotToken].filter(Boolean);
  return Object.fromEntries(
    Object.entries(fieldErrors).map(([field, messages]) => [
      field,
      messages.map((message) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[redacted]'), redactSensitiveText(message))),
    ]),
  );
}
