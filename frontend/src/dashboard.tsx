import { useEffect, useState, type ReactNode } from 'react';
import { type DigestHistoryResponse, type DigestSummary } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { t } from './i18n/index.js';

export type DashboardApi = {
  listHistory(): Promise<DigestHistoryResponse>;
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

export function Dashboard({ api, state: initialState, activeReport, refreshKey = 0 }: { api?: DashboardApi; state?: DashboardHistoryState; activeReport: ReactNode; refreshKey?: number }) {
  const [state, setState] = useState<DashboardHistoryState>(initialState ?? (api ? { status: 'loading' } : { status: 'unavailable' }));
  const [retryKey, setRetryKey] = useState(0);

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
    void loadDigestHistory(api).then((nextState) => { if (active) setState(nextState); });
    return () => { active = false; };
  }, [api, initialState, refreshKey, retryKey]);

  return <section className="dashboard-overview" aria-label={t('dashboard.ariaLabel')}>
    <h1 className="dashboard-title">{t('shell.dashboard')}</h1>
    <section className="panel dashboard-state" data-dashboard-section="current-state" aria-live="polite">
      <p className="eyebrow">{t('dashboard.currentState.eyebrow')}</p>
      {renderCurrentState(state, () => setRetryKey((value) => value + 1))}
    </section>
    <section className="dashboard-active-report" data-dashboard-section="active-report" aria-labelledby="active-report-title">
      <h2 id="active-report-title">{t('dashboard.activeReport.title')}</h2>
      {activeReport}
    </section>
    <section className="panel dashboard-latest-report" data-dashboard-section="latest-report" aria-labelledby="latest-report-title">
      <p className="eyebrow">{t('dashboard.latestReport.eyebrow')}</p>
      <h2 id="latest-report-title">{t('dashboard.latestReport.title')}</h2>
      {renderLatestReport(state)}
    </section>
    <section className="panel dashboard-history-preview" data-dashboard-section="history-preview" aria-labelledby="history-preview-title">
      <p className="eyebrow">{t('dashboard.historyPreview.eyebrow')}</p>
      <h2 id="history-preview-title">{t('dashboard.historyPreview.title')}</h2>
      {renderHistoryPreview(state)}
    </section>
  </section>;
}

export function DashboardHistory({ api, state: initialState, refreshKey = 0 }: { api?: DashboardApi; state?: DashboardHistoryState; refreshKey?: number }) {
  const [state, setState] = useState<DashboardHistoryState>(initialState ?? (api ? { status: 'loading' } : { status: 'unavailable' }));
  const [retryKey, setRetryKey] = useState(0);

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

  return (
    <article className="panel history-panel" aria-live="polite">
      <p className="eyebrow">{t('dashboard.history.eyebrow')}</p>
      <h1>{t('shell.reports')}</h1>
      {renderHistoryState(state, () => setRetryKey((value) => value + 1))}
    </article>
  );
}

function renderHistoryState(state: DashboardHistoryState, onRetry: () => void) {
  if (state.status === 'loading') return <><h2>{t('dashboard.history.loading.title')}</h2><p>{t('dashboard.history.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.history.error.title')}</h2><p>{t('dashboard.history.error.copy')}</p><p className="muted-copy">{state.message}</p><button type="button" onClick={onRetry}>{t('dashboard.history.error.action')}</button></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.history.unavailable.title')}</h2><p>{t('dashboard.history.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.history.empty.title')}</h2><p>{t('dashboard.history.empty.copy')}</p></>;

  return <>
    <p>{summaryLabel(state.items.length)}</p>
    <ul className="history-list">
      {state.items.map((item) => <HistoryItem key={item.id} item={item} />)}
    </ul>
  </>;
}

