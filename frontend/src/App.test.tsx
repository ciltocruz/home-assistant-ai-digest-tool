import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { App } from './App.js';
import { defaultLocale, messages, t } from './i18n/index.js';

describe('App', () => {
  test('renders the product shell in Spanish by default', () => {
    const html = renderToStaticMarkup(<App />);

    expect(defaultLocale).toBe('es');
    expect(html).toContain('Home Assistant AI Digest');
    expect(html).toContain('Conecta Home Assistant');
    expect(html).toContain('Elige proveedor de IA');
    expect(html).toContain('Define el nivel de privacidad');
    expect(html).toContain('Lanza el primer informe');
    expect(html).toContain('Los secretos se envían solo al backend local y se muestran enmascarados tras la validación.');
    expect(html).toContain('Lanza ahora un análisis con datos sensibles enmascarados y deja el informe en cola sin esperar al próximo horario.');
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
});
