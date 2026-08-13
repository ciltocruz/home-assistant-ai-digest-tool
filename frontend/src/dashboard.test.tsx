// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from './api-client.js';
import { Dashboard, DashboardHistory, loadDigestHistory, type DashboardApi } from './dashboard.js';
import { setLocale } from './i18n/index.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const originalTimeZone = process.env.TZ;
beforeEach(() => {
  setLocale('es');
  process.env.TZ = 'UTC';
});

const historyItem = {
  id: 'digest-1',
  window: { from: '2026-07-10T09:00:00.000Z', to: '2026-07-10T10:00:00.000Z' },
  severityCounts: { critical: 1, warning: 2, info: 3 },
  createdAt: '2026-07-10T10:00:00.000Z',
  deliveryStatus: 'sent' as const
};

const mountedRoots: Root[] = [];

afterEach(() => {
  process.env.TZ = originalTimeZone;
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('DashboardHistory', () => {
  test('loads an empty digest history through the injected API client', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(state.status).toBe('empty');
    expect(html).toContain('<h1>Informes</h1>');
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
    expect(html).toContain('<span class="history-field-label">Fecha</span>');
    expect(html).toContain('Críticas 1');
    expect(html).toContain('Avisos 2');
    expect(html).toContain('Info 3');
    expect(html).toContain('Enviada');
  });

  test.each([
    { locale: 'es' as const, expected: '13 ago 2026, 23:15' },
    { locale: 'en' as const, expected: '13 Aug 2026, 23:15' }
  ])('renders UTC report timestamps in the configured timezone for $locale', ({ locale, expected }) => {
    setLocale(locale);
    const html = renderToStaticMarkup(<DashboardHistory
      timeZone="Europe/Madrid"
      state={{ status: 'ready', items: [{ ...historyItem, createdAt: '2026-08-13T21:15:00.000Z' }] }}
    />);

    expect(html).toContain(expected);
    expect(html).toContain('dateTime="2026-08-13T21:15:00.000Z"');
  });

  test('applies configured timezone daylight-saving rules instead of a fixed offset', () => {
    const html = renderToStaticMarkup(<DashboardHistory
      timeZone="Europe/Madrid"
      state={{ status: 'ready', items: [
        { ...historyItem, id: 'summer', createdAt: '2026-08-13T21:15:00.000Z' },
        { ...historyItem, id: 'winter', createdAt: '2026-01-13T21:15:00.000Z' }
      ] }}
    />);

    expect(html).toContain('13 ago 2026, 23:15');
    expect(html).toContain('13 ene 2026, 22:15');
  });

  test('falls back to the runtime local timezone during server-safe rendering', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Europe/Madrid';
    try {
      const html = renderToStaticMarkup(<DashboardHistory state={{ status: 'ready', items: [{ ...historyItem, createdAt: '2026-08-13T21:15:00.000Z' }] }} />);
      expect(html).toContain('13 ago 2026, 23:15');
    } finally {
      process.env.TZ = previous;
    }
  });

  test('makes every saved report an accessible deep link', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([historyItem]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('href="/reports/digest-1"');
    expect(html).toContain('Abrir informe del 10 jul 2026, 10:00');
  });

  test('renders the analyzed window for each history item', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([historyItem]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Periodo revisado: 10 jul 2026, 09:00 — 10 jul 2026, 10:00');
    expect(html).toContain('Intervalo de información de Home Assistant revisado para crear este informe.');
  });

  test('labels a synthetic v2 point-in-time window as the report generation time', async () => {
    const createdAt = '2026-07-10T10:00:00.000Z';
    const state = await loadDigestHistory(fakeDashboardApi([{
      ...historyItem,
      source: 'v2',
      window: { from: '2026-07-10T09:59:59.999Z', to: createdAt },
      createdAt
    }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Informe generado el: 10 jul 2026, 10:00');
    expect(html).not.toContain('Periodo revisado');
    expect(html).not.toContain('Intervalo de información de Home Assistant revisado');
  });

  test('reserves reviewed-period copy for legacy reports even when a v2 fixture contains a wider window', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{ ...historyItem, source: 'v2' }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Informe generado el: 10 jul 2026, 10:00');
    expect(html).not.toContain('Periodo revisado');
  });

  test('separates a partial report result from its failed notification without inventing analysis counts', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{
      ...historyItem,
      source: 'v2',
      runStatus: 'partial',
      warningCodes: ['AI_ANALYSIS_PARTIAL'],
      signatureCounts: { new: 20, recurring: 10, reactivated: 8, latent: 0 },
      deliveryStatus: 'failed'
    }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Resultado del informe');
    expect(html).toContain('Generado con análisis de IA incompleto');
    expect(html).toContain('Análisis de IA');
    expect(html).toContain('Algunos problemas detectados no pudieron explicarse');
    expect(html).toContain('Notificación');
    expect(html).toContain('Notificación de Telegram: no enviada');
    expect(html).toContain('Resultado del informe: Generado con análisis de IA incompleto');
    expect(html).not.toContain('>Fallido<');
    expect(html).not.toContain('7 de 38');
    expect(html).not.toContain('AI_ANALYSIS_PARTIAL');
  });

  test('shows a plain history diagnostic when a safe Telegram reason was recorded', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{
      ...historyItem, source: 'v2', runStatus: 'reported', deliveryStatus: 'failed',
      deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_HTTP_429', messageKey: 'telegram_rate_limited', recordedAt: '2026-07-10T10:00:01.000Z' }
    }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Telegram limitó temporalmente los envíos.');
    expect(html).not.toContain('TELEGRAM_HTTP_429');
  });

  test('shows an indeterminate Telegram response as pending rather than rejected', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{
      ...historyItem, source: 'v2', runStatus: 'reported', deliveryStatus: 'pending',
      deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response', recordedAt: '2026-07-10T10:00:01.000Z' }
    }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Pendiente de confirmación');
    expect(html).toContain('No se pudo confirmar la respuesta de Telegram.');
    expect(html).not.toContain('Telegram rechazó');
    expect(html).not.toContain('TELEGRAM_INVALID_RESPONSE');
  });

  test('states when an older failed delivery has no recorded reason', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{ ...historyItem, source: 'v2', runStatus: 'reported', deliveryStatus: 'failed' }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('El motivo exacto no quedó registrado.');
  });

  test('marks an older-format report honestly and keeps report and notification outcomes explicit', async () => {
    const state = await loadDigestHistory(fakeDashboardApi([{ ...historyItem, source: 'legacy', deliveryStatus: 'skipped' }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain('Informe importado (formato anterior)');
    expect(html).toContain('Formato');
    expect(html).toContain('Resultado del informe');
    expect(html).toContain('Informe importado');
    expect(html).toContain('Notificación');
    expect(html).toContain('No enviada (omitida o no configurada)');
  });

  test.each([
    { locale: 'en' as const, source: 'legacy' as const, sourceLabel: 'Imported report (older format)', deliveryLabel: 'Telegram notification: Sent' },
    { locale: 'es' as const, source: 'legacy' as const, sourceLabel: 'Informe importado (formato anterior)', deliveryLabel: 'Notificación de Telegram: Enviada' }
  ])('flags only $source reports as older format in $locale history', async ({ locale, source, sourceLabel, deliveryLabel }) => {
    setLocale(locale);
    const state = await loadDigestHistory(fakeDashboardApi([{ ...historyItem, source }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);

    expect(html).toContain(sourceLabel);
    expect(html).toContain(deliveryLabel);
    expect(html).toContain('history-source-badge');
  });

  test.each([
    { locale: 'en' as const, forbidden: ['Source', 'AI report'] },
    { locale: 'es' as const, forbidden: ['Origen', 'Informe de IA'] }
  ])('does not show normal v2 origin metadata in $locale history', async ({ locale, forbidden }) => {
    setLocale(locale);
    const state = await loadDigestHistory(fakeDashboardApi([{ ...historyItem, source: 'v2' }]));
    const html = renderToStaticMarkup(<DashboardHistory state={state} />);
    for (const copy of forbidden) expect(html).not.toContain(copy);
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

  test('does not request history before session creation and refreshes after the session exists', async () => {
    const api = { listHistory: vi.fn(async () => [historyItem]) };
    const { container, root } = await mountDashboardHistory(undefined);

    expect(api.listHistory).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Historial pendiente de conexión');

    await act(async () => {
      root.render(<DashboardHistory api={api} />);
      await Promise.resolve();
    });

    expect(api.listHistory).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('1 informe guardado');
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
    expect(container.textContent).toContain('Periodo revisado: 10 jul 2026, 09:00 — 10 jul 2026, 10:00');
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

  test('offers one recovery action after a history failure and reloads only the history', async () => {
    const api = {
      listHistory: vi.fn()
        .mockRejectedValueOnce(new ApiClientError('HISTORY_FAILED', 'Backend rejected request', 'req-history'))
        .mockResolvedValueOnce([historyItem])
    };
    const { container } = await mountDashboardHistory(api);
    await flushAsyncWork();

    expect(container.textContent).toContain('No se pudo cargar el historial');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reintentar historial');
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.listHistory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('1 informe guardado');
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

  test('refreshes saved history when a completed report signals a new lifecycle revision', async () => {
    const api = { listHistory: vi.fn(async () => [historyItem]) };
    const { container, root } = await mountDashboardHistory(api);
    await flushAsyncWork();

    expect(api.listHistory).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<DashboardHistory api={api} refreshKey={1} />); await Promise.resolve(); });

    expect(api.listHistory).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('1 informe guardado');
  });
});

describe('Dashboard', () => {
  test('orders current attention, active report, latest report, and history preview without configuration controls', () => {
    const previousReport = {
      ...historyItem,
      id: 'digest-0',
      createdAt: '2026-07-10T09:00:00.000Z',
      window: { from: '2026-07-10T08:00:00.000Z', to: '2026-07-10T09:00:00.000Z' }
    };

    const html = renderToStaticMarkup(<Dashboard state={{ status: 'ready', items: [historyItem, previousReport] }} activeReport={<p>Estado del informe activo</p>} />);

    const currentState = html.indexOf('Estado actual');
    const activeReport = html.indexOf('Informe activo');
    const latestReport = html.indexOf('Último informe');
    const historyPreview = html.indexOf('Historial reciente');
    expect(html).toContain('<h1 class="dashboard-title">Panel</h1>');
    expect(currentState).toBeGreaterThan(-1);
    expect(html).toContain('3 incidencias requieren atención');
    expect(activeReport).toBeGreaterThan(currentState);
    expect(latestReport).toBeGreaterThan(activeReport);
    expect(historyPreview).toBeGreaterThan(latestReport);
    expect(html).toContain('1 informe anterior');
    expect(html).not.toContain('Notas del operador');
    expect(html).not.toContain('Avisos ignorados');
    expect(html).not.toContain('Privacidad y retención');
  });

  test('gives a clear no-report state and routes the next action to reports', () => {
    const html = renderToStaticMarkup(<Dashboard state={{ status: 'empty' }} activeReport={<p>Sin informe activo</p>} />);

    expect(html).toContain('Sin incidencias pendientes');
    expect(html).toContain('Todavía no hay ningún informe guardado.');
    expect(html).toContain('Sin informes anteriores.');
    expect(html).toContain('href="/reports"');
    expect(html).toContain('Ver informes');
  });

  test('uses a dedicated latest-report layout with horizontal severity groups', () => {
    const html = renderToStaticMarkup(<Dashboard state={{ status: 'ready', items: [historyItem] }} activeReport={<p>Sin informe activo</p>} />);

    expect(html).toContain('history-item--latest');
    expect(html).toContain('history-statuses');
    expect(html).toContain('severity-chip--critical');
    expect(html).toContain('severity-chip--warning');
    expect(html).toContain('severity-chip--info');
  });
});

function fakeDashboardApi(items: Awaited<ReturnType<DashboardApi['listHistory']>>): DashboardApi {
  return { listHistory: async () => items };
}

async function mountDashboardHistory(api?: DashboardApi) {
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
