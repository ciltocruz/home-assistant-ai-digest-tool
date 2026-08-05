// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JobLifecycle, restoreActiveJobIds, type JobLifecycleApi } from './job-lifecycle.js';
import { setLocale } from './i18n/index.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const mountedRoots: Root[] = [];

beforeEach(() => setLocale('es'));

afterEach(() => {
  vi.useRealTimers();
  for (const root of mountedRoots.splice(0)) root.unmount();
  sessionStorage.clear();
});

describe('JobLifecycle', () => {
  test('polls an active job, pauses while the tab is hidden, and resumes when it becomes visible', async () => {
    vi.useFakeTimers();
    const api = fakeApi(job({ status: 'running', stage: 'detecting' }));
    const { container } = await mountLifecycle(api, ['job-1']);

    expect(api.getDigestJob).toHaveBeenCalledWith('job-1');
    expect(container.textContent).toContain('Detectando incidencias');
    expect(container.textContent).toContain('Última actualización');

    setDocumentVisibility('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(5_000); });
    expect(api.getDigestJob).toHaveBeenCalledTimes(1);

    setDocumentVisibility('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(api.getDigestJob).toHaveBeenCalledTimes(2);
  });

  test('links a completed job to its report and refreshes history once', async () => {
    const onCompleted = vi.fn();
    const api = fakeApi(job({ status: 'completed', stage: 'completed', reportId: 'report-9' }));
    const { container } = await mountLifecycle(api, ['job-1'], onCompleted);

    expect(container.querySelector<HTMLAnchorElement>('a[href="/reports/report-9"]')?.textContent).toBe('Ver informe');
    expect(container.textContent).toContain('Informe completado');
    expect(container.textContent).not.toContain('Informe en curso');
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(restoreActiveJobIds()).toEqual([]);
  });

  test('shows a safe failed state and allows one retry that returns to the queue', async () => {
    const api = fakeApi(job({
      status: 'failed',
      stage: 'failed',
      errorCode: 'HOME_ASSISTANT_UNAVAILABLE',
      errorMessage: "Gemini 404: model 'gemini-flash-latest' failed (classification: model retired). Provider message: models/gemini-1.5-flash is not found.",
      retryAvailable: true
    }), job({ status: 'queued', stage: 'queued', retryCount: 1, retryAvailable: false }));
    const { container } = await mountLifecycle(api, ['job-1']);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Gemini 404');
    expect(alert?.textContent).toContain('model retired');
    expect(alert?.textContent).toContain('models/gemini-1.5-flash is not found');
    expect(container.textContent).toContain('Informe que requiere atención');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reintentar informe');
    expect(retry).toBeDefined();

    await act(async () => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(api.retryDigestJob).toHaveBeenCalledWith('job-1');
    expect(container.textContent).toContain('En cola');
  });

  test('offers one retry after an active-report status refresh fails', async () => {
    const api: JobLifecycleApi = {
      getDigestJob: vi.fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce(job({ status: 'running', stage: 'collecting' })),
      retryDigestJob: vi.fn(async () => job())
    };
    const { container } = await mountLifecycle(api, ['job-1']);

    expect(container.textContent).toContain('No se pudo actualizar el estado del informe');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reintentar estado del informe');
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.getDigestJob).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Recopilando datos');
  });

  test('keeps one recovery action when retrying a failed report is rejected', async () => {
    const api: JobLifecycleApi = {
      getDigestJob: vi.fn(async () => job({ status: 'failed', stage: 'failed', retryAvailable: true })),
      retryDigestJob: vi.fn(async () => { throw new Error('retry unavailable'); })
    };
    const { container } = await mountLifecycle(api, ['job-1']);
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reintentar informe');

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('No se pudo reintentar el informe');
    expect(Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'Reintentar informe')).toHaveLength(1);
    expect(container.textContent).not.toContain('Reintentar estado del informe');
  });

  test('restores only active job identifiers after a reload', () => {
    sessionStorage.setItem('ha-digest.active-jobs', JSON.stringify(['job-queued', 'job-running', 'job-completed', 'job-queued']));

    expect(restoreActiveJobIds()).toEqual(['job-queued', 'job-running', 'job-completed']);
  });
});

async function mountLifecycle(api: JobLifecycleApi, jobIds: string[], onCompleted = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => { root.render(<JobLifecycle api={api} jobIds={jobIds} onCompleted={onCompleted} pollIntervalMs={1_000} />); await Promise.resolve(); });
  return { container, root };
}

function fakeApi(initial: ReturnType<typeof job>, retryResult = initial): JobLifecycleApi {
  return { getDigestJob: vi.fn(async () => initial), retryDigestJob: vi.fn(async () => retryResult) };
}

function job(overrides: Partial<{
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: 'queued' | 'collecting' | 'detecting' | 'generating' | 'rendering' | 'saving' | 'completed' | 'failed';
  reportId: string;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
  retryAvailable: boolean;
}> = {}) {
  return {
    id: 'job-1', status: 'queued' as const, stage: 'queued' as const, attempts: 1, retryCount: 0, retryAvailable: false,
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:02:00.000Z', ...overrides
  };
}

function setDocumentVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}
