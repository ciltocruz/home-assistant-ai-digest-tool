import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DigestJob,
  DigestJobRetryPolicy,
  DigestJobStore,
  EnqueueDigestJobInput,
  EnqueueResult
} from '../../domain/jobs.js';

type Clock = { now(): Date };
const DEFAULT_RETRY_POLICY: DigestJobRetryPolicy = {
  maxAttempts: 3,
  baseDelaySeconds: 60,
  backoffMultiplier: 2
};

type JobRow = {
  id: string;
  trigger_window_id: string;
  kind: DigestJob['kind'];
  status: DigestJob['status'];
  attempts: number;
  available_at: string;
  lease_until: string | null;
  last_error: string | null;
  stage: DigestJob['stage'];
  error_code: string | null;
  error_message: string | null;
  report_id: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

export class SQLiteDigestJobStore implements DigestJobStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly retryPolicy: DigestJobRetryPolicy = DEFAULT_RETRY_POLICY
  ) {}

  async enqueue(input: EnqueueDigestJobInput): Promise<EnqueueResult> {
    const existing = this.db
      .prepare('select id from digest_jobs where trigger_window_id = ?')
      .get(input.triggerWindowId) as { id: string } | undefined;
    if (existing) return { status: 'already_queued', jobId: existing.id };

    const id = randomUUID();
    const now = this.nowIso();
    try {
      this.db
        .prepare(
           `insert into digest_jobs(id, trigger_window_id, kind, status, stage, attempts, retry_count, available_at, settings_snapshot_json, created_at, updated_at)
            values (@id, @triggerWindowId, @kind, 'queued', 'queued', 0, 0, @now, @settingsSnapshot, @now, @now)`
        )
        .run({ id, triggerWindowId: input.triggerWindowId, kind: input.kind, now, settingsSnapshot: input.settingsSnapshot ? JSON.stringify(input.settingsSnapshot) : null });
      return { status: 'queued', jobId: id };
    } catch (error) {
      const duplicate = this.db
        .prepare('select id from digest_jobs where trigger_window_id = ?')
        .get(input.triggerWindowId) as { id: string } | undefined;
      if (duplicate) return { status: 'already_queued', jobId: duplicate.id };
      throw error;
    }
  }

  async leaseNext(options: { leaseSeconds?: number } = {}): Promise<DigestJob | null> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + (options.leaseSeconds ?? 300) * 1000).toISOString();
    const row = this.db
      .prepare(
        `update digest_jobs
         set status = 'running', lease_until = @leaseUntil, updated_at = @now
         where id = (
           select id from digest_jobs
           where (status = 'queued' and available_at <= @now)
              or (status = 'running' and lease_until is not null and lease_until <= @now)
           order by created_at asc
           limit 1
         )
         returning *`
      )
      .get({ now: nowIso, leaseUntil }) as JobRow | undefined;
    if (!row) return null;

    return mapRow(row);
  }

  async get(id: string): Promise<DigestJob | null> {
    const row = this.db.prepare('select * from digest_jobs where id = ?').get(id) as JobRow | undefined;
    return row ? mapRow(row) : null;
  }

  async setStage(id: string, stage: Exclude<DigestJob['stage'], 'queued' | 'completed' | 'failed'>): Promise<void> {
    const result = this.db.prepare('update digest_jobs set stage = ?, updated_at = ? where id = ? and status = ?').run(stage, this.nowIso(), id, 'running');
    if (result.changes !== 1) throw new Error('Digest job is not running');
  }

  async complete(id: string, reportId?: string): Promise<void> {
    const result = this.db.prepare('update digest_jobs set status = ?, stage = ?, report_id = ?, lease_until = null, updated_at = ? where id = ?').run('completed', 'completed', reportId ?? null, this.nowIso(), id);
    if (result.changes !== 1) throw new Error('Digest job not found');
  }

  async fail(id: string, errorCode: string, errorMessage: string): Promise<void> {
    const result = this.db.prepare('update digest_jobs set status = ?, stage = ?, attempts = attempts + 1, error_code = ?, error_message = ?, lease_until = null, updated_at = ? where id = ?').run('failed', 'failed', errorCode, errorMessage, this.nowIso(), id);
    if (result.changes !== 1) throw new Error('Digest job not found');
  }

  async retryFailed(id: string): Promise<DigestJob | null> {
    const current = await this.get(id);
    if (!current || current.status !== 'failed' || current.retryCount >= 1) return current;
    const result = this.db.prepare('update digest_jobs set status = ?, stage = ?, retry_count = retry_count + 1, error_code = null, error_message = null, available_at = ?, updated_at = ? where id = ? and status = ? and retry_count = 0').run('queued', 'queued', this.nowIso(), this.nowIso(), id, 'failed');
    if (result.changes !== 1) return this.get(id);
    return this.get(id);
  }

  async retry(id: string, reason: string): Promise<void> {
    const current = this.db.prepare('select attempts from digest_jobs where id = ?').get(id) as { attempts: number } | undefined;
    if (!current) throw new Error('Digest job not found');

    const attempts = current.attempts + 1;
    const exhausted = attempts >= this.retryPolicy.maxAttempts;
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const availableAt = exhausted ? nowIso : this.nextAvailableAt(now, attempts);

    const result = this.db
      .prepare(
        `update digest_jobs
         set status = @status,
              attempts = @attempts,
              stage = @stage,
             available_at = @availableAt,
             lease_until = null,
             last_error = @reason,
             updated_at = @now
          where id = @id`
      )
       .run({ id, reason, attempts, availableAt, now: nowIso, status: exhausted ? 'failed' : 'queued', stage: exhausted ? 'failed' : 'queued' });
    if (result.changes !== 1) throw new Error('Digest job not found');
  }

  private nextAvailableAt(now: Date, attempts: number): string {
    const delaySeconds = this.retryPolicy.baseDelaySeconds * this.retryPolicy.backoffMultiplier ** (attempts - 1);
    return new Date(now.getTime() + delaySeconds * 1000).toISOString();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

function mapRow(row: JobRow): DigestJob {
  return {
    id: row.id,
    triggerWindowId: row.trigger_window_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    attempts: row.attempts,
    retryCount: row.retry_count,
    availableAt: row.available_at,
    leaseUntil: row.lease_until ?? undefined,
    lastError: row.last_error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    reportId: row.report_id ?? undefined,
    retryAvailable: row.status === 'failed' && row.retry_count < 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
