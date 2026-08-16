// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardHistory, type DashboardApi } from './report-history.js';
import { setLocale } from './i18n/index.js';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const report1 = {
  id: 'report-1',
  window: { from: '2026-07-10T09:00:00.000Z', to: '2026-07-10T10:00:00.000Z' },
  severityCounts: { critical: 1, warning: 0, info: 0 },
  createdAt: '2026-07-10T10:00:00.000Z',
  deliveryStatus: 'sent' as const
};

const report2 = {
  id: 'report-2',
  window: { from: '2026-07-11T09:00:00.000Z', to: '2026-07-11T10:00:00.000Z' },
  severityCounts: { critical: 0, warning: 2, info: 0 },
  createdAt: '2026-07-11T10:00:00.000Z',
  deliveryStatus: 'sent' as const
};

const mountedRoots: Root[] = [];

beforeEach(() => {
  setLocale('es');
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('Report History Batch Selection and Deletion', () => {
  test('renders individual selection checkboxes for history items', async () => {
    const api: DashboardApi = {
      listHistory: async () => [report1, report2]
    };
    const { container } = await mountHistory(api);
    await flushAsyncWork();

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    // 1 select-all checkbox + 2 item checkboxes
    expect(checkboxes).toHaveLength(3);
  });

  test('toggles individual report selection and displays batch toolbar with count', async () => {
    const api: DashboardApi = {
      listHistory: async () => [report1, report2]
    };
    const { container } = await mountHistory(api);
    await flushAsyncWork();

    // Toolbar initially hidden
    expect(container.querySelector('.history-batch-toolbar')).toBeNull();

    const itemCheckboxes = Array.from(container.querySelectorAll('.history-item-select input[type="checkbox"]')) as HTMLInputElement[];
    expect(itemCheckboxes).toHaveLength(2);

    // Select first report
    await act(async () => {
      itemCheckboxes[0]?.click();
      await Promise.resolve();
    });

    const toolbar = container.querySelector('.history-batch-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.textContent).toContain('1 seleccionados');
    expect(toolbar?.textContent).toContain('Eliminar seleccionados');

    // Select second report
    await act(async () => {
      itemCheckboxes[1]?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.history-batch-toolbar')?.textContent).toContain('2 seleccionados');
  });

  test('toggles "Select All" checkbox to select and deselect all reports', async () => {
    const api: DashboardApi = {
      listHistory: async () => [report1, report2]
    };
    const { container } = await mountHistory(api);
    await flushAsyncWork();

    const selectAllCheckbox = container.querySelector('.history-select-all input[type="checkbox"]') as HTMLInputElement;
    expect(selectAllCheckbox).not.toBeNull();
    expect(selectAllCheckbox.checked).toBe(false);

    // Click select all
    await act(async () => {
      selectAllCheckbox.click();
      await Promise.resolve();
    });

    expect(selectAllCheckbox.checked).toBe(true);
    expect(container.querySelector('.history-batch-toolbar')?.textContent).toContain('2 seleccionados');

    // Click select all again to deselect
    await act(async () => {
      selectAllCheckbox.click();
      await Promise.resolve();
    });

    expect(selectAllCheckbox.checked).toBe(false);
    expect(container.querySelector('.history-batch-toolbar')).toBeNull();
  });

  test('opens confirmation modal, cancels, and does not invoke delete API', async () => {
    const deleteDigestsBatch = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const api: DashboardApi = {
      listHistory: async () => [report1, report2],
      deleteDigestsBatch
    };
    const { container } = await mountHistory(api);
    await flushAsyncWork();

    // Select report 1
    const itemCheckbox = container.querySelector('.history-item-select input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      itemCheckbox.click();
      await Promise.resolve();
    });

    // Click "Eliminar seleccionados"
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Eliminar seleccionados');
    expect(deleteBtn).toBeDefined();

    await act(async () => {
      deleteBtn?.click();
      await Promise.resolve();
    });

    // Check modal rendered
    const modal = container.querySelector('.confirm-dialog');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('Eliminar informes seleccionados');
    expect(modal?.textContent).toContain('¿Estás seguro de que deseas eliminar 1 informe(s)?');

    // Click "Cancelar"
    const cancelBtn = Array.from(modal?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Cancelar');
    await act(async () => {
      cancelBtn?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.confirm-dialog')).toBeNull();
    expect(deleteDigestsBatch).not.toHaveBeenCalled();
  });

  test('confirms batch deletion, calls deleteDigestsBatch API, and refreshes history', async () => {
    const deleteDigestsBatch = vi.fn().mockResolvedValue({ deletedCount: 2 });
    let reports = [report1, report2];
    const listHistory = vi.fn(async () => reports);
    const api: DashboardApi = {
      listHistory,
      deleteDigestsBatch
    };
    const { container } = await mountHistory(api);
    await flushAsyncWork();

    // Select all
    const selectAllCheckbox = container.querySelector('.history-select-all input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      selectAllCheckbox.click();
      await Promise.resolve();
    });

    // Click delete selected
    const deleteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Eliminar seleccionados');
    await act(async () => {
      deleteBtn?.click();
      await Promise.resolve();
    });

    // Confirm in modal
    const confirmBtn = Array.from(container.querySelectorAll('.confirm-dialog button')).find((b) => b.textContent === 'Eliminar informes');
    expect(confirmBtn).toBeDefined();

    // Mock backend state change on delete
    reports = [];

    await act(async () => {
      confirmBtn?.click();
      await Promise.resolve();
    });

    expect(deleteDigestsBatch).toHaveBeenCalledWith(['report-1', 'report-2']);
    expect(listHistory).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.confirm-dialog')).toBeNull();
  });
});

async function mountHistory(api: DashboardApi) {
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
