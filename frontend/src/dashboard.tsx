import { useEffect, useState, type ReactNode } from 'react';
import { type DigestHistoryResponse, type DigestSummary } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { t } from './i18n/index.js';
import { formatDateTime } from './date-time.js';

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

export function Dashboard({ api, state: initialState, activeReport, refreshKey = 0, timeZone }: { api?: DashboardApi; state?: DashboardHistoryState; activeReport: ReactNode; refreshKey?: number; timeZone?: string }) {
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
    <div className="dashboard-header-row">
      <h1 className="dashboard-title">{t('shell.dashboard')}</h1>
    </div>
    <section className="panel dashboard-state hero-status-banner" data-dashboard-section="current-state" aria-live="polite">
      <p className="eyebrow">{t('dashboard.currentState.eyebrow')}</p>
      {renderCurrentState(state, () => setRetryKey((value) => value + 1))}
    </section>
    <section className="dashboard-active-report" data-dashboard-section="active-report" aria-labelledby="active-report-title">
      <h2 id="active-report-title">{t('dashboard.activeReport.title')}</h2>
      {activeReport}
    </section>
    <div className="dashboard-main-grid">
      <section className="panel dashboard-latest-report" data-dashboard-section="latest-report" aria-labelledby="latest-report-title">
        <p className="eyebrow">{t('dashboard.latestReport.eyebrow')}</p>
        <h2 id="latest-report-title">{t('dashboard.latestReport.title')}</h2>
        {renderLatestReport(state, timeZone)}
      </section>
      <section className="panel dashboard-history-preview" data-dashboard-section="history-preview" aria-labelledby="history-preview-title">
        <p className="eyebrow">{t('dashboard.historyPreview.eyebrow')}</p>
        <h2 id="history-preview-title">{t('dashboard.historyPreview.title')}</h2>
        {renderHistoryPreview(state, timeZone)}
      </section>
    </div>
  </section>;
}

export function DashboardHistory({ api, state: initialState, refreshKey = 0, headingLevel = 'h1', timeZone }: { api?: DashboardApi; state?: DashboardHistoryState; refreshKey?: number; headingLevel?: 'h1' | 'h2'; timeZone?: string }) {
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
      {renderHistoryState(state, () => setRetryKey((value) => value + 1), timeZone)}
    </article>
  );
}

function renderHistoryState(state: DashboardHistoryState, onRetry: () => void, timeZone?: string) {
  if (state.status === 'loading') return <><h2>{t('dashboard.history.loading.title')}</h2><p>{t('dashboard.history.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.history.error.title')}</h2><p>{t('dashboard.history.error.copy')}</p><p className="muted-copy">{state.message}</p><button type="button" onClick={onRetry}>{t('dashboard.history.error.action')}</button></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.history.unavailable.title')}</h2><p>{t('dashboard.history.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.history.empty.title')}</h2><p>{t('dashboard.history.empty.copy')}</p></>;

  return <>
    <p>{summaryLabel(state.items.length)}</p>
    <ul className="history-list">
      {state.items.map((item) => <HistoryItem key={item.id} item={item} timeZone={timeZone} />)}
    </ul>
  </>;
}