function renderCurrentState(state: DashboardHistoryState, onRetry: () => void) {
  if (state.status === 'loading') return <><h2>{t('dashboard.currentState.loading.title')}</h2><p>{t('dashboard.currentState.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.currentState.error.title')}</h2><p>{t('dashboard.currentState.error.copy')}</p><button type="button" onClick={onRetry}>{t('dashboard.currentState.error.action')}</button></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.currentState.unavailable.title')}</h2><p>{t('dashboard.currentState.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.currentState.empty.title')}</h2><p>{t('dashboard.currentState.empty.copy')}</p></>;

  const attentionCount = state.items[0].severityCounts.critical + state.items[0].severityCounts.warning;
  return <><h2>{t('dashboard.currentState.ready.title')}</h2><p>{attentionCount === 0 ? t('dashboard.currentState.ready.clear') : t('dashboard.currentState.ready.attention').replace('{count}', String(attentionCount))}</p></>;
}

function renderLatestReport(state: DashboardHistoryState) {
  if (state.status === 'ready') return <ul className="history-list"><HistoryItem item={state.items[0]} /></ul>;
  if (state.status === 'error') return <><p>{t('dashboard.latestReport.error.copy')}</p><a className="report-link" href="/reports">{t('dashboard.latestReport.error.action')}</a></>;
  if (state.status === 'loading') return <p>{t('dashboard.latestReport.loading')}</p>;
  return <><p>{t('dashboard.latestReport.empty.copy')}</p><a className="report-link" href="/reports">{t('dashboard.latestReport.empty.action')}</a></>;
}

function renderHistoryPreview(state: DashboardHistoryState) {
  if (state.status === 'ready' && state.items.length > 1) {
    const previewItems = state.items.slice(1, 4);
    return <><p>{t('dashboard.historyPreview.summary').replace('{count}', String(previewItems.length))}</p><ul className="history-list">{previewItems.map((item) => <HistoryItem key={item.id} item={item} />)}</ul><a className="report-link" href="/reports">{t('dashboard.historyPreview.action')}</a></>;
  }
  if (state.status === 'loading') return <p>{t('dashboard.historyPreview.loading')}</p>;
  if (state.status === 'error') return <><p>{t('dashboard.historyPreview.error.copy')}</p><a className="report-link" href="/reports">{t('dashboard.historyPreview.error.action')}</a></>;
  return <><p>{t('dashboard.historyPreview.empty.copy')}</p><a className="report-link" href="/reports">{t('dashboard.historyPreview.empty.action')}</a></>;
}

function HistoryItem({ item }: { item: DigestSummary }) {
  const createdAt = formatDateTime(item.createdAt);
  return <li className="history-item">
    <a className="history-link" href={`/reports/${encodeURIComponent(item.id)}`} aria-label={t('dashboard.history.openReport').replace('{time}', createdAt)}>
      <span>{createdAt}</span>
      <span className="muted-copy">{analysisWindowLabel(item)}</span>
      <strong>{deliveryLabel(item.deliveryStatus)}</strong>
      <div className="severity-strip" aria-label={t('dashboard.history.severityAriaLabel')}>
        <span>{t('dashboard.history.severity.critical')} {item.severityCounts.critical}</span>
        <span>{t('dashboard.history.severity.warning')} {item.severityCounts.warning}</span>
        <span>{t('dashboard.history.severity.info')} {item.severityCounts.info}</span>
      </div>
    </a>
  </li>;
}

function summaryLabel(count: number): string {
  return count === 1 ? t('dashboard.history.summarySingular') : t('dashboard.history.summaryPlural').replace('{count}', String(count));
}

function deliveryLabel(status: DigestSummary['deliveryStatus']): string {
  return t(`dashboard.history.deliveryStatus.${status}`);
}

function analysisWindowLabel(item: DigestSummary): string {
  return t('dashboard.history.analysisWindow')
    .replace('{from}', formatDateTime(item.window.from))
    .replace('{to}', formatDateTime(item.window.to));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: 'UTC' }).format(date).replace('.', '');
  const year = new Intl.DateTimeFormat('es-ES', { year: 'numeric', timeZone: 'UTC' }).format(date);
  const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date);
  return `${day} ${month} ${year}, ${time}`;
}
