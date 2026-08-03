import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test } from 'vitest';
import { App } from './App.js';
import { defaultLocale, messages, setLocale, t } from './i18n/index.js';

describe('App', () => {
  beforeEach(() => setLocale('en'));

  test('shows a secure access loading state before authentication', () => {
    const html = renderToStaticMarkup(<App />);

    expect(defaultLocale).toBe('en');
    expect(html).toContain('Checking secure access…');
    expect(html).not.toContain('aria-label="Navegación principal"');
  });

  test('shows guided Spanish setup after authentication before the operational shell', () => {
    setLocale('es');
    const html = renderToStaticMarkup(<App api={{}} />);

    expect(html).toContain('HA AI Digest');
    expect(html).toContain('Conecta Home Assistant');
    expect(html).toContain('Proveedor de IA');
    expect(html).toContain('Horario');
    expect(html).toContain('Privacidad');
    expect(html).toContain('href="#onboarding-flow"');
    expect(html).not.toContain('aria-label="Navegación principal"');
  });

  test('does not render dashboard copy before onboarding is complete', () => {
    setLocale('es');
    const html = renderToStaticMarkup(<App api={{}} />);

    expect(t('dashboard.manualDigest.title')).toBe(messages.es.dashboard.manualDigest.title);
    expect(html).not.toContain(messages.es.dashboard.manualDigest.title);
    expect(html).not.toContain(messages.es.dashboard.history.unavailable.title);
    expect(html).not.toContain('Notas del operador');
    expect(html).not.toContain('Avisos ignorados');
  });

  test('keeps API-backed control cards behind the onboarding gate', () => {
    setLocale('es');
    const html = renderToStaticMarkup(<App api={{}} />);

    expect(html).not.toContain('Añade contexto manual');
    expect(html).not.toContain('Silencia entidades');
  });

  test('keeps bootstrap secrets out of the account loading page', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).not.toContain('setup-sentinel-secret');
    expect(html).not.toContain('admin-sentinel-secret');
  });
});
