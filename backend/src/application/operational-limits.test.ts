import { describe, expect, it } from 'vitest';
import { OperationalLimiter } from './operational-limits.js';

describe('operational limits', () => {
  it('delays polling before the configured interval and permits it once the interval elapses', () => {
    const limiter = new OperationalLimiter({ pollIntervalMs: 60_000, maxStoredReports: 20, maxConcurrentJobs: 1 });

    expect(limiter.admitPoll(1_000)).toEqual({ status: 'allowed' });
    expect(limiter.admitPoll(30_000)).toEqual({ status: 'delayed', reason: 'poll_interval_limit', retryAtMs: 61_000 });
    expect(limiter.admitPoll(61_000)).toEqual({ status: 'allowed' });
  });

  it('skips work with a reason when storage or concurrency capacity is exhausted', () => {
    const limiter = new OperationalLimiter({ pollIntervalMs: 60_000, maxStoredReports: 2, maxConcurrentJobs: 1 });

    expect(limiter.admitWork({ storedReports: 2, activeJobs: 0 })).toEqual({ status: 'skipped', reason: 'storage_limit' });
    expect(limiter.admitWork({ storedReports: 1, activeJobs: 1 })).toEqual({ status: 'delayed', reason: 'concurrency_limit' });
    expect(limiter.admitWork({ storedReports: 1, activeJobs: 0 })).toEqual({ status: 'allowed' });
  });
});
