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
          `insert into digest_jobs(id, trigger_window_id, kind, status, attempts, available_at, created_at, updated_at)
           values (@id, @triggerWindowId, @kind, 'queued', 0, @now, @now, @now)`
        )
        .run({ id, triggerWindowId: input.triggerWindowId, kind: input.kind, now });
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

  async complete(id: string): Promise<void> {
    this.updateStatus(id, 'completed');
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
             available_at = @availableAt,
             lease_until = null,
             last_error = @reason,
             updated_at = @now
          where id = @id`
      )
      .run({ id, reason, attempts, availableAt, now: nowIso, status: exhausted ? 'failed' : 'queued' });
    if (result.changes !== 1) throw new Error('Digest job not found');
  }

  private nextAvailableAt(now: Date, attempts: number): string {
    const delaySeconds = this.retryPolicy.baseDelaySeconds * this.retryPolicy.backoffMultiplier ** (attempts - 1);
    return new Date(now.getTime() + delaySeconds * 1000).toISOString();
  }

  private updateStatus(id: string, status: DigestJob['status']): void {
    const result = this.db
      .prepare('update digest_jobs set status = ?, lease_until = null, updated_at = ? where id = ?')
      .run(status, this.nowIso(), id);
    if (result.changes !== 1) throw new Error('Digest job not found');
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
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseUntil: row.lease_until ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
