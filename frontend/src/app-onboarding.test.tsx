// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingProgress } from '@ha-digest/shared';
import { App } from './App.js';
import { setLocale } from './i18n/index.js';

let container: HTMLDivElement | undefined;

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
beforeEach(() => setLocale('es'));

afterEach(() => {
  container?.remove();
  container = undefined;
  history.replaceState({}, '', '/');
});

describe('App persisted onboarding', () => {
  it('hydrates the saved locale before rendering the account gate', async () => {
    setLocale('en');
    localStorage.setItem('ha-digest-locale', 'es');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      return path === '/api/auth/status'
        ? new Response(JSON.stringify({ hasAdmin: true }), { status: 200 })
        : new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Sign in required.', requestId: 'account-gate' }), { status: 401 });
    }));
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Bienvenido de nuevo');
    expect(container.textContent).toContain('Iniciar sesión');
    expect(container.textContent).not.toContain('Welcome back');
    root.unmount();
  });

  it('uses the selected locale while rendering the registration gate', async () => {
    setLocale('en');
    localStorage.setItem('ha-digest-locale', 'en');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      return path === '/api/auth/status'
        ? new Response(JSON.stringify({ hasAdmin: false }), { status: 200 })
        : new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Sign in required.', requestId: 'account-register' }), { status: 401 });
    }));
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const language = container.querySelector('select');
    expect(language).not.toBeNull();
    await act(async () => {
      language!.value = 'es';
      language!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Primer arranque');
    expect(container.textContent).toContain('Crear cuenta');
    root.unmount();
  });

  it('shows bootstrap recovery instead of a login prompt for a server failure', async () => {
    setLocale('es');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      return path === '/api/auth/status'
        ? new Response(JSON.stringify({ hasAdmin: true }), { status: 200 })
        : new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Request failed.', requestId: 'bootstrap-failure' }), { status: 503 });
    }));
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('No se pudo comprobar el acceso');
    expect(container.textContent).toContain('Reintentar');
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('Bienvenido de nuevo');
    root.unmount();
  });

  it('loads the saved onboarding screen after a browser reload', async () => {
    const progress: OnboardingProgress = { currentStep: 'schedule', completedSteps: ['home_assistant', 'ai_provider', 'notifications'], draft: { haUrl: 'http://homeassistant.local:8123' }, secretMetadata: { haToken: { configured: true, mask: 'se…et' } }, completed: false };
    const api = {
      validateSetup: vi.fn(), getSettings: vi.fn(async () => ({ homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true } }, ai: { provider: 'gemini' as const, key: { configured: true } }, notifications: { channel: 'none' as const }, schedules: [], privacyLevel: 'balanced' as const, retentionDays: 30 })), updateSettings: vi.fn(), runDigest: vi.fn(),
      getOnboarding: vi.fn(async () => progress)
    };
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App api={api} />);
      await Promise.resolve();
    });

    expect(api.getOnboarding).toHaveBeenCalledTimes(1);
    expect(container.querySelector('h1')?.textContent).toBe('Horario de informes');
    expect(container.textContent).not.toContain('sentinel-onboarding-secret');
    root.unmount();
  });

  it('keeps operational navigation and dashboard content out of an incomplete setup route', async () => {
    history.pushState({}, '', '/settings');
    const api = {
      getOnboarding: vi.fn(async () => ({ currentStep: 'ai_provider' as const, completedSteps: ['home_assistant' as const], draft: {}, secretMetadata: {}, completed: false }))
    };
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App api={api} />);
      await Promise.resolve();
    });

    expect(container.querySelector('form[aria-label="Configuración guiada"]')).not.toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('a.skip-link')?.getAttribute('href')).toBe('#onboarding-flow');
    expect(container.textContent).toContain('Elige tu proveedor de IA');
    expect(container.textContent).not.toContain('Informe manual');
    root.unmount();
  });
});
