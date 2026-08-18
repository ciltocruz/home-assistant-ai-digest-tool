// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StaleEntitiesResponse } from '@ha-digest/shared';
import { ApiClientError } from './api-client.js';
import { AuditPage, formatDomainNameAudit, formatRelativeTimeAudit, type AuditPageApi } from './audit-page.js';
import { setLocale } from './i18n/index.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
});

beforeEach(() => {
  setLocale('es');
});

const NOW = Date.now();
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3600 * 1000).toISOString();
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 3600 * 1000).toISOString();

function entity(overrides: Partial<{ entityId: string; name: string; domain: string; state: string; issueType: 'unavailable' | 'stale'; lastUpdated: string; deviceName?: string }>) {
  const base = { entityId: 'sensor.base', name: 'Base', domain: 'sensor', state: 'off', issueType: 'stale' as const, lastUpdated: hoursAgo(8), deviceName: 'Salón' };
  return { ...base, ...overrides };
}

function response(entities: StaleEntitiesResponse['entities']): StaleEntitiesResponse {
  return {
    unavailableCount: entities.filter((item) => item.issueType === 'unavailable').length,
    staleCount: entities.filter((item) => item.issueType === 'stale').length,
    totalAudited: 25,
    entities
  };
}

const manyEntities = [
  entity({ entityId: 'sensor.living_temp', name: 'Temperatura Salón', lastUpdated: hoursAgo(8), deviceName: 'Salón' }),
  entity({ entityId: 'sensor.living_humidity', name: 'Humedad Salón', lastUpdated: hoursAgo(9), deviceName: 'Salón' }),
  entity({ entityId: 'sensor.bedroom_temp', name: 'Temperatura Dormitorio', lastUpdated: hoursAgo(10), deviceName: 'Dormitorio' }),
  entity({ entityId: 'climate.bedroom_ac', name: 'Aire Dormitorio', domain: 'climate', state: 'off', lastUpdated: daysAgo(3), deviceName: 'Dormitorio' }),
  entity({ entityId: 'binary_sensor.front_door', name: 'Puerta Principal', domain: 'binary_sensor', state: 'unavailable', issueType: 'unavailable', lastUpdated: hoursAgo(8), deviceName: undefined }),
  entity({ entityId: 'sensor.outside_temp', name: 'Temperatura Exterior', lastUpdated: daysAgo(2), deviceName: 'Exterior' })
];

async function mountAuditPage(api?: AuditPageApi) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<AuditPage api={api} />);
  });
  await act(async () => undefined);
  return { container };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Expected native input value setter');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('formatRelativeTimeAudit & formatDomainNameAudit', () => {
  test('formats relative time in Spanish with singular and plural units', () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    expect(formatRelativeTimeAudit('2026-08-16T15:00:00.000Z', now, 'es')).toBe('hace 3 horas');
    expect(formatRelativeTimeAudit('2026-08-16T17:00:00.000Z', now, 'es')).toBe('hace 1 hora');
    expect(formatRelativeTimeAudit('2026-08-14T18:00:00.000Z', now, 'es')).toBe('hace 2 días');
    expect(formatRelativeTimeAudit('2026-08-15T18:00:00.000Z', now, 'es')).toBe('hace 1 día');
    expect(formatRelativeTimeAudit('2026-08-16T17:45:00.000Z', now, 'es')).toBe('hace 15 minutos');
    expect(formatRelativeTimeAudit('2026-08-16T17:59:00.000Z', now, 'es')).toBe('hace 1 minuto');
  });

  test('formats relative time in English with singular and plural units', () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    expect(formatRelativeTimeAudit('2026-08-16T15:00:00.000Z', now, 'en')).toBe('3 hours ago');
    expect(formatRelativeTimeAudit('2026-08-16T17:00:00.000Z', now, 'en')).toBe('1 hour ago');
    expect(formatRelativeTimeAudit('2026-08-14T18:00:00.000Z', now, 'en')).toBe('2 days ago');
    expect(formatRelativeTimeAudit('2026-08-15T18:00:00.000Z', now, 'en')).toBe('1 day ago');
    expect(formatRelativeTimeAudit('2026-08-16T17:45:00.000Z', now, 'en')).toBe('15 minutes ago');
    expect(formatRelativeTimeAudit('2026-08-16T17:59:00.000Z', now, 'en')).toBe('1 minute ago');
  });

  test('clamps future timestamps and passes through invalid dates', () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    expect(formatRelativeTimeAudit('2026-08-17T10:00:00.000Z', now, 'en')).toBe('1 minute ago');
    expect(formatRelativeTimeAudit('not-a-date', now, 'en')).toBe('not-a-date');
  });

  test('formats domain names cleanly', () => {
    expect(formatDomainNameAudit('binary_sensor')).toBe('Binary Sensor');
    expect(formatDomainNameAudit('climate')).toBe('Climate');
    expect(formatDomainNameAudit('sensor')).toBe('Sensor');
  });
});

