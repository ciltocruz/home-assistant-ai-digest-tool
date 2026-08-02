import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App, resolveSetupToken } from './App.js';
import { defaultLocale, messages, t } from './i18n/index.js';

afterEach(() => {
  vi.doUnmock('./api-client.js');
  vi.doUnmock('./onboarding.js');
  vi.resetModules();
  delete (globalThis as { __HA_DIGEST_BOOTSTRAP__?: { setupToken?: string } }).__HA_DIGEST_BOOTSTRAP__;
  delete (globalThis as { document?: Document }).document;
});

describe('App', () => {
  test('renders the product shell in Spanish by default', () => {
    const html = renderToStaticMarkup(<App />);

    expect(defaultLocale).toBe('es');
    expect(html).toContain('Home Assistant AI Digest');
    expect(html).toContain('Conecta Home Assistant');
    expect(html).toContain('Proveedor de IA');
    expect(html).toContain('Horario');
    expect(html).toContain('Privacidad');
    expect(html).toContain('Primer informe');
    expect(html).toContain('Los secretos se envían solo al backend local y se muestran enmascarados tras la validación.');
    expect(html).not.toContain('Informe manual');
    expect(html).not.toContain('análisis redactado');
  });

  test('keeps the skip link while withholding operational navigation during setup', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('href="#onboarding-flow"');
    expect(html).toContain('Saltar al contenido principal');
    expect(html).not.toContain('aria-label="Navegación principal"');
  });

  test('does not render dashboard copy from the Spanish catalog before onboarding is verified', () => {
    const html = renderToStaticMarkup(<App />);

    expect(t('dashboard.manualDigest.title')).toBe(messages.es.dashboard.manualDigest.title);
    expect(html).not.toContain(messages.es.dashboard.manualDigest.title);
    expect(html).not.toContain(messages.es.dashboard.history.unavailable.title);
    expect(html).not.toContain('Notas del operador');
    expect(html).not.toContain('Avisos ignorados');
    expect(html).not.toContain('Enviar prueba de Telegram');
    expect(html).not.toContain('Privacidad y retención');
  });

  test('does not reveal unavailable dashboard actions before onboarding is verified', () => {
    const html = renderToStaticMarkup(<App api={{ validateSetup: vi.fn() }} />);

    expect(html).not.toContain('Informe manual');
    expect(html).not.toContain('Enviar prueba');
    expect(html).toContain('Configuración guiada');
  });

  test('keeps API-backed control cards behind the onboarding gate', () => {
    const html = renderToStaticMarkup(<App api={{ validateSetup: vi.fn(), runDigest: vi.fn() }} />);

    expect(html).not.toContain('Añade contexto manual');
    expect(html).not.toContain('Silencia entidades');
  });

  test('does not render the manual digest action from an unverified partial API', () => {
    const html = renderToStaticMarkup(<App api={{ runDigest: vi.fn() }} />);

    expect(html).not.toContain('Lanzar informe</button>');
    expect(html).toContain('Configuración guiada');
  });

  test('does not treat a partial controls API as proof that onboarding is complete', () => {
    const partialControlsApi = {
      validateSetup: vi.fn(),
      runDigest: vi.fn(),
      getSettings: vi.fn(),
      listNotes: vi.fn(),
      testNotifier: vi.fn()
    };

    const html = renderToStaticMarkup(<App api={partialControlsApi} />);

    expect(html).not.toContain('Enviar prueba');
    expect(html).toContain('Configuración guiada');
  });

  test('passes the configured bootstrap setup token to the production API client', async () => {
    const api = { validateSetup: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(), runDigest: vi.fn() };
    const createApiClient = vi.fn(() => api);
    (globalThis as { __HA_DIGEST_BOOTSTRAP__?: { setupToken?: string } }).__HA_DIGEST_BOOTSTRAP__ = { setupToken: 'setup bootstrap value' };

    vi.doMock('./api-client.js', () => ({ createApiClient }));
    vi.doMock('./onboarding.js', () => ({
      createInitialOnboardingState: () => ({ step: 'homeAssistant' }),
      OnboardingFlow: ({ api: receivedApi }: { api?: unknown }) => (
        <div data-testid="onboarding-api-wired">{receivedApi === api ? 'wired' : 'missing'}</div>
      )
    }));

    const { App: AppWithMockedApi } = await import('./App.js');
    const html = renderToStaticMarkup(<AppWithMockedApi />);

    expect(createApiClient).toHaveBeenCalledWith({ setupToken: 'setup bootstrap value' });
    expect(html).toContain('wired');
    expect(html).not.toContain('missing');
  });

  test('shows a clear setup configuration message when the bootstrap token is missing', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Falta la clave de arranque del asistente. Introdúcela desde un canal privado antes de completar el primer arranque.');
  });

  test('resolves setup tokens only from runtime bootstrap or meta configuration', () => {
    expect(resolveSetupToken()).toBe('');

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: () => ({ content: ' meta setup value ' }) }
    });
    expect(resolveSetupToken()).toBe('meta setup value');

    delete (globalThis as { document?: Document }).document;
    (globalThis as { __HA_DIGEST_BOOTSTRAP__?: { setupToken?: string } }).__HA_DIGEST_BOOTSTRAP__ = { setupToken: ' global setup value ' };
    expect(resolveSetupToken()).toBe('global setup value');
  });
});
