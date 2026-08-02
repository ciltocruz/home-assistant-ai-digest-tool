import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualAnalysis } from './manual-analysis.js';

const NOW = '2026-07-29T12:00:00.000Z';

describe('ManualAnalysis', () => {
  afterEach(() => vi.useRealTimers());
  it('persists a deterministic completed report from collected incidents', async () => {
    const saved: unknown[] = [];
    const analysis = new ManualAnalysis({
      collect: async () => ({ facts: [], unsupportedSignals: [] }),
      detect: async () => [{ id: 'incident-b', type: 'entity', severity: 'warning', summary: 'B unavailable', redactedEvidence: [], detectedAt: NOW }],
      generate: async (input) => ({ severity: 'warning', summary: `${input.incidents[0]?.id} digest`, attentionItems: [] }),
      render: async (digest) => ({ format: 'markdown', body: `# ${digest.summary}` }),
      save: async (report) => { saved.push(report); },
      privacyLevel: 'balanced', now: () => NOW
    });

    const result = await analysis.run();
    expect(result).toEqual({ status: 'completed', reportId: expect.any(String) });
    expect(saved).toEqual([expect.objectContaining({ id: result.reportId, rendered: expect.objectContaining({ body: '# incident-b digest' }), summary: expect.objectContaining({ window: { from: '2026-07-28T12:00:00.000Z', to: NOW }, severityCounts: { critical: 0, warning: 1, info: 0 } }) })]);
  });

  it('reports each durable worker stage while preserving the completed analysis result', async () => {
    const stages: string[] = [];
    const analysis = new ManualAnalysis({
      collect: async () => ({ facts: [], unsupportedSignals: [] }), detect: async () => [],
      generate: async () => ({ severity: 'info', summary: 'Digest', attentionItems: [] }),
      render: async () => ({ format: 'markdown', body: '# Digest' }), save: async () => undefined,
      privacyLevel: 'minimal', now: () => NOW
    });

    await expect(analysis.runWithStages((stage) => { stages.push(stage); })).resolves.toMatchObject({ status: 'completed' });
    expect(stages).toEqual(['collecting', 'detecting', 'generating', 'rendering', 'saving']);
  });

  it('rejects concurrent and failed runs safely without saving a partial report', async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const analysis = new ManualAnalysis({
      collect: () => new Promise((resolve) => { reads += 1; release = () => resolve({ facts: [], unsupportedSignals: [] }); }),
      detect: async () => [], generate: async () => ({ severity: 'info', summary: '', attentionItems: [] }),
      render: async () => ({ format: 'markdown', body: '' }), save: async () => { throw new Error('must not save'); }, privacyLevel: 'minimal', now: () => NOW
    });
    const first = analysis.run();
    await expect(analysis.run()).rejects.toThrow('ANALYSIS_IN_PROGRESS');
    expect(reads).toBe(1);
    release?.();
    await expect(first).rejects.toThrow('ANALYSIS_SAVE_FAILED');
  });

  it('fails an overdue source read with a safe deadline code before persistence', async () => {
    const analysis = new ManualAnalysis({
      collect: async () => new Promise(() => undefined), detect: async () => [], generate: async () => ({ severity: 'info', summary: '', attentionItems: [] }),
      render: async () => ({ format: 'markdown', body: '' }), save: async () => { throw new Error('partial save'); }, privacyLevel: 'minimal', now: () => NOW, timeoutMs: 1
    });
    await expect(analysis.run()).rejects.toThrow('ANALYSIS_DEADLINE_EXCEEDED');
  });

  it('propagates a deadline abort to cooperative work and never saves after it settles', async () => {
    vi.useFakeTimers();
    const saved: unknown[] = [];
    let abortObserved = false;
    const analysis = new ManualAnalysis({
      collect: async (context) => new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => {
          abortObserved = true;
          reject(context.signal.reason);
        }, { once: true });
      }),
      detect: async () => [], generate: async () => ({ severity: 'info', summary: '', attentionItems: [] }),
      render: async () => ({ format: 'markdown', body: '' }), save: async (report) => { saved.push(report); },
      privacyLevel: 'minimal', now: () => NOW, timeoutMs: 25
    });

    const result = analysis.run();
    void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).rejects.toThrow('ANALYSIS_DEADLINE_EXCEEDED');
    expect(abortObserved).toBe(true);
    expect(saved).toEqual([]);
  });

  it('keeps the single-flight lease until a timed out non-cooperative operation settles', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let reads = 0;
    const analysis = new ManualAnalysis({
      collect: () => new Promise((resolve) => { reads += 1; release = () => resolve({ facts: [], unsupportedSignals: [] }); }),
      detect: async () => [], generate: async () => ({ severity: 'info', summary: '', attentionItems: [] }),
      render: async () => ({ format: 'markdown', body: '' }), save: async () => undefined,
      privacyLevel: 'minimal', now: () => NOW, timeoutMs: 25
    });

    const first = analysis.run();
    void first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).rejects.toThrow('ANALYSIS_DEADLINE_EXCEEDED');
    await expect(analysis.run()).rejects.toThrow('ANALYSIS_IN_PROGRESS');
    expect(reads).toBe(1);

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
  });
});