describe('AuditPage states', () => {
  test('shows the unavailable copy when no api is provided', async () => {
    const { container } = await mountAuditPage();
    expect(container.textContent).toContain('La auditoría de entidades no está disponible en esta sesión.');
  });

  test('shows the loading copy while the first request is in flight', async () => {
    const getStaleEntities = vi.fn().mockReturnValue(new Promise<StaleEntitiesResponse>(() => undefined));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<AuditPage api={{ getStaleEntities }} />);
    });
    expect(container.textContent).toContain('Cargando auditoría de entidades…');
    await act(async () => undefined);
  });

  test('renders summary badges and entity rows after a successful load', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(response(manyEntities));
    const { container } = await mountAuditPage({ getStaleEntities });

    expect(getStaleEntities).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Auditoría');
    expect(container.textContent).toContain('Estado en tiempo real de integraciones y sensores Home Assistant');
    expect(container.textContent).toContain('1 Sin respuesta');
    expect(container.textContent).toContain('5 Inactivos (+24h)');
    expect(container.textContent).toContain('25 Auditados');
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('sensor.living_temp');
    expect(container.textContent).toContain('📱 Salón');
    expect(container.textContent).toContain('Binary Sensor');
    expect(container.textContent).toContain('unavailable');
    expect(container.textContent).toContain('hace 8 horas');
  });

  test('renders the error box with a retry action when the first load fails', async () => {
    const getStaleEntities = vi.fn()
      .mockRejectedValueOnce(new Error('connection token=do-not-send'))
      .mockResolvedValueOnce(response(manyEntities));
    const { container } = await mountAuditPage({ getStaleEntities });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('token=[redacted]');
    expect(alert?.textContent).not.toContain('token=do-not-send');
    expect(container.textContent).not.toContain('Temperatura Salón');

    await act(async () => {
      (alert?.querySelector('button') as HTMLButtonElement).click();
    });
    await act(async () => undefined);
    expect(getStaleEntities).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Temperatura Salón');
  });

  test('uses the localized fallback copy for non-Error failures', async () => {
    const getStaleEntities = vi.fn().mockRejectedValue('boom');
    const { container } = await mountAuditPage({ getStaleEntities });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('No se pudo cargar la auditoría de entidades.');
  });

  test('redacts sensitive text from ApiClientError messages', async () => {
    const getStaleEntities = vi.fn().mockRejectedValue(new ApiClientError('HA_FAILED', 'provider Bearer eyJhbGciOiJIUzI1NiJ9.secret-payload', 'req-1'));
    const { container } = await mountAuditPage({ getStaleEntities });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).not.toContain('secret-payload');
  });

  test('keeps the loaded list when a manual refresh fails', async () => {
    const getStaleEntities = vi.fn()
      .mockResolvedValueOnce(response(manyEntities))
      .mockRejectedValueOnce(new Error('refresh failed'));
    const { container } = await mountAuditPage({ getStaleEntities });

    await act(async () => {
      (container.querySelector('#audit-refresh-btn') as HTMLButtonElement).click();
    });
    await act(async () => undefined);

    expect(getStaleEntities).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Temperatura Salón');
  });
});