function renderCurrentState(state: DashboardHistoryState, onRetry: () => void) {
  if (state.status === 'loading') return <><h2>{t('dashboard.currentState.loading.title')}</h2><p>{t('dashboard.currentState.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.currentState.error.title')}</h2><p>{t('dashboard.currentState.error.copy')}</p><button type="button" onClick={onRetry}>{t('dashboard.currentState.error.action')}</button></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.currentState.unavailable.title')}</h2><p>{t('dashboard.currentState.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.currentState.empty.title')}</h2><p>{t('dashboard.currentState.empty.copy')}</p></>;

  const latest = state.items[0];
  const attentionCount = latest ? (latest.severityCounts.critical + latest.severityCounts.warning) : 0;
  const isHealthy = attentionCount === 0;

  return <>
    <h2>{t('dashboard.currentState.ready.title')}</h2>
    <p>{attentionCount === 0 ? t('dashboard.currentState.ready.clear') : t('dashboard.currentState.ready.attention').replace('{count}', String(attentionCount))}</p>
    {latest ? <div className="dashboard-kpi-grid">
      <div className={`kpi-card kpi-card--health ${isHealthy ? 'kpi-card--ok' : 'kpi-card--attention'}`}>
        <div className="kpi-header"><span className="kpi-dot" /><span className="kpi-label">Salud del Sistema</span></div>
        <div className="kpi-value">{isHealthy ? 'Saludable' : 'Atención'}</div>
        <div className="kpi-subtext">{isHealthy ? 'Sin incidencias' : `${attentionCount} avisos`}</div>
      </div>
      <div className="kpi-card kpi-card--severity">
        <div className="kpi-header"><span className="kpi-label">Severidad</span></div>
        <div className="kpi-value">{latest.severityCounts.critical} / {latest.severityCounts.warning}</div>
        <div className="kpi-subtext">Críticas / Avisos</div>
      </div>
      <div className="kpi-card kpi-card--ai">
        <div className="kpi-header"><span className="kpi-label">Proveedor IA</span></div>
        <div className="kpi-value">Gemini</div>
        <div className="kpi-subtext">Análisis Activo</div>
      </div>
      <div className="kpi-card kpi-card--telegram">
        <div className="kpi-header"><span className="kpi-label">Telegram</span></div>
        <div className="kpi-value">{latest.deliveryStatus === 'sent' ? 'Enviado' : 'Pendiente'}</div>
        <div className="kpi-subtext">Notificaciones</div>
      </div>
    </div> : null}
  </>;
}

function renderLatestReport(state: DashboardHistoryState, timeZone?: string) {
  if (state.status === 'ready') return <ul className="history-list history-list--latest"><HistoryItem item={state.items[0]} variant="latest" timeZone={timeZone} /></ul>;
  if (state.status === 'error') return <><p>{t('dashboard.latestReport.error.copy')}</p><a className="report-link" href="/reports">{t('dashboard.latestReport.error.action')}</a></>;
  if (state.status === 'loading') return <p>{t('dashboard.latestReport.loading')}</p>;
  return <><p>{t('dashboard.latestReport.empty.copy')}</p><a className="report-link" href="/reports">{t('dashboard.latestReport.empty.action')}</a></>;
}

function renderHistoryPreview(state: DashboardHistoryState, timeZone?: string) {
  if (state.status === 'ready' && state.items.length > 1) {
    const previewItems = state.items.slice(1, 4);
    return <><p>{t('dashboard.historyPreview.summary').replace('{count}', String(previewItems.length))}</p><ul className="history-list">{previewItems.map((item) => <HistoryItem key={item.id} item={item} timeZone={timeZone} />)}</ul><a className="report-link" href="/reports">{t('dashboard.historyPreview.action')}</a></>;
  }
  if (state.status === 'loading') return <p>{t('dashboard.historyPreview.loading')}</p>;
  if (state.status === 'error') return <><p>{t('dashboard.historyPreview.error.copy')}</p><a className="report-link" href="/reports">{t('dashboard.historyPreview.error.action')}</a></>;
  return <><p>{t('dashboard.historyPreview.empty.copy')}</p><a className="report-link" href="/reports">{t('dashboard.historyPreview.empty.action')}</a></>;
}

function HistoryItem({ item, variant = 'history', timeZone }: { item: DigestSummary; variant?: 'history' | 'latest'; timeZone?: string }) {
  const createdAt = formatDateTime(item.createdAt, timeZone);
  const source = item.source ?? 'legacy';
  return <li className={`history-item${variant === 'latest' ? ' history-item--latest' : ''}`}>
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
