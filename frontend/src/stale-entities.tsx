import { useEffect, useState, useMemo } from 'react';
import type { EntityIssueDto, StaleEntitiesResponse } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { currentLocale, t } from './i18n/index.js';

export type StaleEntitiesApi = {
  getStaleEntities(): Promise<StaleEntitiesResponse>;
};

export type FilterTab = 'all' | 'unavailable' | 'stale';

export function formatRelativeTime(isoString: string, now: Date = new Date(), locale: string = currentLocale()): string {
  const timestamp = new Date(isoString).getTime();
  if (isNaN(timestamp)) return isoString;

  const diffMs = Math.max(0, now.getTime() - timestamp);
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (locale === 'es') {
    if (diffDays >= 1) {
      return `hace ${diffDays} ${diffDays === 1 ? 'día' : 'días'}`;
    }
    if (diffHours >= 1) {
      return `hace ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
    }
    const mins = Math.max(1, diffMins);
    return `hace ${mins} ${mins === 1 ? 'minuto' : 'minutos'}`;
  } else {
    if (diffDays >= 1) {
      return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
    }
    if (diffHours >= 1) {
      return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    }
    const mins = Math.max(1, diffMins);
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  }
}

export function formatDomainName(domain: string): string {
  return domain
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function StaleEntitiesCard({ api, refreshKey = 0 }: { api?: StaleEntitiesApi; refreshKey?: number }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unavailable'>(
    api ? 'loading' : 'unavailable'
  );
  const [data, setData] = useState<StaleEntitiesResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadData = async (isManualRefresh = false) => {
    if (!api) {
      setStatus('unavailable');
      return;
    }
    if (isManualRefresh) {
      setIsRefreshing(true);
    } else {
      setStatus('loading');
    }
    setErrorMsg(null);

    try {
      const response = await api.getStaleEntities();
      setData(response);
      setStatus('ready');
    } catch (err) {
      const msg =
        err instanceof ApiClientError || err instanceof Error
          ? redactSensitiveText(err.message)
          : t('dashboard.staleEntities.error');
      setErrorMsg(msg);
      if (!data) {
        setStatus('error');
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [api, refreshKey]);

  const uniqueDomains = useMemo(() => {
    if (!data?.entities) return [];
    const set = new Set<string>();
    for (const item of data.entities) {
      set.add(item.domain);
    }
    return Array.from(set).sort();
  }, [data]);

  const filteredEntities = useMemo(() => {
    if (!data?.entities) return [];
    return data.entities.filter((entity: EntityIssueDto) => {
      if (filterTab === 'unavailable' && entity.issueType !== 'unavailable') return false;
      if (filterTab === 'stale' && entity.issueType !== 'stale') return false;
      if (selectedDomain && entity.domain.toLowerCase() !== selectedDomain.toLowerCase()) return false;
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchesName = entity.name.toLowerCase().includes(q);
        const matchesId = entity.entityId.toLowerCase().includes(q);
        const matchesDomain = entity.domain.toLowerCase().includes(q);
        if (!matchesName && !matchesId && !matchesDomain) return false;
      }
      return true;
    });
  }, [data, filterTab, selectedDomain, search]);

  if (status === 'unavailable') {
    return null;
  }

  return (
    <section className="panel stale-entities-card" aria-labelledby="stale-entities-title">
      <div className="stale-card-header">
        <div>
          <h2 id="stale-entities-title" className="stale-card-title">
            {t('dashboard.staleEntities.title')}
          </h2>
          <p className="stale-card-subtitle">{t('dashboard.staleEntities.subtitle')}</p>
        </div>
        <button
          type="button"
          className="stale-refresh-button"
          disabled={isRefreshing || status === 'loading'}
          onClick={() => void loadData(true)}
        >
          {isRefreshing ? t('dashboard.staleEntities.loading') : t('dashboard.staleEntities.refresh')}
        </button>
      </div>

      {status === 'loading' && !data && (
        <p className="stale-loading-text">{t('dashboard.staleEntities.loading')}</p>
      )}

      {status === 'error' && !data && (
        <div className="stale-error-box" role="alert">
          <p>{errorMsg || t('dashboard.staleEntities.error')}</p>
          <button type="button" onClick={() => void loadData(false)}>
            {t('dashboard.staleEntities.refresh')}
          </button>
        </div>
      )}

      {data && (
        <>
          <div className="stale-summary-badges">
            <span className="stale-badge stale-badge--unavailable">
              <strong>{data.unavailableCount}</strong> {t('dashboard.staleEntities.unavailable')}
            </span>
            <span className="stale-badge stale-badge--stale">
              <strong>{data.staleCount}</strong> {t('dashboard.staleEntities.stale')}
            </span>
            <span className="stale-badge stale-badge--audited">
              <strong>{data.totalAudited}</strong> {t('dashboard.staleEntities.audited')}
            </span>
          </div>

          <div className="stale-filters">
            <div className="stale-filter-tabs" role="tablist" aria-label={t('dashboard.staleEntities.title')}>
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'all'}
                className={`stale-tab${filterTab === 'all' ? ' stale-tab--active' : ''}`}
                onClick={() => setFilterTab('all')}
              >
                {t('dashboard.staleEntities.all')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'unavailable'}
                className={`stale-tab${filterTab === 'unavailable' ? ' stale-tab--active' : ''}`}
                onClick={() => setFilterTab('unavailable')}
              >
                {t('dashboard.staleEntities.unavailable')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'stale'}
                className={`stale-tab${filterTab === 'stale' ? ' stale-tab--active' : ''}`}
                onClick={() => setFilterTab('stale')}
              >
                {t('dashboard.staleEntities.stale')}
              </button>
            </div>

            <div className="stale-search-container">
              <input
                type="search"
                className="stale-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dashboard.staleEntities.searchPlaceholder')}
                aria-label={t('dashboard.staleEntities.searchPlaceholder')}
              />
            </div>
          </div>

          {uniqueDomains.length > 0 && (
            <div className="stale-domain-badges">
              {uniqueDomains.map((domain) => (
                <button
                  key={domain}
                  type="button"
                  className={`stale-domain-chip${selectedDomain === domain ? ' stale-domain-chip--active' : ''}`}
                  onClick={() => setSelectedDomain(selectedDomain === domain ? null : domain)}
                >
                  {formatDomainName(domain)}
                </button>
              ))}
            </div>
          )}

          {data.entities.length === 0 ? (
            <div className="stale-empty-state">
              <p>{t('dashboard.staleEntities.noIssues')}</p>
            </div>
          ) : filteredEntities.length === 0 ? (
            <div className="stale-empty-state">
              <p>Sin resultados para el filtro seleccionado.</p>
            </div>
          ) : (
            <ul className="stale-entity-list">
              {filteredEntities.map((entity) => (
                <li key={entity.entityId} className="stale-entity-item">
                  <div className="stale-entity-header">
                    <span className={`stale-status-badge stale-status-badge--${entity.issueType}`}>
                      {entity.issueType === 'unavailable'
                        ? t('dashboard.staleEntities.unavailable')
                        : t('dashboard.staleEntities.stale')}
                    </span>
                    <span className="stale-domain-tag">{formatDomainName(entity.domain)}</span>
                  </div>
                  <div className="stale-entity-info">
                    <span className="stale-entity-name">{entity.name || entity.entityId}</span>
                    <span className="stale-entity-id">{entity.entityId}</span>
                  </div>
                  <div className="stale-entity-time">
                    <span>{formatRelativeTime(entity.lastUpdated)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
