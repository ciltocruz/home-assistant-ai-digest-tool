import { useEffect, useRef, useState } from 'react';
import type { DigestJobStatus } from '@ha-digest/shared';
import { redactSensitiveText } from './api-client.js';
import { t } from './i18n/index.js';

const ACTIVE_JOBS_STORAGE_KEY = 'ha-digest.active-jobs';

export type JobLifecycleApi = {
  getDigestJob(id: string): Promise<DigestJobStatus>;
  retryDigestJob(id: string): Promise<DigestJobStatus>;
};

export function rememberActiveJob(jobId: string): string[] {
  const ids = uniqueIds([...restoreActiveJobIds(), jobId]);
  writeActiveJobIds(ids);
  return ids;
}

export function forgetActiveJob(jobId: string): string[] {
  const ids = restoreActiveJobIds().filter((id) => id !== jobId);
  writeActiveJobIds(ids);
  return ids;
}

export function restoreActiveJobIds(): string[] {
  try {
    const stored = globalThis.sessionStorage?.getItem(ACTIVE_JOBS_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? uniqueIds(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)) : [];
  } catch {
    return [];
  }
}

export function JobLifecycle({ api, jobIds, onCompleted, pollIntervalMs = 4_000 }: {
  api?: JobLifecycleApi;
  jobIds: string[];
  onCompleted(jobId: string): void;
  pollIntervalMs?: number;
}) {
  const [jobs, setJobs] = useState<Record<string, DigestJobStatus>>({});
  const [retrying, setRetrying] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const jobsRef = useRef(jobs);
  const completedRef = useRef(new Set<string>());
  jobsRef.current = jobs;

  useEffect(() => {
    if (!api || jobIds.length === 0) return;
    let mounted = true;
    const applyJob = (job: DigestJobStatus) => {
      if (!mounted) return;
      setJobs((current) => ({ ...current, [job.id]: job }));
      if (job.status === 'completed' && !completedRef.current.has(job.id)) {
        completedRef.current.add(job.id);
        forgetActiveJob(job.id);
        onCompleted(job.id);
      }
    };
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const activeIds = jobIds.filter((id) => {
        const job = jobsRef.current[id];
        return !job || job.status === 'queued' || job.status === 'running';
      });
      if (activeIds.length === 0) return;
      try {
        const nextJobs = await Promise.all(activeIds.map((id) => api.getDigestJob(id)));
        nextJobs.forEach(applyJob);
        if (mounted) setLoadError(null);
      } catch {
        if (mounted) setLoadError(t('dashboard.jobLifecycle.loadError'));
      }
    };
    const handleVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, pollIntervalMs);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [api, jobIds.join('|'), onCompleted, pollIntervalMs, refreshKey]);

  async function retry(jobId: string) {
    if (!api || retrying) return;
    setRetrying(jobId);
    setLoadError(null);
    setActionError(null);
    try {
      const job = await api.retryDigestJob(jobId);
      setJobs((current) => ({ ...current, [job.id]: job }));
      rememberActiveJob(job.id);
    } catch {
      setActionError(t('dashboard.jobLifecycle.retryError'));
    } finally {
      setRetrying(null);
    }
  }

  if (!api || jobIds.length === 0) return null;
  return <section className="job-lifecycle" aria-label={t('dashboard.jobLifecycle.ariaLabel')} aria-live="polite">
    {loadError ? <div className="panel error-copy" role="alert"><p>{loadError}</p><button type="button" onClick={() => setRefreshKey((value) => value + 1)}>{t('dashboard.jobLifecycle.retryLoad')}</button></div> : null}
    {actionError ? <p className="error-copy" role="alert">{actionError}</p> : null}
    {jobIds.map((id) => <JobStatusCard key={id} job={jobs[id]} retrying={retrying === id} onRetry={() => void retry(id)} />)}
  </section>;
}

function JobStatusCard({ job, retrying, onRetry }: { job?: DigestJobStatus; retrying: boolean; onRetry(): void }) {
  if (!job) return <article className="panel job-card"><h2>{t('dashboard.jobLifecycle.loadingTitle')}</h2><p>{t('dashboard.jobLifecycle.loadingCopy')}</p></article>;
  const isFailed = job.status === 'failed';
  const progress = progressForStage(job.stage);
  return <article className={`panel job-card job-card--${job.status}`}>
    <p className="eyebrow">{t(`dashboard.jobLifecycle.eyebrow.${job.status}`)}</p>
    <div className="job-card__heading">
      <h2>{statusLabel(job.status)}</h2>
      <span className="status-badge">{stageLabel(job.stage)}</span>
    </div>
    <p>{progressMessage(job.stage)}</p>
    <progress max="100" value={progress} aria-label={t('dashboard.jobLifecycle.progressLabel').replace('{stage}', stageLabel(job.stage))}>{progress}%</progress>
    <p className="muted-copy">{t('dashboard.jobLifecycle.lastUpdated').replace('{time}', formatDateTime(job.updatedAt))}</p>
    {isFailed && job.errorMessage ? <p className="error-copy" role="alert">{redactSensitiveText(job.errorMessage)}</p> : null}
    {job.status === 'completed' && job.reportId ? <a className="report-link" href={`/reports/${encodeURIComponent(job.reportId)}`}>{t('dashboard.jobLifecycle.viewReport')}</a> : null}
    {isFailed && job.retryAvailable ? <button type="button" disabled={retrying} onClick={onRetry}>{retrying ? t('dashboard.jobLifecycle.retrying') : t('dashboard.jobLifecycle.retry')}</button> : null}
  </article>;
}

function statusLabel(status: DigestJobStatus['status']): string { return t(`dashboard.jobLifecycle.status.${status}`); }
function stageLabel(stage: DigestJobStatus['stage']): string { return t(`dashboard.jobLifecycle.stage.${stage}`); }
function progressMessage(stage: DigestJobStatus['stage']): string { return t(`dashboard.jobLifecycle.message.${stage}`); }
function progressForStage(stage: DigestJobStatus['stage']): number {
  return ({ queued: 8, collecting: 25, detecting: 45, generating: 65, rendering: 78, saving: 90, completed: 100, failed: 100 })[stage];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function uniqueIds(ids: string[]): string[] { return [...new Set(ids)]; }
function writeActiveJobIds(ids: string[]): void {
  try { globalThis.sessionStorage?.setItem(ACTIVE_JOBS_STORAGE_KEY, JSON.stringify(ids)); } catch { /* Storage is optional; status remains server-authoritative. */ }
}
