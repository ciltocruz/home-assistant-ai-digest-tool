// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StaleEntitiesResponse } from '@ha-digest/shared';
import { StaleEntitiesCard, formatRelativeTime, formatDomainName, type StaleEntitiesApi } from './stale-entities.js';
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

const mockData: StaleEntitiesResponse = {
  unavailableCount: 1,
  staleCount: 1,
  totalAudited: 15,
  entities: [
    {
      entityId: 'sensor.living_room_temp',
      name: 'Temperatura Salón',
      domain: 'sensor',
      state: 'unavailable',
      issueType: 'unavailable',
      lastUpdated: '2026-08-16T15:00:00.000Z'
    },
    {
      entityId: 'climate.bedroom_ac',
      name: 'Aire Dormitorio',
      domain: 'climate',
      state: 'off',
      issueType: 'stale',
      lastUpdated: '2026-08-14T10:00:00.000Z'
    }
  ]
};

async function mountCard(api?: StaleEntitiesApi, refreshKey = 0) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<StaleEntitiesCard api={api} refreshKey={refreshKey} />);
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

describe('formatRelativeTime & formatDomainName', () => {
  test('formats relative time for hours and days in Spanish and English', () => {
    const now = new Date('2026-08-16T18:00:00.000Z');
    
    // 3 hours ago
    const threeHoursAgo = '2026-08-16T15:00:00.000Z';
    expect(formatRelativeTime(threeHoursAgo, now, 'es')).toBe('hace 3 horas');
    expect(formatRelativeTime(threeHoursAgo, now, 'en')).toBe('3 hours ago');

    // 2 days ago
    const twoDaysAgo = '2026-08-14T18:00:00.000Z';
    expect(formatRelativeTime(twoDaysAgo, now, 'es')).toBe('hace 2 días');
    expect(formatRelativeTime(twoDaysAgo, now, 'en')).toBe('2 days ago');

    // 15 minutes ago
    const fifteenMinsAgo = '2026-08-16T17:45:00.000Z';
    expect(formatRelativeTime(fifteenMinsAgo, now, 'es')).toBe('hace 15 minutos');
    expect(formatRelativeTime(fifteenMinsAgo, now, 'en')).toBe('15 minutes ago');
  });

  test('formats domain names cleanly', () => {
    expect(formatDomainName('binary_sensor')).toBe('Binary Sensor');
    expect(formatDomainName('climate')).toBe('Climate');
    expect(formatDomainName('sensor')).toBe('Sensor');
  });
});

describe('StaleEntitiesCard Component', () => {
  test('loads and renders entity issues with summary badges', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(mockData);
    const { container } = await mountCard({ getStaleEntities });

    expect(getStaleEntities).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Auditoría de Dispositivos y Entidades');
    expect(container.textContent).toContain('1 Sin respuesta');
    expect(container.textContent).toContain('1 Inactivos (+24h)');
    expect(container.textContent).toContain('15 Auditados');

    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('sensor.living_room_temp');
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).toContain('climate.bedroom_ac');
  });

  test('filters entities when switching filter tabs', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(mockData);
    const { container } = await mountCard({ getStaleEntities });

    const tabs = container.querySelectorAll('button[role="tab"]');
    const allTab = tabs[0] as HTMLButtonElement;
    const unavailableTab = tabs[1] as HTMLButtonElement;
    const staleTab = tabs[2] as HTMLButtonElement;

    // Switch to "Sin respuesta"
    await act(async () => {
      unavailableTab.click();
    });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).not.toContain('Aire Dormitorio');

    // Switch to "Inactivos"
    await act(async () => {
      staleTab.click();
    });
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).not.toContain('Temperatura Salón');

    // Switch back to "Todos"
    await act(async () => {
      allTab.click();
    });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('Aire Dormitorio');
  });

  test('filters entities by search input', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(mockData);
    const { container } = await mountCard({ getStaleEntities });

    const searchInput = container.querySelector('input[type="search"]') as HTMLInputElement;

    // Search by name
    await act(async () => {
      setInputValue(searchInput, 'Salón');
    });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).not.toContain('Aire Dormitorio');

    // Search by domain
    await act(async () => {
      setInputValue(searchInput, 'climate');
    });
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).not.toContain('Temperatura Salón');

    // Search nonexistent
    await act(async () => {
      setInputValue(searchInput, 'nonexistent');
    });
    expect(container.textContent).toContain('Sin resultados para el filtro seleccionado.');
  });

  test('filters entities by domain chip toggle', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(mockData);
    const { container } = await mountCard({ getStaleEntities });

    const domainChips = container.querySelectorAll('.stale-domain-chip');
    const climateChip = Array.from(domainChips).find((c) => c.textContent === 'Climate') as HTMLButtonElement;

    // Click Climate chip
    await act(async () => {
      climateChip.click();
    });
    expect(container.textContent).toContain('Aire Dormitorio');
    expect(container.textContent).not.toContain('Temperatura Salón');

    // Toggle off
    await act(async () => {
      climateChip.click();
    });
    expect(container.textContent).toContain('Temperatura Salón');
    expect(container.textContent).toContain('Aire Dormitorio');
  });

  test('refreshes data when clicking refresh button', async () => {
    const getStaleEntities = vi.fn().mockResolvedValue(mockData);
    const { container } = await mountCard({ getStaleEntities });

    const refreshButton = container.querySelector('.stale-refresh-button') as HTMLButtonElement;
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      refreshButton.click();
    });

    expect(getStaleEntities).toHaveBeenCalledTimes(2);
  });

  test('renders empty state when 0 issues found', async () => {
    const emptyResponse: StaleEntitiesResponse = {
      unavailableCount: 0,
      staleCount: 0,
      totalAudited: 20,
      entities: []
    };
    const getStaleEntities = vi.fn().mockResolvedValue(emptyResponse);
    const { container } = await mountCard({ getStaleEntities });

    expect(container.textContent).toContain('¡Todo correcto! Todos los dispositivos responden y reportan estado normalmente.');
  });

  test('returns null when api is undefined', async () => {
    const { container } = await mountCard(undefined);
    expect(container.children.length).toBe(0);
  });
});
