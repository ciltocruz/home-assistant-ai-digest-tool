import { useEffect, useState, useMemo } from 'react';
import type { EntityIssueDto, StaleEntitiesResponse } from '@ha-digest/shared';
import { ApiClientError, redactSensitiveText } from './api-client.js';
import { currentLocale, t } from './i18n/index.js';

export type AuditPageApi = {
  getStaleEntities(): Promise<StaleEntitiesResponse>;
};

type FilterTab = 'all' | 'unavailable' | 'stale';
type ViewMode = 'flat' | 'grouped';
type PageSize = 20 | 50 | 100;

export function formatRelativeTimeAudit(isoString: string, now: Date = new Date(), locale: string = currentLocale()): string {
  const timestamp = new Date(isoString).getTime();
  if (isNaN(timestamp)) return isoString;
  const diffMs = Math.max(0, now.getTime() - timestamp);
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (locale === 'es') {
    if (diffDays >= 1) return `hace ${diffDays} ${diffDays === 1 ? 'día' : 'días'}`;
    if (diffHours >= 1) return `hace ${diffHours} ${diffHours === 1 ? 'hora' : 'horas'}`;
    const mins = Math.max(1, diffMins);
    return `hace ${mins} ${mins === 1 ? 'minuto' : 'minutos'}`;
  } else {
    if (diffDays >= 1) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`;
    if (diffHours >= 1) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
    const mins = Math.max(1, diffMins);
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  }
}

export function formatDomainNameAudit(domain: string): string {
  return domain.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function AuditPage({ api }: { api?: AuditPageApi }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unavailable'>(api ? 'loading' : 'unavailable');
  const [data, setData] = useState<StaleEntitiesResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filters
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('flat');

  // Pagination
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(20);

  const loadData = async (isManualRefresh = false) => {
    if (!api) { setStatus('unavailable'); return; }
    if (isManualRefresh) { setIsRefreshing(true); } else { setStatus('loading'); }
    setErrorMsg(null);
    try {
      const response = await api.getStaleEntities();
      setData(response);
      setStatus('ready');
      setPage(0);
    } catch (err) {
      const msg = err instanceof ApiClientError || err instanceof Error
        ? redactSensitiveText(err.message)
        : t('dashboard.staleEntities.error');
      setErrorMsg(msg);
      if (!data) setStatus('error');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => { void loadData(); }, [api]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [filterTab, selectedDomain, search, pageSize]);

  const uniqueDomains = useMemo(() => {
    if (!data?.entities) return [];
    const set = new Set<string>();
    for (const item of data.entities) set.add(item.domain);
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
        if (!entity.name.toLowerCase().includes(q) && !entity.entityId.toLowerCase().includes(q) && !entity.domain.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [data, filterTab, selectedDomain, search]);

  // Paginated slice (flat mode)
  const totalPages = Math.max(1, Math.ceil(filteredEntities.length / pageSize));
  const pagedEntities = filteredEntities.slice(page * pageSize, (page + 1) * pageSize);

  // Grouped view: group filteredEntities by domain
  const groupedByDomain = useMemo(() => {
    if (viewMode !== 'grouped') return null;
    const map = new Map<string, EntityIssueDto[]>();
    for (const entity of filteredEntities) {
      const existing = map.get(entity.domain) ?? [];
      existing.push(entity);
      map.set(entity.domain, existing);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredEntities, viewMode]);

  if (status === 'unavailable') {
    return (
      <section className="audit-page" aria-label={t('shell.audit')}>
        <h1 className="audit-page-title">{t('shell.audit')}</h1>
        <p className="muted-copy">{t('dashboard.staleEntities.unavailableCopy')}</p>
      </section>
    );
  }

  return (
    <section className="audit-page" aria-labelledby="audit-page-title">
      <div className="audit-page-header">
        <div>
          <p className="eyebrow">{t('dashboard.staleEntities.eyebrow')}</p>
          <h1 id="audit-page-title" className="audit-page-title">{t('shell.audit')}</h1>
          <p className="audit-page-subtitle">{t('dashboard.staleEntities.subtitle')}</p>
        </div>
        <button
          type="button"
          className="stale-refresh-button"
          disabled={isRefreshing || status === 'loading'}
          onClick={() => void loadData(true)}
          id="audit-refresh-btn"
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
          <button type="button" onClick={() => void loadData(false)}>{t('dashboard.staleEntities.refresh')}</button>
        </div>
      )}

      {data && (
        <>
          {/* Summary badges */}
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

          {/* Filters row */}
          <div className="stale-filters">
            <div className="stale-filter-tabs" role="tablist" aria-label={t('shell.audit')}>
              {(['all', 'unavailable', 'stale'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`audit-tab-${tab}`}
                  aria-selected={filterTab === tab}
                  className={`stale-tab${filterTab === tab ? ' stale-tab--active' : ''}`}
                  onClick={() => setFilterTab(tab)}
                >
                  {tab === 'all' ? t('dashboard.staleEntities.all') : tab === 'unavailable' ? t('dashboard.staleEntities.unavailable') : t('dashboard.staleEntities.stale')}
                </button>
              ))}
            </div>

            <div className="audit-view-toggle">
              <button
                type="button"
                id="audit-view-flat"
                className={`stale-tab${viewMode === 'flat' ? ' stale-tab--active' : ''}`}
                onClick={() => setViewMode('flat')}
              >
                {t('audit.viewFlat')}
              </button>
              <button
                type="button"
                id="audit-view-grouped"
                className={`stale-tab${viewMode === 'grouped' ? ' stale-tab--active' : ''}`}
                onClick={() => setViewMode('grouped')}
              >
                {t('audit.viewGrouped')}
              </button>
            </div>

            <div className="stale-search-container">
              <input
                type="search"
                id="audit-search"
                className="stale-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dashboard.staleEntities.searchPlaceholder')}
                aria-label={t('dashboard.staleEntities.searchPlaceholder')}
              />
            </div>
          </div>

          {/* Domain chips */}
          {uniqueDomains.length > 0 && (
            <div className="stale-domain-badges">
              {uniqueDomains.map((domain) => (
                <button
                  key={domain}
                  type="button"
                  className={`stale-domain-chip${selectedDomain === domain ? ' stale-domain-chip--active' : ''}`}
                  onClick={() => setSelectedDomain(selectedDomain === domain ? null : domain)}
                >
                  {formatDomainNameAudit(domain)}
                </button>
              ))}
            </div>
          )}

          {/* Results count + page size selector */}
          <div className="audit-results-bar">
            <span className="audit-results-count">
              {t('audit.showing')
                .replace('{shown}', String(viewMode === 'flat' ? pagedEntities.length : filteredEntities.length))
                .replace('{total}', String(filteredEntities.length))}
            </span>
            {viewMode === 'flat' && (
              <div className="audit-page-size">
                <label htmlFor="audit-page-size-select">{t('audit.perPage')}</label>
                <select
                  id="audit-page-size-select"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
                >
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            )}
          </div>

          {/* Main content */}
          {filteredEntities.length === 0 ? (
            <div className="stale-empty-state">
              <p>{data.entities.length === 0 ? t('dashboard.staleEntities.noIssues') : t('audit.noResults')}</p>
            </div>
          ) : viewMode === 'flat' ? (
            <>
              <ul className="stale-entity-list" aria-label={t('shell.audit')}>
                {pagedEntities.map((entity) => (
                  <EntityRow key={entity.entityId} entity={entity} />
                ))}
              </ul>
              {totalPages > 1 && (
                <nav className="audit-pagination" aria-label={t('audit.paginationLabel')}>
                  <button
                    type="button"
                    id="audit-prev-page"
                    className="audit-pagination-btn"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    ← {t('audit.prev')}
                  </button>
                  <span className="audit-pagination-info">
                    {t('audit.pageOf').replace('{page}', String(page + 1)).replace('{total}', String(totalPages))}
                  </span>
                  <button
                    type="button"
                    id="audit-next-page"
                    className="audit-pagination-btn"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    {t('audit.next')} →
                  </button>
                </nav>
              )}
            </>
          ) : (
            // Grouped view
            <div className="audit-grouped-list">
              {groupedByDomain?.map(([domain, entities]) => (
                <div key={domain} className="audit-domain-group">
                  <div className="audit-domain-group-header">
                    <h2 className="audit-domain-group-name">{formatDomainNameAudit(domain)}</h2>
                    <span className="audit-domain-group-count">{entities.length}</span>
                  </div>
                  <ul className="stale-entity-list">
                    {entities.map((entity) => (
                      <EntityRow key={entity.entityId} entity={entity} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EntityRow({ entity }: { entity: EntityIssueDto }) {
  return (
    <li className="stale-entity-item">
      <div className="stale-entity-header">
        <span className={`stale-status-badge stale-status-badge--${entity.issueType}`}>
          {entity.issueType === 'unavailable' ? 'unavailable' : 'stale'}
        </span>
        <span className="stale-domain-tag">{formatDomainNameAudit(entity.domain)}</span>
      </div>
      <div className="stale-entity-info">
        <span className="stale-entity-name">{entity.name || entity.entityId}</span>
        <span className="stale-entity-id">{entity.entityId}</span>
      </div>
      <div className="stale-entity-time">
        <span>{formatRelativeTimeAudit(entity.lastUpdated)}</span>
      </div>
    </li>
  );
}
