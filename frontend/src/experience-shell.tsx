import { useEffect, useState, type ReactNode } from 'react';
import type { OnboardingProgress } from '@ha-digest/shared';
import { t } from './i18n/index.js';
import { canonicalPath, parseAppRoute, redirectForOnboarding, type AppRoute } from './router.js';

type OnboardingBootstrapApi = {
  getOnboarding?(): Promise<OnboardingProgress>;
};

type GateState =
  | { status: 'loading' }
  | { status: 'setup'; progress?: OnboardingProgress }
  | { status: 'operational' };

export function ExperienceShell({
  api,
  renderSetup,
  renderRoute,
}: {
  api?: OnboardingBootstrapApi;
  renderSetup: (progress: OnboardingProgress | undefined, complete: () => void) => ReactNode;
  renderRoute: (route: Exclude<AppRoute, { kind: 'setup' }>) => ReactNode;
}) {
  const [route, setRoute] = useState(readRoute);
  const [gate, setGate] = useState<GateState>(() =>
    api?.getOnboarding ? { status: 'loading' } : { status: 'setup' },
  );

  useEffect(() => {
    if (!api?.getOnboarding) return;
    let active = true;
    void api
      .getOnboarding()
      .then((progress) => {
        if (active)
          setGate(progress.completed ? { status: 'operational' } : { status: 'setup', progress });
      })
      .catch(() => {
        if (active) setGate({ status: 'setup' });
      });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    const updateRoute = () => setRoute(readRoute());
    window.addEventListener('popstate', updateRoute);
    return () => window.removeEventListener('popstate', updateRoute);
  }, []);

  useEffect(() => {
    if (gate.status === 'loading') return;
    const redirected = redirectForOnboarding(route, gate.status === 'operational');
    const target = canonicalPath(redirected);
    if (target === currentUrl()) return;
    window.history.replaceState({}, '', target);
    setRoute(redirected);
  }, [gate.status, route]);

  /* Loading */
  if (gate.status === 'loading') {
    return (
      <main
        className="onboarding-root"
        data-app-state="setup-loading"
        id="main-content"
        style={{ alignItems: 'center', justifyContent: 'center', display: 'flex' }}
      >
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div className="spinner" style={{ margin: '0 auto 1rem', width: 32, height: 32, borderWidth: 3 }} aria-hidden="true" />
          <p style={{ margin: 0 }}>{t('shell.loadingSetup')}</p>
        </div>
      </main>
    );
  }

  /* Setup / Onboarding */
  if (gate.status === 'setup') {
    return (
      <>
        <a className="skip-link" href="#onboarding-flow">{t('shell.skipToContent')}</a>
        {renderSetup(gate.progress, () => setGate({ status: 'operational' }))}
      </>
    );
  }

  /* Operational shell */
  const operationalRoute = redirectForOnboarding(route, true) as Exclude<AppRoute, { kind: 'setup' }>;
  return (
    <>
      <a className="skip-link" href="#main-content">{t('shell.skipToContent')}</a>
      <div className="app-root">
        <aside className="app-sidebar">
          <a className="app-sidebar-brand" href="/" aria-label={t('shell.homeLabel')}>
            <div className="app-sidebar-icon" aria-hidden="true">🏡</div>
            <div className="app-sidebar-name">
              HA AI Digest
              <span>{t('shell.brandSubtitle')}</span>
            </div>
          </a>

          <nav className="app-nav" aria-label={t('shell.navigationLabel')}>
            <a
              className="app-nav-item"
              href="/"
              aria-current={operationalRoute.kind === 'dashboard' ? 'page' : undefined}
            >
              <span className="app-nav-icon" aria-hidden="true">⬡</span>
              {t('shell.dashboard')}
            </a>
            <a
              className="app-nav-item"
              href="/reports"
              aria-current={
                operationalRoute.kind === 'reports' || operationalRoute.kind === 'report'
                  ? 'page'
                  : undefined
              }
            >
              <span className="app-nav-icon" aria-hidden="true">📋</span>
              {t('shell.reports')}
            </a>
            <a
              className="app-nav-item"
              href="/settings"
              aria-current={operationalRoute.kind === 'settings' ? 'page' : undefined}
            >
              <span className="app-nav-icon" aria-hidden="true">⚙</span>
              {t('shell.settings')}
            </a>
          </nav>
        </aside>

        <main className="app-content" data-app-state="operational" id="main-content">
          {renderRoute(operationalRoute)}
        </main>
      </div>
    </>
  );
}

function readRoute(): AppRoute {
  return typeof window === 'undefined'
    ? { kind: 'dashboard' }
    : parseAppRoute(window.location.pathname, window.location.search);
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}
