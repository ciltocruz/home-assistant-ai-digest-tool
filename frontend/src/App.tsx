import './styles.css';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { createApiClient } from './api-client.js';
import { Dashboard, DashboardHistory, type DashboardApi } from './dashboard.js';
import { ExperienceShell } from './experience-shell.js';
import { setLocale, t } from './i18n/index.js';
import { JobLifecycle, rememberActiveJob, restoreActiveJobIds, type JobLifecycleApi } from './job-lifecycle.js';
import { OnboardingFlow, createInitialOnboardingState, restoreOnboardingState, type OnboardingApi, type OnboardingState } from './onboarding.js';
import { ReportDetail } from './report-detail.js';
import type { AppRoute } from './router.js';
import { SettingsPanel, type SettingsApi } from './settings.js';
import type { DigestDetail, RunDigestRequest, RunDigestResponse } from '@ha-digest/shared';

type AppApi = Partial<OnboardingApi & DashboardApi & JobLifecycleApi & { getDigest(id: string): Promise<DigestDetail> }>;
type SessionApi = { getSession(): Promise<{ language: 'en' | 'es' }>; getAuthStatus(): Promise<{ hasAdmin: boolean }>; register(password: string, language: 'en' | 'es'): Promise<{ language: 'en' | 'es' }>; login(password: string): Promise<{ language: 'en' | 'es' }> };

type ManualDigestApi = {
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
};

export function App({ api }: { api?: AppApi } = {}) {
  const [candidateApi] = useState<(AppApi & Partial<SessionApi>) | undefined>(() => api ?? createApiClient());
  const [onboardingState] = useState<OnboardingState>(createInitialOnboardingState);
  const [sessionReady, setSessionReady] = useState(() => Boolean(api));
  const [authState, setAuthState] = useState<'loading' | 'register' | 'login' | 'ready'>(() => api ? 'ready' : 'loading');
  const [activeJobIds, setActiveJobIds] = useState(restoreActiveJobIds);
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => {
    if (api || !candidateApi || typeof candidateApi.getSession !== 'function' || typeof candidateApi.getAuthStatus !== 'function') return;
    void candidateApi.getAuthStatus!().then(({ hasAdmin }) => candidateApi.getSession!()
      .then((session) => { setLocale(session.language); setSessionReady(true); setAuthState('ready'); })
      .catch(() => setAuthState(hasAdmin ? 'login' : 'register'))).catch(() => setAuthState('login'));
  }, [api, candidateApi]);
  if (authState !== 'ready') return <AccountScreen mode={authState} api={candidateApi} onAuthenticated={() => { setSessionReady(true); setAuthState('ready'); }} />;
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
    renderRoute={(route) => <OperationalRoute route={route} api={candidateApi} settingsApi={settingsApi} dashboardApi={dashboardApi} manualDigestApi={manualDigestApi} jobLifecycleApi={jobLifecycleApi} activeJobIds={activeJobIds} historyRevision={historyRevision} onQueued={(jobId) => setActiveJobIds(rememberActiveJob(jobId))} onCompleted={() => setHistoryRevision((revision) => revision + 1)} />}
  />;
}

function OperationalRoute({ route, api, settingsApi, dashboardApi, manualDigestApi, jobLifecycleApi, activeJobIds, historyRevision, onQueued, onCompleted }: { route: Exclude<AppRoute, { kind: 'setup' }>; api?: AppApi; settingsApi?: SettingsApi; dashboardApi?: DashboardApi; manualDigestApi?: ManualDigestApi; jobLifecycleApi?: JobLifecycleApi; activeJobIds: string[]; historyRevision: number; onQueued(jobId: string): void; onCompleted(): void }) {
  if (route.kind === 'report') return <ReportsWorkspace api={api} reportId={route.reportId} refreshKey={historyRevision} />;
  if (route.kind === 'settings') return <SettingsPanel api={settingsApi} section={route.section} />;
  if (route.kind === 'reports') return <ReportsWorkspace api={api} refreshKey={historyRevision} />;

  return <Dashboard
    api={dashboardApi}
    refreshKey={historyRevision}
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

function ReportsWorkspace({ api, reportId, refreshKey }: { api?: AppApi; reportId?: string; refreshKey: number }) {
  const dashboardApi = hasDashboardApi(api) ? api : undefined;
  return <section className="reports-workspace" aria-label={t('shell.reports')}>
    <DashboardHistory api={dashboardApi} refreshKey={refreshKey} />
    {reportId ? <ReportRoute api={api} reportId={reportId} /> : null}
  </section>;
}

function ReportRoute({ api, reportId }: { api?: { getDigest?(id: string): Promise<DigestDetail> }; reportId: string }) {
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
  return <ReportDetail report={state.report} embedded />;
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

function AccountScreen({ mode, api, onAuthenticated }: { mode: 'loading' | 'register' | 'login'; api?: Partial<SessionApi>; onAuthenticated(): void }) {
  const [password, setPassword] = useState('');
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [error, setError] = useState('');
  if (mode === 'loading') return <main className="onboarding-root"><p>Checking secure access…</p></main>;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
       const session = mode === 'register' ? await api?.register?.(password, language) : await api?.login?.(password);
       if (session) setLocale(session.language);
      onAuthenticated();
    } catch (reason) { setError(reason instanceof Error ? redactSensitiveText(reason.message) : 'Sign-in failed.'); }
  }
  return <main className="onboarding-root" id="onboarding-flow"><form className="onboarding-step-content" onSubmit={(event) => void submit(event)}>
    <p className="onboarding-eyebrow">{mode === 'register' ? 'First run' : 'Welcome back'}</p><h1>{mode === 'register' ? 'Create your administrator account' : 'Sign in'}</h1>
    {mode === 'register' ? <label>Language<select value={language} onChange={(event) => setLanguage(event.currentTarget.value as 'en' | 'es')}><option value="en">English</option><option value="es">Español</option></select></label> : null}
    <label>Password<input aria-label="Password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={12} required value={password} onChange={(event) => setPassword(event.currentTarget.value)} /></label>
    <button type="submit">{mode === 'register' ? 'Create account' : 'Sign in'}</button>{error ? <p role="alert">{error}</p> : null}
  </form></main>;
}
