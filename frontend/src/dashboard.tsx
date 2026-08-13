import { useEffect, useState, type ReactNode } from 'react';
import { type DigestHistoryResponse, type DigestSummary } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { currentLocale, t } from './i18n/index.js';

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

export function DashboardHistory({ api, state: initialState, refreshKey = 0, headingLevel = 'h1' }: { api?: DashboardApi; state?: DashboardHistoryState; refreshKey?: number; headingLevel?: 'h1' | 'h2' }) {
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

  const Heading = headingLevel;
  return (
    <article className="panel history-panel" aria-live="polite">
      <p className="eyebrow">{t('dashboard.history.eyebrow')}</p>
      <Heading>{t('shell.reports')}</Heading>
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
  if (state.status === 'ready') return <ul className="history-list history-list--latest"><HistoryItem item={state.items[0]} variant="latest" /></ul>;
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

function HistoryItem({ item, variant = 'history' }: { item: DigestSummary; variant?: 'history' | 'latest' }) {
  const createdAt = formatDateTime(item.createdAt);
  const source = item.source ?? 'legacy';
  return <li className={`history-item${variant === 'latest' ? ' history-item--latest' : ''}`}>
    <a className="history-link" href={`/reports/${encodeURIComponent(item.id)}`} aria-label={t('dashboard.history.openReport').replace('{time}', createdAt)}>
      <div className="history-primary">
        <div><span className="history-field-label">{t('dashboard.history.fields.date')}</span><time dateTime={item.createdAt}>{createdAt}</time></div>
        <span className="muted-copy">{analysisWindowLabel(item)}</span>
      </div>
      <dl className="history-facts">
        <div className="history-fact history-fact--source"><dt>{t('dashboard.history.fields.source')}</dt><dd><span className={`history-source-badge history-source-badge--${source}`}>{sourceLabel(source)}</span></dd></div>
        <div className="history-fact history-fact--report"><dt>{t('dashboard.history.fields.reportResult')}</dt><dd>{reportResultLabel(item)}</dd></div>
        <div className="history-fact history-fact--analysis"><dt>{t('dashboard.history.fields.aiAnalysis')}</dt><dd>{aiAnalysisLabel(item)}</dd></div>
        <div className="history-fact history-fact--notification"><dt>{t('dashboard.history.fields.notification')}</dt><dd>{deliveryLabel(item.deliveryStatus)}</dd></div>
      </dl>
      <div className="history-statuses" aria-label={`${t('dashboard.history.fields.reportResult')}; ${t('dashboard.history.fields.notification')}`}>
        <span className={`outcome-badge outcome-badge--${reportResultKind(item)}`}>{reportResultLabel(item)}</span>
        <span className={`outcome-badge outcome-badge--notification-${item.deliveryStatus}`}>{deliveryLabel(item.deliveryStatus)}</span>
      </div>
      <div className="severity-strip" aria-label={t('dashboard.history.severityAriaLabel')}>
        <span className="severity-chip severity-chip--critical">{t('dashboard.history.severity.critical')} {item.severityCounts.critical}</span>
        <span className="severity-chip severity-chip--warning">{t('dashboard.history.severity.warning')} {item.severityCounts.warning}</span>
        <span className="severity-chip severity-chip--info">{t('dashboard.history.severity.info')} {item.severityCounts.info}</span>
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

function analysisWindowLabel(item: DigestSummary): string {
  return t('dashboard.history.analysisWindow')
    .replace('{from}', formatDateTime(item.window.from))
    .replace('{to}', formatDateTime(item.window.to));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  const locale = currentLocale() === 'es' ? 'es-ES' : 'en-GB';
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date).replace('.', '');
  const year = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(date);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date);
  return `${day} ${month} ${year}, ${time}`;
}
