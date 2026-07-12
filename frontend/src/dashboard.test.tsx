// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from './api-client.js';
import { DashboardHistory, loadDigestHistory, type DashboardApi } from './dashboard.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const historyItem = {
  id: 'digest-1',
  window: { from: '2026-07-10T09:00:00.000Z', to: '2026-07-10T10:00:00.000Z' },
  severityCounts: { critical: 1, warning: 2, info: 3 },
  createdAt: '2026-07-10T10:00:00.000Z',
  deliveryStatus: 'sent' as const
};

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('DashboardHistory', () => {
  test('loads an empty digest history through the injected API client', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(state.status).toBe('empty');
    expect(html).toContain('Aún no hay informes');
    expect(html).toContain('Cuando lances el primer informe, aparecerá aquí con su ventana analizada y estado de entrega.');
  });

  test('renders a safe Spanish error state when history loading fails', async () => {
    const state = await loadDigestHistory({
      listHistory: async () => {
        throw new ApiClientError('HISTORY_FAILED', 'Backend rejected synthetic_secret_marker_for_history', 'req-history');
      }
    });
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(state.status).toBe('error');
    expect(html).toContain('No se pudo cargar el historial');
    expect(html).toContain('Revisa que la sesión siga activa y vuelve a intentarlo.');
    expect(html).not.toContain('synthetic_secret_marker_for_history');
  });

  test('renders digest summary cards from shared DTO history items', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([historyItem]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(state.status).toBe('ready');
    expect(html).toContain('1 informe guardado');
    expect(html).toContain('10 jul 2026, 10:00');
    expect(html).toContain('Críticas 1');
    expect(html).toContain('Avisos 2');
    expect(html).toContain('Info 3');
    expect(html).toContain('Enviado');
  });

  test('renders the analyzed window for each history item', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([historyItem]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Ventana analizada: 10 jul 2026, 09:00 — 10 jul 2026, 10:00');
  });

  test('mounted production path loads empty history through api prop', async () => {
    const request = deferred<Awaited<ReturnType<DashboardApi['listHistory']>>>();
    const api = { listHistory: vi.fn(() => request.promise) };
    const { container } = await mountDashboardHistory(api);

    expect(container.textContent).toContain('Cargando historial');
    expect(api.listHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve([]);
      await request.promise;
    });

    expect(container.textContent).toContain('Aún no hay informes');
  });

  test('mounted production path renders list results from api prop', async () => {
    const request = deferred<Awaited<ReturnType<DashboardApi['listHistory']>>>();
    const api = { listHistory: vi.fn(() => request.promise) };
    const { container } = await mountDashboardHistory(api);

    expect(container.textContent).toContain('Cargando historial');
    expect(api.listHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve([historyItem]);
      await request.promise;
    });

    expect(container.textContent).toContain('1 informe guardado');
    expect(container.textContent).toContain('Ventana analizada: 10 jul 2026, 09:00 — 10 jul 2026, 10:00');
  });

  test('mounted production path renders safe error results from api prop', async () => {
    const request = deferred<Awaited<ReturnType<DashboardApi['listHistory']>>>();
    const api = {
      listHistory: vi.fn(() => request.promise)
    };
    const { container } = await mountDashboardHistory(api);

    expect(container.textContent).toContain('Cargando historial');
    expect(api.listHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.reject(new ApiClientError('HISTORY_FAILED', 'Backend rejected synthetic_secret_marker_for_history', 'req-history'));
      await request.promise.catch(() => undefined);
    });

    expect(container.textContent).toContain('No se pudo cargar el historial');
    expect(container.textContent).not.toContain('synthetic_secret_marker_for_history');
  });

  test('sets loading state again when the api prop changes', async () => {
    const firstApi = { listHistory: vi.fn(async () => [historyItem]) };
    const secondRequest = deferred<Awaited<ReturnType<DashboardApi['listHistory']>>>();
    const secondApi = { listHistory: vi.fn(() => secondRequest.promise) };
    const { container, root } = await mountDashboardHistory(firstApi);

    await flushAsyncWork();
    expect(container.textContent).toContain('1 informe guardado');

    await act(async () => {
      root.render(<DashboardHistory api={secondApi} />);
    });

    expect(secondApi.listHistory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Cargando historial');
    expect(container.textContent).not.toContain('1 informe guardado');

    await act(async () => {
      secondRequest.resolve([]);
      await secondRequest.promise;
    });

    expect(container.textContent).toContain('Aún no hay informes');
  });
});

function fakeDashboardApi(items: Awaited<ReturnType<DashboardApi['listHistory']>>): DashboardApi {
  return { listHistory: async () => items };
}

async function mountDashboardHistory(api: DashboardApi) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(<DashboardHistory api={api} />);
  });

  return { container, root };
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
