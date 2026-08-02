// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingProgress } from '@ha-digest/shared';
import { App } from './App.js';

let container: HTMLDivElement | undefined;

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe('App persisted onboarding', () => {
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
    expect(container.querySelector('.setup-rail .is-active')?.textContent).toBe('Horario');
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

    expect(container.querySelector('[data-app-state]')?.getAttribute('data-app-state')).toBe('setup');
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('a.skip-link')?.getAttribute('href')).toBe('#onboarding-flow');
    expect(container.textContent).toContain('Configuración guiada');
    expect(container.textContent).not.toContain('Informe manual');
    root.unmount();
  });
});
