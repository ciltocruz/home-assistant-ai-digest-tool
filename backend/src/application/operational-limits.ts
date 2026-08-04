export type OperationalLimits = {
  pollIntervalMs: number;
  maxStoredReports: number;
  maxConcurrentJobs: number;
};

export type OperationalDecision =
  | { status: 'allowed' }
  | { status: 'delayed'; reason: 'poll_interval_limit' | 'concurrency_limit'; retryAtMs?: number }
  | { status: 'skipped'; reason: 'storage_limit' };

export class OperationalLimiter {
  private lastPollAtMs: number | undefined;

  constructor(private readonly limits: OperationalLimits) {}

  admitPoll(nowMs: number): OperationalDecision {
    if (this.lastPollAtMs !== undefined) {
      const retryAtMs = this.lastPollAtMs + this.limits.pollIntervalMs;
      if (nowMs < retryAtMs) return { status: 'delayed', reason: 'poll_interval_limit', retryAtMs };
    }

    this.lastPollAtMs = nowMs;
    return { status: 'allowed' };
  }

  admitWork(input: { storedReports: number; activeJobs: number }): OperationalDecision {
    if (input.storedReports >= this.limits.maxStoredReports) return { status: 'skipped', reason: 'storage_limit' };
    if (input.activeJobs >= this.limits.maxConcurrentJobs) return { status: 'delayed', reason: 'concurrency_limit' };
    return { status: 'allowed' };
  }
}
