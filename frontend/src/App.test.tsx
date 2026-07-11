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
    expect(html).toContain('Horario y privacidad');
    expect(html).toContain('Primer informe');
    expect(html).toContain('Los secretos se envían solo al backend local y se muestran enmascarados tras la validación.');
    expect(html).toContain('El informe manual estará disponible después de persistir ajustes e historial.');
    expect(html).not.toContain('análisis redactado');
  });

  test('renders dashboard copy from the Spanish catalog', () => {
    const html = renderToStaticMarkup(<App />);

    expect(t('dashboard.manualDigest.title')).toBe(messages.es.dashboard.manualDigest.title);
    expect(html).toContain(messages.es.dashboard.manualDigest.title);
    expect(html).toContain(messages.es.dashboard.history.title);
    expect(html).toContain(messages.es.dashboard.notes.title);
    expect(html).toContain(messages.es.dashboard.ignoredWarnings.title);
    expect(html).toContain(messages.es.dashboard.telegramTest.title);
    expect(html).toContain(messages.es.dashboard.settings.title);
  });

  test('renders unavailable dashboard actions as disabled and explicit', () => {
    const html = renderToStaticMarkup(<App api={{ validateSetup: vi.fn(), runDigest: vi.fn() }} />);

    expect(html).toContain('El informe manual estará disponible después de persistir ajustes e historial.');
    expect(html).toContain('La prueba de Telegram estará disponible cuando exista un canal guardado.');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Lanzar informe</button>');
    expect(html).not.toContain('Enviar prueba</button>');
  });

  test('keeps dashboard non-action card copy explicitly unavailable', () => {
    const html = renderToStaticMarkup(<App api={{ validateSetup: vi.fn(), runDigest: vi.fn() }} />);

    expect(html).toContain('Las notas del operador estarán disponibles cuando el backend persista contexto manual.');
    expect(html).toContain('Los avisos ignorados estarán disponibles cuando exista persistencia de reglas.');
    expect(html).not.toContain('Adjunta mantenimientos');
    expect(html).not.toContain('Mantén entidades ruidosas');
  });

  test('passes the configured bootstrap setup token to the production API client', async () => {
    const api = { validateSetup: vi.fn(), runDigest: vi.fn() };
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

    expect(html).toContain('Falta la clave de arranque del asistente. Configura el backend para inyectarla antes de completar el primer arranque.');
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
