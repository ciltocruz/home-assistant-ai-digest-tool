import './styles.css';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { createApiClient } from './api-client.js';
import { Dashboard, DashboardHistory, type DashboardApi } from './dashboard.js';
import { ExperienceShell } from './experience-shell.js';
import { currentLocale, hydrateLocale, setLocale, t } from './i18n/index.js';
import { JobLifecycle, rememberActiveJob, restoreActiveJobIds, type JobLifecycleApi } from './job-lifecycle.js';
import { OnboardingFlow, createInitialOnboardingState, restoreOnboardingState, type OnboardingApi, type OnboardingState } from './onboarding.js';
import { ReportDetail } from './report-detail.js';
import type { AppRoute } from './router.js';
import { SettingsPanel, type SettingsApi } from './settings.js';
import type { DigestDetail, EditableSettingsDto, RunDigestRequest, RunDigestResponse } from '@ha-digest/shared';

type AppApi = Partial<OnboardingApi & DashboardApi & JobLifecycleApi & { getDigest(id: string): Promise<DigestDetail>; deleteDigest(id: string): Promise<void> }>;
type TimeZoneApi = Pick<SettingsApi, 'getSettings'>;
type SessionApi = { getSession(): Promise<{ language: 'en' | 'es' }>; getAuthStatus(): Promise<{ hasAdmin: boolean }>; register(password: string, language: 'en' | 'es'): Promise<{ language: 'en' | 'es' }>; login(password: string): Promise<{ language: 'en' | 'es' }> };

type ManualDigestApi = {
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
};

export function App({ api }: { api?: AppApi } = {}) {
  useState(() => hydrateLocale());
  const [candidateApi] = useState<(AppApi & Partial<SessionApi>) | undefined>(() => api ?? createApiClient());
  const [onboardingState] = useState<OnboardingState>(createInitialOnboardingState);
  const [sessionReady, setSessionReady] = useState(() => Boolean(api));
  const [authState, setAuthState] = useState<'loading' | 'register' | 'login' | 'error' | 'ready'>(() => api ? 'ready' : 'loading');
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [activeJobIds, setActiveJobIds] = useState(restoreActiveJobIds);
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => {
    if (api || !candidateApi || typeof candidateApi.getSession !== 'function' || typeof candidateApi.getAuthStatus !== 'function') return;
    void candidateApi.getAuthStatus!().then(({ hasAdmin }) => candidateApi.getSession!()
      .then((session) => { setLocale(session.language); setSessionReady(true); setAuthState('ready'); })
      .catch((error) => setAuthState(isUnauthenticated(error) ? (hasAdmin ? 'login' : 'register') : 'error')))
      .catch((error) => setAuthState(isUnauthenticated(error) ? 'login' : 'error'));
  }, [api, candidateApi, bootstrapAttempt]);
  if (authState !== 'ready') return <AccountScreen mode={authState} api={candidateApi} onAuthenticated={() => { setSessionReady(true); setAuthState('ready'); }} onRetry={() => { setAuthState('loading'); setBootstrapAttempt((attempt) => attempt + 1); }} />;
  const onboardingApi = hasOnboardingApi(candidateApi) ? candidateApi : undefined;
  const dashboardApi = sessionReady && hasDashboardApi(candidateApi) ? candidateApi : undefined;
  const manualDigestApi = sessionReady && hasManualDigestApi(candidateApi) ? candidateApi : undefined;
  const settingsApi = sessionReady && hasSettingsApi(candidateApi) ? candidateApi : undefined;
  const jobLifecycleApi = sessionReady && hasJobLifecycleApi(candidateApi) ? candidateApi : undefined;
  return <ExperienceShell
    api={candidateApi}
    renderSetup={(progress, complete) => {
      const restored = progress ? restoreOnboardingState(progress) : onboardingState;
      return <OnboardingFlow key={restored.step} state={restored} api={onboardingApi} onSessionCreated={() => setSessionReady(true)} onCompleted={complete} />;
    }}
    renderRoute={(route) => <OperationalRoute route={route} api={candidateApi} settingsApi={settingsApi} timeZoneApi={sessionReady && hasTimeZoneApi(candidateApi) ? candidateApi : undefined} dashboardApi={dashboardApi} manualDigestApi={manualDigestApi} jobLifecycleApi={jobLifecycleApi} activeJobIds={activeJobIds} historyRevision={historyRevision} onQueued={(jobId) => setActiveJobIds(rememberActiveJob(jobId))} onCompleted={() => setHistoryRevision((revision) => revision + 1)} />}
  />;
}

