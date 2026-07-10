import './styles.css';
import { t } from './i18n/index.js';

const setupStepKeys = [
  'onboarding.steps.connectHomeAssistant',
  'onboarding.steps.chooseAiProvider',
  'onboarding.steps.setPrivacyLevel',
  'onboarding.steps.runFirstDigest',
] as const;

export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="product-title">
        <p className="eyebrow">{t('hero.eyebrow')}</p>
        <h1 id="product-title">{t('hero.title')}</h1>
        <p className="hero-copy">{t('hero.copy')}</p>
        <div className="privacy-card">{t('hero.privacy')}</div>
      </section>

      <section className="panel" aria-labelledby="onboarding-title">
        <div className="section-heading">
          <p className="eyebrow">{t('onboarding.eyebrow')}</p>
          <h2 id="onboarding-title">{t('onboarding.title')}</h2>
        </div>
        <ol className="setup-rail">
          {setupStepKeys.map((key) => <li key={key}>{t(key)}</li>)}
        </ol>
        <form className="setup-grid">
          <label>{t('onboarding.fields.homeAssistantUrl')}<input placeholder="http://homeassistant.local:8123" /></label>
          <label>{t('onboarding.fields.aiProvider')}<select defaultValue="gemini"><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
          <label>{t('onboarding.fields.notifier')}<select defaultValue="telegram"><option value="telegram">{t('onboarding.notifiers.telegram')}</option><option value="markdown">{t('onboarding.notifiers.markdown')}</option></select></label>
          <button type="button">{t('onboarding.actions.validateSetup')}</button>
        </form>
      </section>

      <section className="dashboard-grid" aria-label={t('dashboard.ariaLabel')}>
        <article className="panel action-panel">
          <p className="eyebrow">{t('dashboard.manualDigest.eyebrow')}</p>
          <h2>{t('dashboard.manualDigest.title')}</h2>
          <p>{t('dashboard.manualDigest.copy')}</p>
          <button type="button">{t('dashboard.manualDigest.action')}</button>
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
          <button type="button">{t('dashboard.telegramTest.action')}</button>
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
