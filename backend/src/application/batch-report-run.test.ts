import { describe, expect, it, vi } from 'vitest';
import { BatchReportRun, type BatchPersistence, type SignatureMemory, type SignatureProvider } from './batch-report-run.js';
import { parseHomeAssistantLog, type LogDelta, type SignaturePlan } from '../domain/batch.js';

const lines = [
  '2026-07-29 12:00:00 ERROR (MainThread) [ha.one] one token=secret-one',
  '2026-07-29 12:01:00 ERROR (MainThread) [ha.two] two',
  '2026-07-29 12:02:00 ERROR (MainThread) [ha.three] three'
];
const entries = parseHomeAssistantLog(lines);
const plan: SignaturePlan = { baselineEntries: [], signatures: entries.map((entry) => ({ ...entry, classification: 'new', trend: 'new', occurrences: [entry] })) };
const delta: LogDelta = { lines, cursor: { dev: 1, ino: 2, size: 3, offset: 3 } };

function harness(analyze: SignatureProvider['analyze']) {
  const commits: Parameters<BatchPersistence['commit']>[0][] = [];
  const failures: unknown[] = [];
  const signatures: SignatureMemory = { classifyAndStage: vi.fn(async () => plan) };
  const persistence: BatchPersistence = { commit: async (value) => { commits.push(value); }, fail: async (value) => { failures.push(value); } };
  return { run: new BatchReportRun({ log: { read: async () => delta }, signatures, provider: { analyze }, persistence, now: () => '2026-07-30T00:00:00.000Z', maxContextOccurrences: 1, maxContextBytes: 100, providerAuth: { status: 'deferred' } }), commits, failures };
}

describe('BatchReportRun', () => {
  it('analyzes every signature without a signature limit and atomically stages cursor and report', async () => {
    const analyze = vi.fn(async (context) => ({ summary: context.signature, recommendation: 'fix it' }));
    const { run, commits } = harness(analyze);

    await expect(run.run({ runId: 'run-1', slotId: 'slot-1' })).resolves.toEqual({ status: 'reported', warnings: [] });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(analyze.mock.calls[0]?.[0].occurrences).toEqual(['one token=[REDACTED]']);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ cursor: delta.cursor, report: { status: 'reported', findings: [{}, {}, {}] } });
  });

  it('commits available findings with a partial-analysis warning when one signature provider call fails', async () => {
    const { run, commits, failures } = harness(async (context) => {
      if (context.component === 'ha.two') throw new Error('provider down');
      return { summary: context.component, recommendation: 'fix it' };
    });

    await expect(run.run({ runId: 'run-2', slotId: 'slot-2' })).resolves.toEqual({ status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'] });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.report.warnings).toEqual(['AI_ANALYSIS_PARTIAL']);
    expect(failures).toEqual([]);
  });

  it('records an all-provider failure as a web-only failed run without advancing the cursor', async () => {
    const { run, commits, failures } = harness(async () => { throw new Error('provider down'); });

    await expect(run.run({ runId: 'run-3', slotId: 'slot-3' })).resolves.toEqual({ status: 'failed', code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: 'provider down' });
    expect(commits).toEqual([]);
    expect(failures).toEqual([{ request: { runId: 'run-3', slotId: 'slot-3' }, code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: 'provider down' }]);
  });

  it('keeps HA degradation in the committed report and notifies only committed findings', async () => {
    const notified: unknown[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({ log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan }, provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) }, persistence: { commit: async (value) => { commits.push(value); }, fail: async () => undefined }, haStatus: { snapshot: async () => ({ available: false, integrations: [] }) }, notifier: { notify: async (summary) => { notified.push(summary); } } });

    await run.run({ runId: 'run-4', slotId: 'slot-4' });

    expect(commits[0]?.report.integrationStatus).toEqual({ available: false, integrations: [] });
    expect(notified).toHaveLength(1);
  });
});