function OperationalRoute({ route, api, settingsApi, timeZoneApi, dashboardApi, manualDigestApi, jobLifecycleApi, activeJobIds, historyRevision, onQueued, onCompleted }: { route: Exclude<AppRoute, { kind: 'setup' }>; api?: AppApi; settingsApi?: SettingsApi; timeZoneApi?: TimeZoneApi; dashboardApi?: DashboardApi; manualDigestApi?: ManualDigestApi; jobLifecycleApi?: JobLifecycleApi; activeJobIds: string[]; historyRevision: number; onQueued(jobId: string): void; onCompleted(): void }) {
  const [timeZone, setTimeZone] = useState<string>();
  useEffect(() => {
    if (!timeZoneApi) return;
    let active = true;
    void timeZoneApi.getSettings().then((settings: EditableSettingsDto) => {
      if (active) setTimeZone(settings.schedules[0]?.timezone);
    }).catch(() => {
      if (active) setTimeZone(undefined);
    });
    return () => { active = false; };
  }, [timeZoneApi]);

  if (route.kind === 'report') return <ReportsWorkspace api={api} reportId={route.reportId} refreshKey={historyRevision} onChanged={onCompleted} timeZone={timeZone} />;
  if (route.kind === 'settings') return <SettingsPanel api={settingsApi} section={route.section} />;
  if (route.kind === 'reports') return <ReportsWorkspace api={api} refreshKey={historyRevision} onChanged={onCompleted} timeZone={timeZone} />;

  return <Dashboard
    api={dashboardApi}
    refreshKey={historyRevision}
    timeZone={timeZone}
    activeReport={<ActiveReport manualDigestApi={manualDigestApi} jobLifecycleApi={jobLifecycleApi} activeJobIds={activeJobIds} onQueued={onQueued} onCompleted={onCompleted} />}
  />;
}

function ActiveReport({ manualDigestApi, jobLifecycleApi, activeJobIds, onQueued, onCompleted }: {
  manualDigestApi?: ManualDigestApi;
  jobLifecycleApi?: JobLifecycleApi;
  activeJobIds: string[];
  onQueued(jobId: string): void;
  onCompleted(): void;
}) {
  if (activeJobIds.length > 0) return <JobLifecycle api={jobLifecycleApi} jobIds={activeJobIds} onCompleted={onCompleted} />;
  return <ManualDigestCard api={manualDigestApi} onQueued={onQueued} />;
}

function ReportsWorkspace({ api, reportId, refreshKey, onChanged, timeZone }: { api?: AppApi; reportId?: string; refreshKey: number; onChanged(): void; timeZone?: string }) {
  const dashboardApi = hasDashboardApi(api) ? api : undefined;
  return <section className={`reports-workspace${reportId ? ' reports-workspace--selected' : ' reports-workspace--list'}`} aria-label={t('shell.reports')}>
    {reportId ? <ReportRoute api={api} reportId={reportId} timeZone={timeZone} onDeleted={() => { onChanged(); window.history.pushState({}, '', '/reports'); window.dispatchEvent(new PopStateEvent('popstate')); }} /> : null}
    <DashboardHistory api={dashboardApi} refreshKey={refreshKey} headingLevel={reportId ? 'h2' : 'h1'} timeZone={timeZone} />
  </section>;
}

