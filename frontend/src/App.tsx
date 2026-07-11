import './styles.css';
import { createApiClient } from './api-client.js';
import { t } from './i18n/index.js';
import { OnboardingFlow, createInitialOnboardingState, type OnboardingApi } from './onboarding.js';

type BootstrapConfig = {
  setupToken?: string;
};

declare global {
  var __HA_DIGEST_BOOTSTRAP__: BootstrapConfig | undefined;
}

export function App({ api }: { api?: OnboardingApi } = {}) {
  const setupToken = resolveSetupToken();
  const onboardingApi = api ?? (setupToken ? createApiClient({ setupToken }) : undefined);

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

        <article className="panel">
          <p className="eyebrow">{t('dashboard.history.eyebrow')}</p>
          <h2>{t('dashboard.history.title')}</h2>
          <p>{t('dashboard.history.copy')}</p>
        </article>

        <article className="panel">
          <p className="eyebrow">{t('dashboard.notes.eyebrow')}</p>
          <h2>{t('dashboard.notes.title')}</h2>
          <p>{t('dashboard.notes.copy')}</p>
        </article>

        <article className="panel">
          <p className="eyebrow">{t('dashboard.ignoredWarnings.eyebrow')}</p>
          <h2>{t('dashboard.ignoredWarnings.title')}</h2>
          <p>{t('dashboard.ignoredWarnings.copy')}</p>
        </article>

        <article className="panel">
          <p className="eyebrow">{t('dashboard.telegramTest.eyebrow')}</p>
          <h2>{t('dashboard.telegramTest.title')}</h2>
          <p>{t('dashboard.telegramTest.copy')}</p>
          <button type="button" disabled>{t('dashboard.telegramTest.action')}</button>
        </article>

        <article className="panel">
          <p className="eyebrow">{t('dashboard.settings.eyebrow')}</p>
          <h2>{t('dashboard.settings.title')}</h2>
          <p>{t('dashboard.settings.copy')}</p>
        </article>
      </section>
    </main>
  );
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
