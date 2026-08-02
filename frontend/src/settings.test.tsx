// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from './settings.js';

const roots: Root[] = [];
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
});

describe('SettingsPanel', () => {
  it('loads masked configuration, keeps secrets explicitly, and saves the complete editable configuration', async () => {
    const updateSettings = vi.fn(async (command) => ({
      ...command,
      homeAssistant: { ...command.homeAssistant, token: { configured: true, mask: '••••HA' } },
      ai: { ...command.ai, key: { configured: true, mask: '••••AI' } }
    }));
    const { container } = await mount({
      getSettings: async () => settings(),
      updateSettings
    });

    expect(container.textContent).toContain('Configuración');
    expect(container.textContent).toContain('••••HA');
    expect(container.querySelector<HTMLInputElement>('input[name="haToken"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="aiKey"]')).toBeNull();

    const form = container.querySelector('form');
    if (!form) throw new Error('Expected settings form.');
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      homeAssistant: { url: 'http://homeassistant.local:8123', token: { operation: 'keep_current' } },
      ai: { provider: 'gemini', key: { operation: 'keep_current' } },
      notifications: { channel: 'none' }
    }));
  });

  it('shows a neutral Spanish actionable error and never reflects a rejected replacement key', async () => {
    const replacement = 'sentinel-rejected-ai-key';
    const { container } = await mount({
      getSettings: async () => settings(),
      updateSettings: async () => { throw new Error(`Server rejected ${replacement}`); }
    });
    const replace = container.querySelector<HTMLInputElement>('input[value="replace-ai-key"]');
    const form = container.querySelector('form');
    if (!replace || !form) throw new Error('Expected AI replacement controls.');

    await act(async () => {
      replace.click();
    });
    const aiKey = container.querySelector<HTMLInputElement>('input[name="aiKey"]');
    if (!aiKey) throw new Error('Expected AI replacement input.');
    await act(async () => {
      aiKey.value = replacement;
      aiKey.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('No se pudieron guardar los ajustes');
    expect(container.textContent).not.toContain(replacement);
  });

  it('uses URL-backed sections and keeps notes, ignores, and notifier actions in Configuration', async () => {
    const removeIgnore = vi.fn(async () => undefined);
    const testCurrentNotifier = vi.fn(async () => ({ status: 'success' as const, message: 'Prueba enviada', checkedAt: '2026-08-01T10:00:00.000Z' }));
    const { container } = await mount({
      getSettings: async () => ({ ...settings(), notifications: { channel: 'telegram' as const, chatId: '123456', botToken: { configured: true as const, mask: '••••TELEGRAM' } } }),
      updateSettings: async () => settings(),
      listNotes: async () => [{ id: 'note-1', text: 'Reinicio del router', occurredAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z', tags: [] }],
      addNote: async (input: { text: string; occurredAt: string; tags: string[] }) => ({ id: 'note-2', ...input, createdAt: '2026-08-01T10:00:00.000Z' }),
      listIgnores: async () => [{ id: 'ignore-1', match: 'sensor.ruidoso', type: 'entity' as const, createdAt: '2026-08-01T10:00:00.000Z' }],
      addIgnore: async (input: { match: string; type: 'entity' }) => ({ id: 'ignore-2', ...input, createdAt: '2026-08-01T10:00:00.000Z' }),
      removeIgnore,
      testCurrentNotifier
    });

    expect(container.querySelector('a[href="/settings?section=context"]')?.textContent).toBe('Contexto');
    expect(container.textContent).toContain('Notas del operador');
    expect(container.textContent).toContain('sensor.ruidoso');
    expect(container.textContent).toContain('Enviar prueba de Telegram');

    const remove = container.querySelector<HTMLButtonElement>('[data-testid="remove-ignore-ignore-1"]');
    if (!remove) throw new Error('Expected ignore removal action.');
    await act(async () => remove.click());
    expect(removeIgnore).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Quitar aviso ignorado');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(remove);
  });

  it('validates, cancels, and protects unsaved configuration changes', async () => {
    const { container } = await mount({ getSettings: async () => settings(), updateSettings: async () => settings() });
    const url = container.querySelector<HTMLInputElement>('input[name="haUrl"]');
    if (!url) throw new Error('Expected Home Assistant URL input.');
    await act(async () => {
      setInputValue(url, 'not-a-url');
    });

    const warning = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[type="button"]')?.textContent).toBe('Cancelar cambios');

    const form = container.querySelector('form');
    if (!form) throw new Error('Expected settings form.');
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Indica una URL válida');

    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancelar cambios');
    if (!cancel) throw new Error('Expected cancel action.');
    await act(async () => cancel.click());
    expect(url.value).toBe('http://homeassistant.local:8123');
  });

  it('keeps an ignored warning after a confirmed removal fails and offers a safe retry', async () => {
    const { container } = await mount({
      getSettings: async () => settings(),
      updateSettings: async () => settings(),
      listIgnores: async () => [{ id: 'ignore-1', match: 'sensor.ruidoso', type: 'entity' as const, createdAt: '2026-08-01T10:00:00.000Z' }],
      removeIgnore: async () => { throw new Error('persistence failed'); }
    });
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="remove-ignore-ignore-1"]');
    if (!remove) throw new Error('Expected ignore removal action.');
    await act(async () => remove.click());
    const confirm = container.querySelector<HTMLButtonElement>('[data-dialog-confirm]');
    if (!confirm) throw new Error('Expected confirmation action.');
    await act(async () => confirm.click());

    expect(container.textContent).toContain('No se pudo quitar el aviso ignorado');
    expect(container.textContent).toContain('sensor.ruidoso');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Reintentar eliminación')).toBe(true);
  });
});

async function mount(api: SettingsApi) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SettingsPanel api={api} />));
  await act(async () => undefined);
  return { container };
}

function settings() {
  return {
    homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true as const, mask: '••••HA' } },
    ai: { provider: 'gemini' as const, key: { configured: true as const, mask: '••••AI' } },
    notifications: { channel: 'none' as const },
    schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
    privacyLevel: 'balanced' as const,
    retentionDays: 90
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Expected the native input value setter.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
