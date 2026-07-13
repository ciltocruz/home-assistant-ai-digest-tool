// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ControlsPanel, type ControlsApi } from './controls-panel.js';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const settings = {
  haUrl: 'http://homeassistant.local:8123',
  aiProvider: 'gemini' as const,
  secretRefs: { haTokenRef: 'ref-ha', aiKeyRef: 'ref-ai', notifierRefs: { telegram: 'ref-telegram' } },
  schedules: [{ kind: 'daily' as const, enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced' as const,
  retentionDays: 90
};
afterEach(() => {
  document.body.replaceChildren();
});
describe('ControlsPanel', () => {
  test('loads settings, notes, ignored warnings, and sends API-backed updates', async () => {
    const api: ControlsApi = {
      getSettings: vi.fn(async () => settings),
      updateSettings: vi.fn(async (input) => input),
      listNotes: vi.fn(async () => [{ id: 'note-1', text: 'Router rebooted', occurredAt: '2026-07-10T10:00:00.000Z', createdAt: '2026-07-10T10:01:00.000Z', tags: ['maintenance'] }]),
      addNote: vi.fn(async (input) => ({ id: 'note-2', ...input, createdAt: '2026-07-10T11:01:00.000Z' })),
      listIgnores: vi.fn(async () => [{ id: 'ignore-1', match: 'sensor.noisy', type: 'entity' as const, createdAt: '2026-07-10T10:00:00.000Z', reason: 'Known noisy entity' }]),
      addIgnore: vi.fn(async (input) => ({ id: 'ignore-2', match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: '2026-07-10T11:00:00.000Z' })),
      removeIgnore: vi.fn(async () => undefined),
      testNotifier: vi.fn(async () => ({ status: 'success' as const, message: 'Delivered synthetic test notification', checkedAt: '2026-07-10T10:00:00.000Z' }))
    };
    const { container } = await mountControlsPanel(api, { now: () => '2026-07-10T11:00:00.000Z' });
    await flushAsyncWork();
    expect(container.textContent).toContain('Router rebooted');
    expect(container.textContent).toContain('sensor.noisy');
    await changeInput(container, 'textarea[name="noteText"]', 'Checked recorder gap');
    await submitForm(container, 'form[aria-label="Añadir nota"]');
    expect(api.addNote).toHaveBeenCalledWith({ text: 'Checked recorder gap', occurredAt: '2026-07-10T11:00:00.000Z', tags: [] });
    await changeInput(container, 'input[name="ignoreMatch"]', 'integration.flaky');
    await submitForm(container, 'form[aria-label="Añadir aviso ignorado"]');
    expect(api.addIgnore).toHaveBeenCalledWith(expect.objectContaining({ match: 'integration.flaky', type: 'entity' }));
    await click(container, 'button[data-testid="remove-ignore-ignore-1"]');
    expect(api.removeIgnore).toHaveBeenCalledWith('ignore-1');
    await changeInput(container, 'input[name="retentionDays"]', '120');
    await submitForm(container, 'form[aria-label="Guardar ajustes"]');
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 120, privacyLevel: 'balanced' }));
    await click(container, 'button[data-testid="telegram-test"]');
    expect(api.testNotifier).toHaveBeenCalledWith({ channel: 'telegram', targetRef: 'ref-telegram', message: 'Prueba de Home Assistant AI Digest' });
  });

  test('keeps note text visible and shows a safe error when saving a note fails', async () => {
    const api = createControlsApi({
      addNote: vi.fn(async () => {
        throw new Error('failed with sk_secret_value');
      })
    });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();

    await changeInput(container, 'textarea[name="noteText"]', 'Checked recorder gap');
    await submitForm(container, 'form[aria-label="Añadir nota"]');

    expect(container.textContent).toContain('No se pudo guardar la nota. Inténtalo de nuevo.');
    expect(container.textContent).not.toContain('sk_secret_value');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[name="noteText"]')?.value).toBe('Checked recorder gap');
  });

  test('disables note submission while a note save is pending', async () => {
    const pendingNote = deferred<Awaited<ReturnType<ControlsApi['addNote']>>>();
    const api = createControlsApi({ addNote: vi.fn(() => pendingNote.promise) });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();
    await changeInput(container, 'textarea[name="noteText"]', 'Checked recorder gap');

    const form = container.querySelector<HTMLFormElement>('form[aria-label="Añadir nota"]');
    if (!form) throw new Error('Missing note form');
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));

    expect(container.querySelector<HTMLButtonElement>('form[aria-label="Añadir nota"] button[type="submit"]')?.disabled).toBe(true);

    pendingNote.resolve({ id: 'note-2', text: 'Checked recorder gap', occurredAt: '2026-07-10T11:00:00.000Z', createdAt: '2026-07-10T11:01:00.000Z', tags: [] });
    await flushAsyncWork();
  });

  test('disables all mutation actions while any mutation is pending', async () => {
    const pendingNote = deferred<Awaited<ReturnType<ControlsApi['addNote']>>>();
    const api = createControlsApi({ addNote: vi.fn(() => pendingNote.promise) });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();
    await changeInput(container, 'textarea[name="noteText"]', 'Checked recorder gap');

    await clickButton(container, 'form[aria-label="Añadir nota"] button[type="submit"]');

    expect(container.querySelector<HTMLButtonElement>('form[aria-label="Añadir nota"] button[type="submit"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('form[aria-label="Añadir aviso ignorado"] button[type="submit"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[data-testid="remove-ignore-ignore-1"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('form[aria-label="Guardar ajustes"] button[type="submit"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[data-testid="telegram-test"]')?.disabled).toBe(true);

    await changeInput(container, 'input[name="ignoreMatch"]', 'integration.flaky');
    await clickButton(container, 'form[aria-label="Añadir aviso ignorado"] button[type="submit"]');
    await clickButton(container, 'button[data-testid="remove-ignore-ignore-1"]');
    await clickButton(container, 'form[aria-label="Guardar ajustes"] button[type="submit"]');
    await clickButton(container, 'button[data-testid="telegram-test"]');

    expect(api.addIgnore).not.toHaveBeenCalled();
    expect(api.removeIgnore).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(api.testNotifier).not.toHaveBeenCalled();

    pendingNote.resolve({ id: 'note-2', text: 'Checked recorder gap', occurredAt: '2026-07-10T11:00:00.000Z', createdAt: '2026-07-10T11:01:00.000Z', tags: [] });
    await flushAsyncWork();
  });

  test('keeps settings inputs visible and shows a safe error when saving settings fails', async () => {
    const api = createControlsApi({
      updateSettings: vi.fn(async () => {
        throw new Error('failed with sk_secret_value');
      })
    });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();

    await changeInput(container, 'input[name="retentionDays"]', '120');
    await submitForm(container, 'form[aria-label="Guardar ajustes"]');

    expect(container.textContent).toContain('No se pudieron guardar los ajustes. Inténtalo de nuevo.');
    expect(container.textContent).not.toContain('sk_secret_value');
    expect(container.querySelector<HTMLInputElement>('input[name="retentionDays"]')?.value).toBe('120');
  });

  test('keeps ignored warning input visible and shows a safe error when adding an ignored warning fails', async () => {
    const api = createControlsApi({
      addIgnore: vi.fn(async () => {
        throw new Error('failed with sk_secret_value');
      })
    });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();

    await changeInput(container, 'input[name="ignoreMatch"]', 'integration.flaky');
    await submitForm(container, 'form[aria-label="Añadir aviso ignorado"]');

    expect(container.textContent).toContain('No se pudo guardar el aviso ignorado. Inténtalo de nuevo.');
    expect(container.textContent).not.toContain('sk_secret_value');
    expect(container.querySelector<HTMLInputElement>('input[name="ignoreMatch"]')?.value).toBe('integration.flaky');
    expect(container.textContent).not.toContain('integration.flakyNo reason');
  });

  test('keeps ignored warning visible and shows a safe error when removing an ignored warning fails', async () => {
    const api = createControlsApi({
      removeIgnore: vi.fn(async () => {
        throw new Error('failed with sk_secret_value');
      })
    });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();

    await click(container, 'button[data-testid="remove-ignore-ignore-1"]');

    expect(container.textContent).toContain('No se pudo quitar el aviso ignorado. Inténtalo de nuevo.');
    expect(container.textContent).not.toContain('sk_secret_value');
    expect(container.textContent).toContain('sensor.noisy');
  });

  test('keeps Telegram test available and shows a safe error when test send fails', async () => {
    const api = createControlsApi({
      testNotifier: vi.fn(async () => {
        throw new Error('failed with sk_secret_value');
      })
    });
    const { container } = await mountControlsPanel(api);
    await flushAsyncWork();

    await click(container, 'button[data-testid="telegram-test"]');

    expect(container.textContent).toContain('No se pudo enviar la prueba de Telegram. Inténtalo de nuevo.');
    expect(container.textContent).not.toContain('sk_secret_value');
    expect(container.querySelector<HTMLButtonElement>('button[data-testid="telegram-test"]')?.disabled).toBe(false);
  });
});

function createControlsApi(overrides: Partial<ControlsApi> = {}): ControlsApi {
  return {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (input) => input),
    listNotes: vi.fn(async () => [{ id: 'note-1', text: 'Router rebooted', occurredAt: '2026-07-10T10:00:00.000Z', createdAt: '2026-07-10T10:01:00.000Z', tags: ['maintenance'] }]),
    addNote: vi.fn(async (input) => ({ id: 'note-2', ...input, createdAt: '2026-07-10T11:01:00.000Z' })),
    listIgnores: vi.fn(async () => [{ id: 'ignore-1', match: 'sensor.noisy', type: 'entity' as const, createdAt: '2026-07-10T10:00:00.000Z', reason: 'Known noisy entity' }]),
    addIgnore: vi.fn(async (input) => ({ id: 'ignore-2', match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: '2026-07-10T11:00:00.000Z' })),
    removeIgnore: vi.fn(async () => undefined),
    testNotifier: vi.fn(async () => ({ status: 'success' as const, message: 'Delivered synthetic test notification', checkedAt: '2026-07-10T10:00:00.000Z' })),
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
async function mountControlsPanel(api: ControlsApi, props: { now?: () => string } = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ControlsPanel api={api} now={props.now} />));
  return { container, root };
}
async function flushAsyncWork() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function changeInput(container: Element, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!input) throw new Error(`Missing input ${selector}`);
  await act(async () => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submitForm(container: Element, selector: string) {
  const form = container.querySelector<HTMLFormElement>(selector);
  if (!form) throw new Error(`Missing form ${selector}`);
  await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  await flushAsyncWork();
}
async function click(container: Element, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button ${selector}`);
  await act(async () => button.click()); await flushAsyncWork();
}

async function clickButton(container: Element, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button ${selector}`);
  await act(async () => button.click());
  await flushAsyncWork();
}