describe('AuditPage filters and views', () => {
  async function mountReady() {
    const getStaleEntities = vi.fn().mockResolvedValue(response(manyEntities));
    const mounted = await mountAuditPage({ getStaleEntities });
    return { ...mounted, getStaleEntities };
  }

  test('filters entities when switching filter tabs', async () => {
    const { container } = await mountReady();
    const unavailableTab = container.querySelector('#audit-tab-unavailable') as HTMLButtonElement;
    const staleTab = container.querySelector('#audit-tab-stale') as HTMLButtonElement;
    const allTab = container.querySelector('#audit-tab-all') as HTMLButtonElement;

    await act(async () => { unavailableTab.click(); });
    expect(container.textContent).toContain('Puerta Principal');
    expect(container.textContent).not.toContain('Temperatura Salón');

    await act(async () => { staleTab.click(); });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).not.toContain('Puerta Principal');

    await act(async () => { allTab.click(); });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('Puerta Principal');
  });

  test('filters entities by search across name, entity id, domain, and device name', async () => {
    const { container } = await mountReady();
    const searchInput = container.querySelector('#audit-search') as HTMLInputElement;

    await act(async () => { setInputValue(searchInput, 'Dormitorio'); });
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).not.toContain('Temperatura Salón');

    await act(async () => { setInputValue(searchInput, 'binary_sensor'); });
    expect(container.textContent).toContain('Puerta Principal');
    expect(container.textContent).not.toContain('Aire Dormitorio');

    await act(async () => { setInputValue(searchInput, 'Exterior'); });
    expect(container.textContent).toContain('Temperatura Exterior');
    expect(container.textContent).not.toContain('Puerta Principal');

    await act(async () => { setInputValue(searchInput, 'nonexistent'); });
    expect(container.textContent).toContain('Sin resultados para los filtros seleccionados.');
  });

  test('toggles domain chips to filter by domain', async () => {
    const { container } = await mountReady();
    const climateChip = Array.from(container.querySelectorAll('.stale-domain-chip')).find((chip) => chip.textContent === 'Climate') as HTMLButtonElement;

    await act(async () => { climateChip.click(); });
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).not.toContain('Temperatura Salón');

    await act(async () => { climateChip.click(); });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('Aire Dormitorio');
  });

  test('switches between flat, grouped-by-domain, and devices view modes', async () => {
    const { container } = await mountReady();

    await act(async () => { (container.querySelector('#audit-view-grouped') as HTMLButtonElement).click(); });
    expect(container.querySelector('.audit-domain-group-name')?.textContent).toBe('Binary Sensor');

    await act(async () => { (container.querySelector('#audit-view-devices') as HTMLButtonElement).click(); });
    const groupNames = Array.from(container.querySelectorAll('.audit-domain-group-name')).map((node) => node.textContent);
    expect(groupNames).toEqual(expect.arrayContaining(['📱 Salón', '📱 Dormitorio', '📱 Exterior', '📱 Sin dispositivo asignado']));

    await act(async () => { (container.querySelector('#audit-view-flat') as HTMLButtonElement).click(); });
    expect(container.querySelector('.stale-entity-list')).not.toBeNull();
  });

  test('paginates flat view and keeps filters on the first page', async () => {
    const lots = Array.from({ length: 25 }, (_, index) => entity({ entityId: `sensor.item_${index}`, name: `Sensor ${index}`, deviceName: index % 2 === 0 ? 'Salón' : undefined }));
    const getStaleEntities = vi.fn().mockResolvedValue(response(lots));
    const { container } = await mountAuditPage({ getStaleEntities });

    expect(container.textContent).toContain('Mostrando 20 de 25');
    expect(container.textContent).toContain('Página 1 de 2');
    const nextPage = container.querySelector('#audit-next-page') as HTMLButtonElement;
    const prevPage = container.querySelector('#audit-prev-page') as HTMLButtonElement;
    expect((prevPage as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { nextPage.click(); });
    expect(container.textContent).toContain('Mostrando 5 de 25');
    expect(container.textContent).toContain('Página 2 de 2');
    expect(prevPage.disabled).toBe(false);
    expect((container.querySelector('#audit-next-page') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { prevPage.click(); });
    expect(container.textContent).toContain('Página 1 de 2');

    const pageSize = container.querySelector('#audit-page-size-select') as HTMLSelectElement;
    await act(async () => { pageSize.value = '50'; pageSize.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('Mostrando 25 de 25');
    expect(container.querySelector('#audit-pagination')).toBeNull();
  });

  test('shows the no-issues copy when nothing is wrong', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(response([]));
    const { container } = await mountAuditPage({ getStaleEntities });
    expect(container.textContent).toContain('¡Todo correcto! Todos los dispositivos responden y reportan estado normalmente.');
  });

  test('refreshes data when clicking the refresh button and shows the loading label', async () => {
    let resolveRefresh: (value: StaleEntitiesResponse) => void = () => undefined;
    const getStaleEntities = vi.fn()
      .mockResolvedValueOnce(response(manyEntities))
      .mockImplementationOnce(() => new Promise<StaleEntitiesResponse>((resolve) => { resolveRefresh = resolve; }));
    const { container } = await mountAuditPage({ getStaleEntities });

    const refreshButton = container.querySelector('#audit-refresh-btn') as HTMLButtonElement;
    await act(async () => { refreshButton.click(); });
    expect(getStaleEntities).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Cargando auditoría de entidades…');
    await act(async () => { resolveRefresh(response(manyEntities)); });
    expect(container.textContent).toContain('Actualizar auditoría');
  });
});