import { useEffect, useState } from 'react';
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

export function DashboardHistory({ api, state: initialState }: { api?: DashboardApi; state?: DashboardHistoryState }) {
  const [state, setState] = useState<DashboardHistoryState>(initialState ?? (api ? { status: 'loading' } : { status: 'unavailable' }));

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
  }, [api, initialState]);

  return (
    <article className="panel history-panel" aria-live="polite">
      <p className="eyebrow">{t('dashboard.history.eyebrow')}</p>
      {renderHistoryState(state)}
    </article>
  );
}

function renderHistoryState(state: DashboardHistoryState) {
  if (state.status === 'loading') return <><h2>{t('dashboard.history.loading.title')}</h2><p>{t('dashboard.history.loading.copy')}</p></>;
  if (state.status === 'error') return <><h2>{t('dashboard.history.error.title')}</h2><p>{t('dashboard.history.error.copy')}</p><p className="muted-copy">{state.message}</p></>;
  if (state.status === 'unavailable') return <><h2>{t('dashboard.history.unavailable.title')}</h2><p>{t('dashboard.history.unavailable.copy')}</p></>;
  if (state.status === 'empty') return <><h2>{t('dashboard.history.empty.title')}</h2><p>{t('dashboard.history.empty.copy')}</p></>;

  return <>
    <h2>{summaryLabel(state.items.length)}</h2>
    <ul className="history-list">
      {state.items.map((item) => <HistoryItem key={item.id} item={item} />)}
    </ul>
  </>;
}

function HistoryItem({ item }: { item: DigestSummary }) {
  return <li className="history-item">
    <span>{formatDateTime(item.createdAt)}</span>
    <span className="muted-copy">{analysisWindowLabel(item)}</span>
    <strong>{deliveryLabel(item.deliveryStatus)}</strong>
    <div className="severity-strip" aria-label={t('dashboard.history.severityAriaLabel')}>
      <span>{t('dashboard.history.severity.critical')} {item.severityCounts.critical}</span>
      <span>{t('dashboard.history.severity.warning')} {item.severityCounts.warning}</span>
      <span>{t('dashboard.history.severity.info')} {item.severityCounts.info}</span>
    </div>
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
