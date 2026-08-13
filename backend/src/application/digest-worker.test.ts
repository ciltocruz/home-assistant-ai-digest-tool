import { describe, expect, it, vi } from 'vitest';
import { DigestWorker } from './digest-worker.js';

const job = {
  id: 'job-1', triggerWindowId: 'manual:2026-08-01', kind: 'manual' as const,
  status: 'running' as const, stage: 'queued' as const, attempts: 0, retryCount: 0, retryAvailable: false,
  availableAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z'
};

describe('DigestWorker', () => {
  it('persists every live-analysis stage and links the completed report', async () => {
    const stages: string[] = [];
    const lifecycle: unknown[] = [];
    const complete = vi.fn(async () => undefined);
    const worker = new DigestWorker({
      jobs: { leaseNext: async () => job, setStage: async (_id, stage) => { stages.push(stage); }, complete, fail: async () => undefined },
      eventReporter: (event) => { lifecycle.push(event); },
      analysis: { runWithStages: async (onStage) => {
        for (const stage of ['collecting', 'detecting', 'generating', 'rendering', 'saving'] as const) await onStage?.(stage);
        return { status: 'completed' as const, reportId: 'report-1' };
      } }
    });

    await worker.runOnce();

    expect(stages).toEqual(['collecting', 'detecting', 'generating', 'rendering', 'saving']);
    expect(complete).toHaveBeenCalledWith('job-1', 'report-1');
    expect(lifecycle).toEqual([
      { event: 'job_started', jobId: 'job-1', retryCount: 0 },
      { event: 'job_stage', jobId: 'job-1', stage: 'collecting' },
      { event: 'job_stage', jobId: 'job-1', stage: 'detecting' },
      { event: 'job_stage', jobId: 'job-1', stage: 'generating' },
      { event: 'job_stage', jobId: 'job-1', stage: 'rendering' },
      { event: 'job_stage', jobId: 'job-1', stage: 'saving' },
      { event: 'job_completed', jobId: 'job-1', reportId: 'report-1' }
    ]);
  });

  it('classifies analysis failures without persisting the raw adapter error', async () => {
    const fail = vi.fn(async () => undefined);
    const worker = new DigestWorker({
      jobs: { leaseNext: async () => job, setStage: async () => undefined, complete: async () => undefined, fail },
      analysis: { runWithStages: async () => { throw new Error('ANALYSIS_SOURCE_FAILED: token-value-must-not-leak'); } }
    });

    await worker.runOnce();

    expect(fail).toHaveBeenCalledWith('job-1', 'HOME_ASSISTANT_UNAVAILABLE', 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.');
    expect(JSON.stringify(fail.mock.calls)).not.toContain('token-value-must-not-leak');
  });

  it('preserves detailed provider failures for storage and reporting while redacting credentials', async () => {
    const failureMessages: string[] = [];
    const fail = vi.fn(async (_id: string, _code: string, message: string) => { failureMessages.push(message); });
    const report = vi.fn();
    const worker = new DigestWorker({
      jobs: { leaseNext: async () => job, setStage: async () => undefined, complete: async () => undefined, fail },
      failureReporter: report,
      analysis: { runWithStages: async () => { throw new Error('AI_ANALYSIS_UNAVAILABLE: Gemini 404: model gemini-flash-latest failed; key=raw-provider-token'); } }
    });

    await worker.runOnce();

    expect(fail).toHaveBeenCalledWith('job-1', 'AI_PROVIDER_UNAVAILABLE', expect.stringContaining('Gemini 404'));
    expect(failureMessages[0]).not.toContain('raw-provider-token');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'provider', errorMessage: expect.stringContaining('Gemini 404') }));
    expect(JSON.stringify(report.mock.calls)).not.toContain('raw-provider-token');
  });

  it('marks retried jobs explicitly in the safe lifecycle stream', async () => {
    const events: unknown[] = [];
    const worker = new DigestWorker({
      jobs: { leaseNext: async () => ({ ...job, retryCount: 1 }), setStage: async () => undefined, complete: async () => undefined, fail: async () => undefined },
      eventReporter: (event) => { events.push(event); },
      analysis: { runWithStages: async () => ({ status: 'completed', reportId: 'report-retry' }) }
    });

    await worker.runOnce();

    expect(events).toContainEqual({ event: 'job_retry', jobId: 'job-1', retryCount: 1 });
  });

  it('waits for active execution during shutdown', async () => {
    let release: (() => void) | undefined;
    const worker = new DigestWorker({
      jobs: { leaseNext: async () => job, setStage: async () => undefined, complete: async () => undefined, fail: async () => undefined },
      analysis: { runWithStages: () => new Promise((resolve) => { release = () => resolve({ status: 'completed', reportId: 'report-1' }); }) }
    });

    const running = worker.runOnce();
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await running;
    await expect(stopping).resolves.toBeUndefined();
  });
});
