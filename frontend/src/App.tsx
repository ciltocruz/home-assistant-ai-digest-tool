import './styles.css';
import { useState } from 'react';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { createApiClient } from './api-client.js';
import { ControlsPanel, type ControlsApi } from './controls-panel.js';
import { DashboardHistory, type DashboardApi } from './dashboard.js';
import { t } from './i18n/index.js';
import { OnboardingFlow, createInitialOnboardingState, type OnboardingApi } from './onboarding.js';
import type { RunDigestRequest, RunDigestResponse } from '@ha-digest/shared';

type BootstrapConfig = {
  setupToken?: string;
};

declare global {
  var __HA_DIGEST_BOOTSTRAP__: BootstrapConfig | undefined;
}

type AppApi = Partial<OnboardingApi & DashboardApi & ControlsApi>;

type ManualDigestApi = {
  runDigest(input: RunDigestRequest): Promise<RunDigestResponse>;
};

export function App({ api }: { api?: AppApi } = {}) {
  const setupToken = resolveSetupToken();
  const candidateApi = api ?? (setupToken ? createApiClient({ setupToken }) : undefined);
  const onboardingApi = hasOnboardingApi(candidateApi) ? candidateApi : undefined;
  const dashboardApi = hasDashboardApi(candidateApi) ? candidateApi : undefined;
  const controlsApi = hasControlsApi(candidateApi) ? candidateApi : undefined;
  const manualDigestApi = hasManualDigestApi(candidateApi) ? candidateApi : undefined;

  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="product-title">
        <p className="eyebrow">{t('hero.eyebrow')}</p>
        <h1 id="product-title">{t('hero.title')}</h1>
        <p className="hero-copy">{t('hero.copy')}</p>
        <div className="privacy-card">{t('hero.privacy')}</div>
      </section>

      {!onboardingApi ? <section className="panel" role="alert">{t('onboarding.missingSetupToken')}</section> : null}
      <OnboardingFlow state={createInitialOnboardingState()} api={onboardingApi} />

      <section className="dashboard-grid" aria-label={t('dashboard.ariaLabel')}>
        <ManualDigestCard api={manualDigestApi} />

        <DashboardHistory api={dashboardApi} />

        <ControlsPanel api={controlsApi} />
      </section>
    </main>
  );
}

function ManualDigestCard({ api }: { api?: ManualDigestApi }) {
  const [state, setState] = useState<{ status: 'idle' | 'pending' | 'queued' | 'error'; message?: string }>({ status: 'idle' });

  async function queueManualDigest() {
    if (!api || state.status === 'pending') return;
    setState({ status: 'pending' });
    try {
      await api.runDigest({ kind: 'manual' });
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
  return typeof api?.validateSetup === 'function'
    && typeof api.getSettings === 'function'
    && typeof api.updateSettings === 'function'
    && typeof api.runDigest === 'function';
}

function hasManualDigestApi(api: AppApi | undefined): api is AppApi & ManualDigestApi {
  return typeof api?.runDigest === 'function';
}

function hasControlsApi(api: AppApi | undefined): api is AppApi & ControlsApi {
  return typeof api?.getSettings === 'function'
    && typeof api.updateSettings === 'function'
    && typeof api.listNotes === 'function'
    && typeof api.addNote === 'function'
    && typeof api.listIgnores === 'function'
    && typeof api.addIgnore === 'function'
    && typeof api.removeIgnore === 'function'
    && typeof api.testNotifier === 'function';
}

export function resolveSetupToken(): string {
  const globalToken = globalThis.__HA_DIGEST_BOOTSTRAP__?.setupToken?.trim();
  if (globalToken) return globalToken;

  const metaToken = typeof document === 'undefined'
    ? ''
    : document.querySelector<HTMLMetaElement>('meta[name="ha-digest-setup-token"]')?.content.trim();
  if (metaToken) return metaToken;

  return '';
}