function ReportRoute({ api, reportId, onDeleted, timeZone }: { api?: { getDigest?(id: string): Promise<DigestDetail>; deleteDigest?(id: string): Promise<void> }; reportId: string; onDeleted(): void; timeZone?: string }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; report: DigestDetail } | { status: 'error' }>({ status: 'loading' });
  useEffect(() => {
    if (!api?.getDigest) {
      setState({ status: 'error' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    void api.getDigest(reportId).then((report) => { if (active) setState({ status: 'ready', report }); }).catch(() => { if (active) setState({ status: 'error' }); });
    return () => { active = false; };
  }, [api, reportId]);

  if (state.status === 'loading') return <section className="panel report-detail" aria-live="polite"><h2>{t('report.loadingTitle')}</h2><p>{t('report.loadingCopy')}</p></section>;
  if (state.status === 'error') return <section className="panel report-detail" role="alert"><h2>{t('report.errorTitle')}</h2><p>{t('report.errorCopy')}</p><a className="report-link" href="/reports">{t('report.back')}</a></section>;
  return <ReportDetail report={state.report} timeZone={timeZone} onDelete={api?.deleteDigest ? async () => { await api.deleteDigest!(reportId); onDeleted(); } : undefined} />;
}

function ManualDigestCard({ api, onQueued }: { api?: ManualDigestApi; onQueued(jobId: string): void }) {
  const [state, setState] = useState<{ status: 'idle' | 'pending' | 'queued' | 'error'; message?: string }>({ status: 'idle' });

  async function queueManualDigest() {
    if (!api || state.status === 'pending') return;
    setState({ status: 'pending' });
    try {
      const result = await api.runDigest({ kind: 'manual' });
      onQueued(result.jobId);
      setState({ status: 'queued', message: t('dashboard.manualDigest.queued') });
    } catch (error) {
      const detail = error instanceof ApiClientError || error instanceof Error ? redactSensitiveText(error.message) : '';
      setState({ status: 'error', message: detail ? `${t('dashboard.manualDigest.error')} ${detail}` : t('dashboard.manualDigest.error') });
    }
  }

  const buttonLabel = !api
    ? t('dashboard.manualDigest.unavailableAction')
    : state.status === 'pending'
      ? t('dashboard.manualDigest.pendingAction')
      : t('dashboard.manualDigest.action');

  return <article className="panel action-panel">
    <p className="eyebrow">{t('dashboard.manualDigest.eyebrow')}</p>
    <h2>{t('dashboard.manualDigest.title')}</h2>
    <p>{api ? t('dashboard.manualDigest.copy') : t('dashboard.manualDigest.unavailableCopy')}</p>
    <button type="button" disabled={!api || state.status === 'pending'} onClick={() => void queueManualDigest()}>{buttonLabel}</button>
    {state.message ? <p className={state.status === 'error' ? 'error-copy' : 'muted-copy'}>{state.message}</p> : null}
  </article>;
}

function hasDashboardApi(api: AppApi | undefined): api is AppApi & DashboardApi {
  return typeof api?.listHistory === 'function';
}

function hasOnboardingApi(api: AppApi | undefined): api is AppApi & OnboardingApi {
  return typeof api?.getOnboarding === 'function'
    && typeof api.saveOnboarding === 'function'
    && typeof api.completeOnboarding === 'function'
    && typeof api.getSettings === 'function'
    && typeof api.updateSettings === 'function'
    && typeof api.runDigest === 'function';
}

function hasManualDigestApi(api: AppApi | undefined): api is AppApi & ManualDigestApi {
  return typeof api?.runDigest === 'function';
}

function hasJobLifecycleApi(api: AppApi | undefined): api is AppApi & JobLifecycleApi {
  return typeof api?.getDigestJob === 'function' && typeof api?.retryDigestJob === 'function';
}

function hasSettingsApi(api: AppApi | undefined): api is AppApi & SettingsApi {
  return typeof api?.getSettings === 'function' && typeof api.updateSettings === 'function';
}

function hasTimeZoneApi(api: AppApi | undefined): api is AppApi & TimeZoneApi {
  return typeof api?.getSettings === 'function';
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'UNAUTHENTICATED';
}

function AccountScreen({ mode, api, onAuthenticated, onRetry }: { mode: 'loading' | 'register' | 'login' | 'error'; api?: Partial<SessionApi>; onAuthenticated(): void; onRetry(): void }) {
  const [password, setPassword] = useState('');
  const [language, setLanguage] = useState<'en' | 'es'>(() => currentLocale());
  const [error, setError] = useState('');
  if (mode === 'loading') return <main className="onboarding-root"><p>{t('account.loading')}</p></main>;
  if (mode === 'error') return <main className="onboarding-root" id="onboarding-flow"><section className="onboarding-step-content" role="alert"><p className="onboarding-eyebrow">{t('account.securityCheck')}</p><h1>{t('account.bootstrapErrorTitle')}</h1><p>{t('account.bootstrapErrorCopy')}</p><button type="button" onClick={onRetry}>{t('account.retry')}</button></section></main>;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
       const session = mode === 'register' ? await api?.register?.(password, language) : await api?.login?.(password);
       if (session) setLocale(session.language);
      onAuthenticated();
     } catch (reason) { setError(reason instanceof Error ? redactSensitiveText(reason.message) : t('account.signInFailed')); }
  }
  return <main className="onboarding-root" id="onboarding-flow"><form className="onboarding-step-content" onSubmit={(event) => void submit(event)}>
     <p className="onboarding-eyebrow">{mode === 'register' ? t('account.firstRun') : t('account.welcomeBack')}</p><h1>{mode === 'register' ? t('account.createTitle') : t('account.signInTitle')}</h1>
     {mode === 'register' ? <label>{t('account.language')}<select value={language} onChange={(event) => { const next = event.currentTarget.value as 'en' | 'es'; setLanguage(next); setLocale(next); }}><option value="en">{t('account.english')}</option><option value="es">{t('account.spanish')}</option></select></label> : null}
     <label>{t('account.password')}<input aria-label={t('account.password')} type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.currentTarget.value)} /></label>
     <button type="submit">{mode === 'register' ? t('account.createAction') : t('account.signInAction')}</button>{error ? <p role="alert">{error}</p> : null}
  </form></main>;
}
