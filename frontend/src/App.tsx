import './styles.css';
import { createApiClient } from './api-client.js';
import { ControlsPanel, type ControlsApi } from './controls-panel.js';
import { DashboardHistory, type DashboardApi } from './dashboard.js';
import { t } from './i18n/index.js';
import { OnboardingFlow, createInitialOnboardingState, type OnboardingApi } from './onboarding.js';

type BootstrapConfig = {
  setupToken?: string;
};

declare global {
  var __HA_DIGEST_BOOTSTRAP__: BootstrapConfig | undefined;
}

type AppApi = Partial<OnboardingApi & DashboardApi & ControlsApi>;

export function App({ api }: { api?: AppApi } = {}) {
  const setupToken = resolveSetupToken();
  const candidateApi = api ?? (setupToken ? createApiClient({ setupToken }) : undefined);
  const onboardingApi = hasOnboardingApi(candidateApi) ? candidateApi : undefined;
  const dashboardApi = hasDashboardApi(candidateApi) ? candidateApi : undefined;
  const controlsApi = hasControlsApi(candidateApi) ? candidateApi : undefined;

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
        <article className="panel action-panel">
          <p className="eyebrow">{t('dashboard.manualDigest.eyebrow')}</p>
          <h2>{t('dashboard.manualDigest.title')}</h2>
          <p>{t('dashboard.manualDigest.copy')}</p>
          <button type="button" disabled>{t('dashboard.manualDigest.action')}</button>
        </article>

        <DashboardHistory api={dashboardApi} />

        <ControlsPanel api={controlsApi} />
      </section>
    </main>
  );
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
