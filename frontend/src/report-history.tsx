import { useEffect, useState } from 'react';
import { type BatchDeleteReportsResponse, type DigestHistoryResponse, type DigestSummary, type StaleEntitiesResponse } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { t } from './i18n/index.js';
import { formatDateTime } from './date-time.js';

export type DashboardApi = {
  listHistory(): Promise<DigestHistoryResponse>;
  deleteDigestsBatch?(ids: string[]): Promise<BatchDeleteReportsResponse>;
  deleteDigest?(id: string): Promise<void>;
  getStaleEntities?(): Promise<StaleEntitiesResponse>;
};

export type DashboardHistoryState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; items: DigestSummary[] }
  | { status: 'error'; message: string }
  | { status: 'unavailable' };

export async function loadDigestHistory(api: DashboardApi): Promise<DashboardHistoryState> {
  try {
    const items = await api.listHistory();
    return items.length === 0 ? { status: 'empty' } : { status: 'ready', items };
  } catch (error) {
    const message = error instanceof ApiClientError || error instanceof Error
      ? redactSensitiveText(error.message)
      : t('dashboard.history.error.copy');
    return { status: 'error', message };
  }
}

export function DashboardHistory({
  api,
  state: initialState,
  refreshKey = 0,
  headingLevel = 'h1',
  timeZone,
  onDeleted
}: {
  api?: DashboardApi;
  state?: DashboardHistoryState;
  refreshKey?: number;
  headingLevel?: 'h1' | 'h2';
  timeZone?: string;
  onDeleted?: () => void;
}) {
  const [state, setState] = useState<DashboardHistoryState>(initialState ?? (api ? { status: 'loading' } : { status: 'unavailable' }));
  const [retryKey, setRetryKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (initialState) {
      setState(initialState);
      return;
    }

    if (!api) {
      setState({ status: 'unavailable' });
      return;
    }

    let active = true;
    setState({ status: 'loading' });
    void loadDigestHistory(api).then((nextState) => {
      if (active) setState(nextState);
    });
    return () => { active = false; };
  }, [api, initialState, refreshKey, retryKey]);

  function toggleSelectItem(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (state.status !== 'ready') return;
    if (selectedIds.size === state.items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(state.items.map((item) => item.id)));
    }
  }

  async function executeBatchDelete() {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const ids = Array.from(selectedIds);
      if (api?.deleteDigestsBatch) {
        await api.deleteDigestsBatch(ids);
      } else if (api?.deleteDigest) {
        await Promise.all(ids.map((id) => api.deleteDigest!(id)));
      }
      setSelectedIds(new Set());
      setIsConfirmOpen(false);
      setIsDeleting(false);
      setRetryKey((key) => key + 1);
      if (onDeleted) onDeleted();
    } catch (error) {
      setIsDeleting(false);
      setDeleteError(error instanceof ApiClientError || error instanceof Error ? redactSensitiveText(error.message) : t('dashboard.history.batchDeleteError'));
    }
  }

  const Heading = headingLevel;
  return (
    <article className="panel history-panel" aria-live="polite">
      <p className="eyebrow">{t('dashboard.history.eyebrow')}</p>
      <Heading>{t('shell.reports')}</Heading>
      {renderHistoryState(
        state,
        () => setRetryKey((value) => value + 1),
        timeZone,
        selectedIds,
        toggleSelectItem,
        toggleSelectAll,
        () => setIsConfirmOpen(true)
      )}
      {isConfirmOpen && (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="batch-delete-dialog-title">
          <div className="confirm-dialog">
            <h2 id="batch-delete-dialog-title">{t('dashboard.history.confirmBatchDeleteTitle')}</h2>
            <p>{t('dashboard.history.confirmBatchDeleteCopy').replace('{count}', String(selectedIds.size))}</p>
            {deleteError ? <p className="error-copy" role="alert">{deleteError}</p> : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={isDeleting}
                onClick={() => { setIsConfirmOpen(false); setDeleteError(null); }}
              >
                {t('dashboard.history.cancel')}
              </button>
              <button
                type="button"
                className="danger-action"
                disabled={isDeleting}
                onClick={() => void executeBatchDelete()}
              >
                {isDeleting ? t('dashboard.history.deleting') : t('dashboard.history.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function renderHistoryState(
  state: DashboardHistoryState,
  onRetry: () => void,
  timeZone?: string,
  selectedIds: Set<string> = new Set(),
  onToggleSelectItem?: (id: string) => void,
  onToggleSelectAll?: () => void,
  onOpenConfirmDelete?: () => void
) {
  if (state.status === 'loading') return <><h2>{t('dashboard.history.loading.title')}</h2><p>{t('dashboard.history.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.history.error.title')}</h2><p>{t('dashboard.history.error.copy')}</p><p className="muted-copy">{state.message}</p><button type="button" onClick={onRetry}>{t('dashboard.history.error.action')}</button></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.history.unavailable.title')}</h2><p>{t('dashboard.history.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.history.empty.title')}</h2><p>{t('dashboard.history.empty.copy')}</p></>;

  const allSelected = state.items.length > 0 && selectedIds.size === state.items.length;

  return <>
    <div className="history-header-controls">
      <p>{summaryLabel(state.items.length)}</p>
      {state.items.length > 0 && (
        <label className="history-select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => onToggleSelectAll?.()}
            aria-label={t('dashboard.history.selectAll')}
          />
          <span>{t('dashboard.history.selectAll')}</span>
        </label>
      )}
    </div>

    {selectedIds.size > 0 && (
      <div className="history-batch-toolbar" role="region" aria-label="Acciones en lote">
        <span className="batch-selected-count">
          {t('dashboard.history.selectedCount').replace('{count}', String(selectedIds.size))}
        </span>
        <button type="button" className="danger-action" onClick={() => onOpenConfirmDelete?.()}>
          {t('dashboard.history.deleteSelected')}
        </button>
      </div>
    )}

    <ul className="history-list">
      {state.items.map((item) => (
        <li key={item.id} className="history-item">
          <div className="history-item-select">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              onChange={() => onToggleSelectItem?.(item.id)}
              aria-label={t('dashboard.history.selectItem').replace('{id}', item.id)}
            />
          </div>
          <HistoryItemContent item={item} timeZone={timeZone} />
        </li>
      ))}
    </ul>
  </>;
}

export function HistoryItemContent({ item, variant = 'history', timeZone }: { item: DigestSummary; variant?: 'history' | 'latest'; timeZone?: string }) {
  const createdAt = formatDateTime(item.createdAt, timeZone);
  const source = item.source ?? 'legacy';
  return (
    <a className="history-link" href={`/reports/${encodeURIComponent(item.id)}`} aria-label={t('dashboard.history.openReport').replace('{time}', createdAt)}>
      <div className="history-primary">
        <div><span className="history-field-label">{t('dashboard.history.fields.date')}</span><time dateTime={item.createdAt}>{createdAt}</time></div>
        <span className="muted-copy">{analysisWindowLabel(item, timeZone)}{item.source === 'v2' ? null : <> <span className="history-window-help">{t('dashboard.history.reviewedPeriodHelp')}</span></>}</span>
      </div>
      <dl className="history-facts">
        {source === 'legacy' ? <div className="history-fact history-fact--source"><dt>{t('dashboard.history.fields.format')}</dt><dd><span className="history-source-badge history-source-badge--legacy">{sourceLabel(source)}</span></dd></div> : null}
        <div className="history-fact history-fact--report"><dt>{t('dashboard.history.fields.reportResult')}</dt><dd>{reportResultLabel(item)}</dd></div>
        <div className="history-fact history-fact--analysis"><dt>{t('dashboard.history.fields.aiAnalysis')}</dt><dd>{aiAnalysisLabel(item)}</dd></div>
        <div className="history-fact history-fact--notification"><dt>{t('dashboard.history.fields.telegramNotification')}</dt><dd>{deliveryLabel(item.deliveryStatus)}{item.deliveryDiagnostic ? <span className="history-diagnostic">{deliveryDiagnosticCopy(item.deliveryDiagnostic.messageKey)}</span> : item.deliveryStatus === 'failed' ? <span className="history-diagnostic">{t('report.outcomes.notificationFailureUnknown')}</span> : null}</dd></div>
      </dl>
      <div className="history-statuses" aria-label={`${t('dashboard.history.fields.reportResult')}; ${t('dashboard.history.fields.notification')}`}>
        <span className={`outcome-badge outcome-badge--${reportResultKind(item)}`}>{t('dashboard.history.fields.reportResult')}: {reportResultLabel(item)}</span>
        <span className={`outcome-badge outcome-badge--notification-${item.deliveryStatus}`}>{t('dashboard.history.fields.telegramNotification')}: {deliveryLabel(item.deliveryStatus)}</span>
      </div>
      <div className="severity-strip" aria-label={t('dashboard.history.severityAriaLabel')}>
        <span className="severity-chip severity-chip--critical">{t('dashboard.history.severity.critical')} {item.severityCounts.critical}</span>
        <span className="severity-chip severity-chip--warning">{t('dashboard.history.severity.warning')} {item.severityCounts.warning}</span>
        <span className="severity-chip severity-chip--info">{t('dashboard.history.severity.info')} {item.severityCounts.info}</span>
      </div>
    </a>
  );
}

function summaryLabel(count: number): string {
  return count === 1 ? t('dashboard.history.summarySingular') : t('dashboard.history.summaryPlural').replace('{count}', String(count));
}

function deliveryLabel(status: DigestSummary['deliveryStatus']): string {
  return t(`dashboard.history.deliveryStatus.${status}`);
}

function reportResultKind(item: DigestSummary): 'generated' | 'partial' | 'failed' | 'legacy' {
  if ((item.source ?? 'legacy') === 'legacy') return 'legacy';
  if (item.runStatus === 'failed') return 'failed';
  if (item.runStatus === 'partial') return 'partial';
  return 'generated';
}

function reportResultLabel(item: DigestSummary): string {
  return t(`dashboard.history.reportResult.${reportResultKind(item)}`);
}

function aiAnalysisLabel(item: DigestSummary): string {
  if ((item.source ?? 'legacy') === 'legacy') return t('dashboard.history.aiAnalysis.legacy');
  if (item.runStatus === 'failed') return t('dashboard.history.aiAnalysis.failed');
  if (item.runStatus === 'partial') return t('dashboard.history.aiAnalysis.partial');
  if (item.runStatus === 'quiet') return t('dashboard.history.aiAnalysis.quiet');
  if (item.runStatus === 'reported') return t('dashboard.history.aiAnalysis.complete');
  return t('dashboard.history.aiAnalysis.unknown');
}

function sourceLabel(source: NonNullable<DigestSummary['source']>): string {
  return t(`dashboard.history.source.${source}`);
}

function analysisWindowLabel(item: DigestSummary, timeZone?: string): string {
  if (item.source === 'v2') {
    return t('dashboard.history.generatedAt').replace('{time}', formatDateTime(item.createdAt, timeZone));
  }
  return t('dashboard.history.analysisWindow')
    .replace('{from}', formatDateTime(item.window.from, timeZone))
    .replace('{to}', formatDateTime(item.window.to, timeZone));
}

function deliveryDiagnosticCopy(messageKey: NonNullable<DigestSummary['deliveryDiagnostic']>['messageKey']): string {
  return t(`report.outcomes.deliveryDiagnostics.${messageKey}.copy`);
}
