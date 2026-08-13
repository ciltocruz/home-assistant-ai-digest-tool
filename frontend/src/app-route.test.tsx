// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { setLocale } from './i18n/index.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const mountedRoots: Root[] = [];

beforeEach(() => setLocale('es'));

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount();
  history.pushState({}, '', '/');
});

describe('App report route', () => {
  test('uses the dashboard as an operational summary and keeps configuration controls on their route', async () => {
    history.pushState({}, '', '/');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const api = {
      getOnboarding: async () => ({ currentStep: 'first_report' as const, completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
      runDigest: async () => ({ status: 'queued' as const, jobId: 'job-1' }),
      listHistory: async () => [{
        id: 'report-1', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 1, warning: 0, info: 2 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' as const
      }]
    };

    await act(async () => { root.render(<App api={api} />); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    const currentState = container.textContent?.indexOf('Estado actual') ?? -1;
    const activeReport = container.textContent?.indexOf('Informe activo') ?? -1;
    const latestReport = container.textContent?.indexOf('Último informe') ?? -1;
    const historyPreview = container.textContent?.indexOf('Historial reciente') ?? -1;
    expect(currentState).toBeGreaterThan(-1);
    expect(activeReport).toBeGreaterThan(currentState);
    expect(latestReport).toBeGreaterThan(activeReport);
    expect(historyPreview).toBeGreaterThan(latestReport);
    expect(container.textContent).toContain('1 incidencias requieren atención');
    expect(container.textContent).not.toContain('Notas del operador');
    expect(container.textContent).not.toContain('Avisos ignorados');
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
  });

  test('loads a durable report when following its completed lifecycle link', async () => {
    history.pushState({}, '', '/reports/report-9');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const api = {
      getOnboarding: async () => ({ currentStep: 'first_report' as const, completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
      getDigest: async () => ({
        id: 'report-9',
        summary: { id: 'report-9', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' as const },
        rendered: { format: 'markdown' as const, body: '# Informe\n\nInforme recuperado.' }
      })
    };

    await act(async () => { root.render(<App api={api} />); await Promise.resolve(); });

    expect(container.textContent).toContain('Detalle del informe');
    expect(container.textContent).toContain('report-9');
    expect(container.textContent).toContain('Informe recuperado.');
    expect(container.querySelector('h1')?.textContent).toBe('Detalle del informe');
    expect(container.querySelector('.history-panel h2')?.textContent).toBe('Informes');
    expect(container.querySelector('.report-detail a[href="/reports"]')?.textContent).toBe('Volver a informes');
  });

  test('keeps reports selected and provides a report-list recovery path when a deep link is missing', async () => {
    history.pushState({}, '', '/reports/missing-report');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(<App api={{
        getOnboarding: async () => ({ currentStep: 'first_report', completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
        getDigest: async () => { throw new Error('not found'); }
      }} />);
      await Promise.resolve();
    });

    expect(container.querySelector('a[href="/reports"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.textContent).toContain('Informe no encontrado');
    expect(container.querySelector('.report-detail a[href="/reports"]')?.textContent).toBe('Volver a informes');
  });

  test('confirms report deletion, returns to history, and refreshes the remaining reports', async () => {
    history.pushState({}, '', '/reports/report-delete');
    let deleted = false;
    const deleteDigest = vi.fn(async () => { deleted = true; });
    const report = {
      id: 'report-delete',
      summary: { id: 'report-delete', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' as const },
      rendered: { format: 'markdown' as const, body: '# Informe' }
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const api = {
      getOnboarding: async () => ({ currentStep: 'first_report' as const, completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
      getDigest: async () => report,
      deleteDigest,
      listHistory: async () => deleted ? [] : [report.summary]
    };

    await act(async () => { root.render(<App api={api} />); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    const remove = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Eliminar informe');
    await act(async () => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Eliminar informe');
    expect(dialog?.textContent).toContain('Esta acción no se puede deshacer');
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === 'Eliminar informe');
    await act(async () => { confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(deleteDigest).toHaveBeenCalledWith('report-delete');
    expect(location.pathname).toBe('/reports');
    expect(container.textContent).toContain('Aún no hay informes');
    expect(container.textContent).not.toContain('Detalle del informe');
  });

  test('keeps the report available and shows a recoverable message when deletion fails', async () => {
    history.pushState({}, '', '/reports/report-delete-failure');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const report = {
      id: 'report-delete-failure',
      summary: { id: 'report-delete-failure', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' as const },
      rendered: { format: 'markdown' as const, body: '# Informe' }
    };
    await act(async () => { root.render(<App api={{
      getOnboarding: async () => ({ currentStep: 'first_report', completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
      getDigest: async () => report,
      deleteDigest: async () => { throw new Error('storage unavailable'); }
    }} />); await Promise.resolve(); });
    const remove = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Eliminar informe');
    await act(async () => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const confirm = Array.from(container.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? []).find((button) => button.textContent === 'Eliminar informe');
    await act(async () => { confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });

    expect(location.pathname).toBe('/reports/report-delete-failure');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('No se pudo eliminar el informe. Sigue disponible; vuelve a intentarlo.');
  });

  test('keeps the completed lifecycle card visible long enough to follow its report link', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const api = {
      getOnboarding: async () => ({ currentStep: 'first_report' as const, completedSteps: [], draft: {}, secretMetadata: {}, completed: true }),
      runDigest: async () => ({ status: 'queued' as const, jobId: 'job-1' }),
      getDigestJob: async () => ({ id: 'job-1', status: 'completed' as const, stage: 'completed' as const, attempts: 1, retryCount: 0, retryAvailable: false, reportId: 'report-9', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:02:00.000Z' }),
      retryDigestJob: async () => { throw new Error('not expected'); }
    };

    await act(async () => { root.render(<App api={api} />); await Promise.resolve(); });
    const action = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Lanzar informe');
    await act(async () => { action?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });

    expect(container.querySelector('a[href="/reports/report-9"]')?.textContent).toBe('Ver informe');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Lanzar informe')).toBe(false);
  });

  test('renders the selected Configuration area with the shell navigation after onboarding', async () => {
    history.pushState({}, '', '/settings');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => { root.render(<App api={{ getOnboarding: async () => ({ currentStep: 'first_report', completedSteps: [], draft: {}, secretMetadata: {}, completed: true }) }} />); await Promise.resolve(); });

    expect(container.textContent).toContain('Configuración');
    expect(container.textContent).not.toContain('Informe manual');
    expect(container.querySelector('a[href="/settings"]')?.getAttribute('aria-current')).toBe('page');
  });

  test('restores the selected area through popstate after onboarding is complete', async () => {
    history.pushState({}, '', '/');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    await act(async () => {
      root.render(<App api={{ getOnboarding: async () => ({ currentStep: 'first_report', completedSteps: [], draft: {}, secretMetadata: {}, completed: true }) }} />);
      await Promise.resolve();
    });
    await act(async () => {
      history.pushState({}, '', '/reports');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(container.querySelector('a[href="/reports"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('a[href="/"]')?.getAttribute('aria-current')).toBeNull();
  });
});
