import { describe, expect, it, vi } from 'vitest';
import { BatchReportRun, type BatchPersistence, type LogExtractionRequest, type SignatureMemory, type SignatureProvider } from './batch-report-run.js';
import { classifySignatures, parseHomeAssistantLog, type LogDelta, type SignaturePlan } from '../domain/batch.js';
import { DigestWorker } from './digest-worker.js';

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
  const deliveryUpdates: Array<{ reportId: string; status: string }> = [];
  const signatures: SignatureMemory = { classifyAndStage: vi.fn(async () => plan) };
  const persistence = { commit: async (value: Parameters<BatchPersistence['commit']>[0]) => { commits.push(value); return 'report-id'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async (reportId: string, status: string) => { deliveryUpdates.push({ reportId, status }); }, fail: async (value: Parameters<BatchPersistence['fail']>[0]) => { failures.push(value); } };
  return { run: new BatchReportRun({ log: { read: async () => delta }, signatures, provider: { analyze }, persistence, now: () => '2026-07-30T00:00:00.000Z', maxContextOccurrences: 1, maxContextBytes: 100, providerAuth: { status: 'deferred' } }), commits, failures, deliveryUpdates };
}

describe('BatchReportRun', () => {
  const stockMessage = (name: string) => `We found a custom integration ${name} which has not been tested by Home Assistant. This component might cause stability problems, be sure to disable it if you experience issues with Home Assistant`;

  it.each(['basic', 'ai'] as const)('excludes only stock warnings before analysis in %s mode while committing memory and cursor', async (mode) => {
    const stockLines = ['spook', 'zha_toolkit', 'never_seen_before'].map((name) => `2026-07-29 12:07:00 WARNING [homeassistant.loader] ${stockMessage(name)}`);
    const genuineLines = [
      '2026-07-29 12:01:00 WARNING [custom_components.spook] Update failed',
      '2026-07-29 12:02:00 WARNING [homeassistant.loader] Custom integration failed to load',
      `2026-07-29 12:03:00 ERROR [homeassistant.loader] ${stockMessage('spook')}`,
      `2026-07-29 12:04:00 CRITICAL [homeassistant.loader] ${stockMessage('spook')}`,
      `2026-07-29 12:05:00 WARNING [homeassistant.loader] ${stockMessage('spook')} Diagnostic details`,
      '2026-07-29 12:06:00 WARNING [homeassistant.loader] We found a custom integration spook which has not been tested by Home Assistant.'
    ];
    for (const mixed of [false, true]) {
      const inputLines = [...(mixed ? genuineLines : []), ...stockLines];
      const analyze = vi.fn(async () => ({ summary: 'Genuine finding', recommendation: 'Investigate' }));
      const notify = vi.fn(async () => 'sent' as const);
      const commit = vi.fn(async (_value: Parameters<BatchPersistence['commit']>[0]) => 'report-id');
      const classifyAndStage = vi.fn(async (entries, now) => classifySignatures(entries, [], { now }));
      const extract = vi.fn(async ({ batch }) => ({
        // A provider may paraphrase or change severity; stock source must never reach it.
        entries: parseHomeAssistantLog(batch.lines, { includeWarnings: true }).map((entry) => entry.message === stockMessage('spook') && entry.level === 'WARNING'
          ? { timestamp: entry.at, level: 'ERROR', component: 'loader', message: 'Untested integration could be unstable' }
          : { timestamp: entry.at, ...entry }),
        rejectedCount: 0
      }));
      const run = new BatchReportRun({
        log: { read: async () => ({ ...delta, lines: inputLines }) },
        signatures: { classifyAndStage }, provider: { analyze }, notifier: { notify },
        logMode: async () => mode, extractor: { extract }, now: () => '2026-07-30T00:00:00.000Z',
        persistence: { commit, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => {}, fail: async () => {} }
      });

      expect((await run.run({ runId: 'stock-warning', slotId: 'slot', includeWarnings: true })).status).toBe(mixed ? 'reported' : 'quiet');
      expect(analyze).toHaveBeenCalledTimes(mixed ? genuineLines.length : 0);
      expect(notify).toHaveBeenCalledTimes(mixed ? 1 : 0);
      const committed = commit.mock.calls[0]![0];
      expect(committed.cursor).toEqual(delta.cursor);
      expect(committed.logRead).toEqual({ from: mixed ? '2026-07-29T12:01:00.000Z' : '2026-07-29T12:07:00.000Z', to: '2026-07-29T12:07:00.000Z' });
      expect(committed.signatures.signatures).toHaveLength(inputLines.length);
      expect(committed.reportedSignatures?.map((signature) => signature.occurrences[0]?.message)).toEqual(mixed ? parseHomeAssistantLog(genuineLines, { includeWarnings: true }).map((entry) => entry.message) : []);
      expect(committed.report.findings).toHaveLength(mixed ? genuineLines.length : 0);
      if (mode === 'ai') {
        expect(extract.mock.calls.flatMap(([request]) => request.batch.lines)).not.toContain(stockLines[0]);
        if (mixed) expect(extract.mock.calls[0]?.[0].batch.lines.slice(0, genuineLines.length)).toEqual(genuineLines);
      }
    }
  });

  it.each([
    ['ERROR', 'homeassistant.loader', 'WARNING'],
    ['ERROR', 'homeassistant.loader', 'ERROR'],
    ['WARNING', 'custom_components.spook', 'WARNING']
  ] as const)('does not suppress original %s from %s reconstructed by AI as stock %s', async (sourceLevel, sourceComponent, extractedLevel) => {
    for (const mixed of [false, true]) {
      const originalLine = `2026-07-29 12:01:00 ${sourceLevel} [${sourceComponent}] ${stockMessage('spook')}`;
      const stockLine = `2026-07-29 12:00:00 WARNING [homeassistant.loader] ${stockMessage('spook')}`;
      const inputLines = mixed ? [stockLine, originalLine] : [originalLine];
      const analyze = vi.fn(async () => ({ summary: 'Genuine finding', recommendation: 'Investigate' }));
      const notify = vi.fn(async () => 'sent' as const);
      const commit = vi.fn(async (_value: Parameters<BatchPersistence['commit']>[0]) => 'report-id');
      const classifyAndStage = vi.fn(async (entries, now) => classifySignatures(entries, [], { now }));
      const extract = vi.fn(async (_request: LogExtractionRequest) => ({
        entries: [{ timestamp: '2026-07-29T12:01:00.000Z', level: extractedLevel, component: 'homeassistant.loader', message: stockMessage('spook'), sourceLines: [stockLine] }],
        rejectedCount: 0
      }));
      const run = new BatchReportRun({
        log: { read: async () => ({ ...delta, lines: inputLines }) },
        signatures: { classifyAndStage }, provider: { analyze }, notifier: { notify },
        logMode: async () => 'ai', extractor: { extract }, now: () => '2026-07-30T00:00:00.000Z',
        persistence: { commit, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => {}, fail: async () => {} }
      });

      expect((await run.run({ runId: 'source-origin', slotId: 'slot', includeWarnings: true })).status).toBe('reported');
      expect(extract).toHaveBeenCalledOnce();
      expect(extract.mock.calls[0]![0].batch.lines).toEqual(mixed ? ['', originalLine] : [originalLine]);
      expect(analyze).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledOnce();
      const committed = commit.mock.calls[0]![0];
      expect(committed.cursor).toEqual(delta.cursor);
      expect(committed.reportedSignatures).toHaveLength(1);
      expect(committed.reportedSignatures![0]!.occurrences).toHaveLength(mixed && extractedLevel === 'WARNING' ? 2 : 1);
      expect(committed.report.findings).toHaveLength(1);
      expect(committed.logRead).toEqual({ from: mixed ? '2026-07-29T12:00:00.000Z' : '2026-07-29T12:01:00.000Z', to: '2026-07-29T12:01:00.000Z' });
      const stagedEntries = classifyAndStage.mock.calls[0]![0];
      expect(committed.signatures.signatures.flatMap((signature) => signature.occurrences)).toHaveLength(inputLines.length);
      expect(committed.signatures.signatures.every((signature) => signature.occurrences.every((entry) => stagedEntries.includes(entry)))).toBe(true);
    }
  });

  it('preserves an original ERROR even when its effective signature severity is WARNING', async () => {
    const original = parseHomeAssistantLog([`2026-07-29 12:00:00 ERROR [homeassistant.loader] ${stockMessage('spook')}`])[0]!;
    const analyze = vi.fn(async () => ({ summary: 'Error', recommendation: 'Investigate' }));
    const { run } = harness(analyze);
    const originalPlan = plan.signatures;
    plan.signatures = [{ ...original, level: 'WARNING', classification: 'new', trend: 'new', occurrences: [original] }];
    try {
      expect((await run.run({ runId: 'original-error', slotId: 'slot', includeWarnings: true })).status).toBe('reported');
      expect(analyze).toHaveBeenCalledOnce();
    } finally {
      plan.signatures = originalPlan;
    }
  });

  it('analyzes every signature without a signature limit and atomically stages cursor and report', async () => {
    const analyze = vi.fn(async (context) => ({ summary: context.signature, recommendation: 'fix it' }));
    const { run, commits, deliveryUpdates } = harness(analyze);

    await expect(run.run({ runId: 'run-1', slotId: 'slot-1' })).resolves.toEqual({ status: 'reported', warnings: [], reportId: 'report-id' });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(analyze.mock.calls[0]?.[0].occurrences).toEqual(['one token=[REDACTED]']);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ cursor: delta.cursor, logRead: { from: entries[0].at, to: entries[entries.length - 1].at }, report: { status: 'reported', deliveryStatus: 'skipped', findings: [{}, {}, {}] } });
    expect(deliveryUpdates).toEqual([{ reportId: 'report-id', status: 'skipped' }]);
  });

  it('commits the parsed log read range when the delta contains parseable entries', async () => {
    const analyze = vi.fn(async () => ({ summary: 'summary', recommendation: 'fix' }));
    const { run, commits } = harness(analyze);

    await run.run({ runId: 'run-logread', slotId: 'slot-logread' });

    expect(commits[0]?.logRead).toEqual({ from: entries[0].at, to: entries[entries.length - 1].at });
  });

  it('commits a null log read range when the delta contains no parseable entries', async () => {
    const analyze = vi.fn(async () => ({ summary: 'summary', recommendation: 'fix' }));
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: ['garbage line without a timestamp', ''], cursor: delta.cursor }) },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze },
      persistence: { commit: async (value) => { commits.push(value); return 'report-id'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      now: () => '2026-07-30T00:00:00.000Z'
    });

    await run.run({ runId: 'run-null-logread', slotId: 'slot-null-logread' });

    expect(commits[0]?.logRead).toBeNull();
  });

  it('commits available findings with a partial-analysis warning when one signature provider call fails', async () => {
    const { run, commits, failures } = harness(async (context) => {
      if (context.component === 'ha.two') throw new Error('provider down');
      return { summary: context.component, recommendation: 'fix it' };
    });

    await expect(run.run({ runId: 'run-2', slotId: 'slot-2' })).resolves.toEqual({ status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL', 'provider down'], reportId: 'report-id' });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.report.warnings).toEqual(['AI_ANALYSIS_PARTIAL', 'provider down']);
    expect(commits[0]?.report.failure).toBe('provider down');
    expect(failures).toEqual([]);
  });

  it('passes the selected account language to every AI analysis and the notifier', async () => {
    const analysisLanguages: Array<string | undefined> = [];
    const notificationLanguages: string[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async (_context, _signal, language) => { analysisLanguages.push(language); return { summary: 'Resumen', recommendation: 'Revisar' }; } },
      persistence: { commit: async () => 'report-language', claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      notifier: { notify: async (summary) => { notificationLanguages.push(summary.language); return 'sent'; } },
      language: async () => 'es'
    });

    await run.run({ runId: 'run-language', slotId: 'slot-language' });

    expect(analysisLanguages).toEqual(['es', 'es', 'es']);
    expect(notificationLanguages).toEqual(['es']);
  });

  it('builds an optional report link from the committed report identifier', async () => {
    const notifications: Array<{ reportUrl?: string }> = [];
    const reportUrl = vi.fn((reportId: string) => `https://digest.example/reports/${encodeURIComponent(reportId)}`);
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async () => 'v2-report:committed/id', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      notifier: { notify: async (summary) => { notifications.push(summary); return 'sent'; } },
      reportUrl
    });

    await run.run({ runId: 'request-id-must-not-be-used', slotId: 'slot-report-link' });

    expect(reportUrl).toHaveBeenCalledWith('v2-report:committed/id');
    expect(notifications).toEqual([expect.objectContaining({ reportUrl: 'https://digest.example/reports/v2-report%3Acommitted%2Fid' })]);
  });

  it('keeps notification summaries valid when no report URL callback is configured', async () => {
    const notifications: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async () => 'v2-report:no-link', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      notifier: { notify: async (summary) => { notifications.push(summary); return 'sent'; } }
    });

    await run.run({ runId: 'request-no-link', slotId: 'slot-no-link' });

    expect(notifications).toEqual([expect.not.objectContaining({ reportUrl: expect.anything() })]);
  });

  it('commits an all-provider failure as a web-only partial report with safe evidence', async () => {
    const providerSecret = 'AIzaSyA1B2C3D4E5F6G7H8';
    const { run, commits, failures } = harness(async () => { throw new Error(`Gemini request failed at https://example.test/generate?key=${providerSecret}`); });

    const expectedError = 'Gemini request failed at https://example.test/generate?key=[REDACTED]';
    await expect(run.run({ runId: 'run-3', slotId: 'slot-3' })).resolves.toEqual({ status: 'partial', warnings: ['AI_ANALYSIS_UNAVAILABLE', expectedError], reportId: 'report-id' });
    expect(commits).toMatchObject([{
      cursor: delta.cursor,
      logRead: { from: entries[0].at, to: entries[entries.length - 1].at },
      report: { status: 'partial', deliveryStatus: 'skipped', findings: [], warnings: ['AI_ANALYSIS_UNAVAILABLE', expectedError], failure: expectedError }
    }]);
    expect(failures).toEqual([]);
    expect(JSON.stringify(commits)).not.toContain(providerSecret);
  });

  it('reports every signature while explaining only the top 10 sorted by occurrences descending', async () => {
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const manyLines: string[] = [];
    for (let i = 1; i <= 15; i++) {
      for (let j = 0; j < i; j++) {
        manyLines.push(`2026-07-29 12:00:00 ERROR (MainThread) [ha.comp${i}] error message ${i}`);
      }
    }
    const manyEntries = parseHomeAssistantLog(manyLines);
    const signatureMap = new Map<string, typeof manyEntries>();
    for (const entry of manyEntries) {
      const list = signatureMap.get(entry.signature) ?? [];
      list.push(entry);
      signatureMap.set(entry.signature, list);
    }
    const manyPlan: SignaturePlan = {
      baselineEntries: [],
      signatures: Array.from(signatureMap.values()).map((entries) => ({
        ...entries[0]!,
        classification: 'new',
        trend: 'new',
        occurrences: entries
      }))
    };

    const analyzedComponents: string[] = [];
    const analyze = vi.fn(async (context: { component: string }) => {
      analyzedComponents.push(context.component);
      return { summary: context.component, recommendation: 'fix' };
    });

    const run = new BatchReportRun({
      log: { read: async () => ({ lines: manyLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async () => manyPlan },
      provider: { analyze },
      persistence: {
        commit: async (value) => { commits.push(value); return 'top-10-report'; },
        claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }),
        updateDeliveryStatus: async () => undefined,
        fail: async () => undefined
      }
    });

    await run.run({ runId: 'run-top-10', slotId: 'slot-top-10' });

    expect(analyze).toHaveBeenCalledTimes(10);
    expect(analyzedComponents).toEqual([
      'ha.comp15', 'ha.comp14', 'ha.comp13', 'ha.comp12', 'ha.comp11',
      'ha.comp10', 'ha.comp9', 'ha.comp8', 'ha.comp7', 'ha.comp6'
    ]);
    expect(commits[0]?.reportedSignatures).toHaveLength(15);
    expect(commits[0]?.reportedSignatures?.at(-1)).toMatchObject({ component: 'ha.comp1', analysisStatus: 'not_attempted' });
    expect(commits[0]?.report).toMatchObject({ status: 'partial', warnings: ['AI_ANALYSIS_LIMIT'] });
  });

  it('keeps rare warnings and grouped duplicates beyond the analysis budget without reporting ignored siblings', async () => {
    const manyLines = Array.from({ length: 12 }, (_, index) => `2026-07-29 12:00:00 ${index === 11 ? 'WARNING' : 'ERROR'} [ha.comp${index}] distinct problem`);
    manyLines.unshift(manyLines[0]!, manyLines[0]!);
    manyLines.push('2026-07-29 12:00:00 ERROR [ha.comp0] ignored sibling');
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const analyze = vi.fn(async (context: { component: string }) => {
      if (context.component === 'ha.comp1') throw new Error('analysis down');
      return { summary: 'summary', recommendation: 'fix' };
    });
    const notify = vi.fn(async () => 'sent' as const);
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: manyLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async (entries, now) => classifySignatures(entries, [], { now }) },
      provider: { analyze },
      persistence: { commit: async (value) => { commits.push(value); return 'all-report'; }, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      ignores: { listActive: async () => [{ id: 'ignored', type: 'message', match: 'ignored sibling', createdAt: '2026-07-29T00:00:00.000Z' }] },
      notifier: { notify },
      now: () => '2026-07-30T00:00:00.000Z'
    });
    await expect(run.run({ runId: 'all', slotId: 'all', includeWarnings: true })).resolves.toMatchObject({ status: 'partial' });
    const reported = commits[0]!.reportedSignatures!;
    expect(reported).toHaveLength(12);
    expect(reported[0]?.occurrences).toHaveLength(3);
    expect(reported.find((item) => item.component === 'ha.comp1')).toMatchObject({ analysisStatus: 'failed' });
    expect(reported.at(-1)).toMatchObject({ component: 'ha.comp11', level: 'WARNING', analysisStatus: 'not_attempted' });
    expect(analyze).toHaveBeenCalledTimes(10);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ detectedProblems: 12, findings: expect.any(Array) }));
    expect(commits[0]?.report.findings).toHaveLength(9);
    expect(commits[0]?.report.warnings).toEqual(['AI_ANALYSIS_LIMIT', 'AI_ANALYSIS_PARTIAL', 'analysis down']);
  });

  it('preserves explicit AI provider error messages when AI fails with 429 or other errors', async () => {
    const events: unknown[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const analyze = vi.fn(async () => {
      throw new Error('HTTP 429 Rate limit exceeded: Too Many Requests');
    });

    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze },
      persistence: {
        commit: async (value) => { commits.push(value); return 'report-429'; },
        claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }),
        updateDeliveryStatus: async () => undefined,
        fail: async () => undefined
      },
      eventReporter: (event) => { events.push(event); }
    });

    const outcome = await run.run({ runId: 'run-429', slotId: 'slot-429' });

    expect(outcome).toEqual({
      status: 'partial',
      warnings: ['AI_ANALYSIS_UNAVAILABLE', 'HTTP 429 Rate limit exceeded: Too Many Requests'],
      reportId: 'report-429'
    });
    expect(commits[0]?.report.failure).toBe('HTTP 429 Rate limit exceeded: Too Many Requests');
    expect(commits[0]?.report.warnings).toEqual(['AI_ANALYSIS_UNAVAILABLE', 'HTTP 429 Rate limit exceeded: Too Many Requests']);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'report_analysis_completed',
      analyzedCount: 0,
      failedCount: 3,
      error: 'HTTP 429 Rate limit exceeded: Too Many Requests'
    }));
  });

  it('saves every candidate as partial rather than quiet when all ten explanation attempts fail', async () => {
    const manyLines = Array.from({ length: 20 }, (_, index) => `2026-07-29 12:00:00 ERROR [ha.problem${index}] distinct failure`);
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const analyze = vi.fn(async () => { throw new Error('provider down'); });
    const notify = vi.fn(async () => 'sent' as const);
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: manyLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async (entries, now) => classifySignatures(entries, [], { now }) },
      provider: { analyze }, notifier: { notify }, now: () => '2026-07-30T00:00:00.000Z',
      persistence: { commit: async (value) => { commits.push(value); return 'partial-all'; }, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined }
    });
    await expect(run.run({ runId: 'partial-all', slotId: 'partial-all' })).resolves.toMatchObject({ status: 'partial' });
    expect(analyze).toHaveBeenCalledTimes(10);
    expect(notify).not.toHaveBeenCalled();
    expect(commits[0]?.reportedSignatures).toHaveLength(20);
    expect(commits[0]?.reportedSignatures?.filter((item) => item.analysisStatus === 'failed')).toHaveLength(10);
    expect(commits[0]?.reportedSignatures?.filter((item) => item.analysisStatus === 'not_attempted')).toHaveLength(10);
    expect(commits[0]?.report.deliveryStatus).toBe('skipped');
  });

  it('matches signature ignore rules exactly without hiding a sibling from the same component', async () => {
    const siblingEntries = parseHomeAssistantLog([
      '2026-07-29 12:00:00 ERROR [homeassistant.components.demo] First failure',
      '2026-07-29 12:01:00 ERROR [homeassistant.components.demo] Second failure'
    ]);
    const siblingPlan: SignaturePlan = { baselineEntries: [], signatures: siblingEntries.map((entry) => ({ ...entry, classification: 'new', trend: 'new', occurrences: [entry] })) };
    const analyzed: string[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: [], cursor: delta.cursor }) },
      signatures: { classifyAndStage: async () => siblingPlan },
      provider: { analyze: async (context) => { analyzed.push(context.signature); return { summary: 'Found', recommendation: 'Fix' }; } },
      persistence: { commit: async (plan) => { commits.push(plan); return 'exact-ignore-report'; }, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      ignores: { listActive: async () => [{ id: 'exact-ignore', match: siblingEntries[0]!.signature, type: 'signature', createdAt: '2026-07-29T12:02:00.000Z' }] }
    });

    await run.run({ runId: 'exact-ignore-run', slotId: 'exact-ignore-slot' });

    expect(analyzed).toEqual([siblingEntries[1]!.signature]);
    expect(commits[0]?.reportedSignatures?.map(({ signature }) => signature)).toEqual([siblingEntries[1]!.signature]);
  });

  it('preserves substring matching for legacy ignore rule types', async () => {
    const analyzed: string[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async (context) => { analyzed.push(context.component); return { summary: 'Found', recommendation: 'Fix' }; } },
      persistence: { commit: async () => 'legacy-ignore-report', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      ignores: { listActive: async () => [{ id: 'legacy-ignore', match: 'ha.two', type: 'message', createdAt: '2026-07-29T12:03:00.000Z' }] }
    });

    await run.run({ runId: 'legacy-ignore-run', slotId: 'legacy-ignore-slot' });

    expect(analyzed).toEqual(['ha.one', 'ha.three']);
  });

  it('keeps HA degradation in the committed report and notifies only committed findings', async () => {
    const notified: unknown[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const deliveryUpdates: Array<{ reportId: string; status: string }> = [];
    const run = new BatchReportRun({ log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan }, provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) }, persistence: { commit: async (value) => { commits.push(value); return 'report-id'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async (reportId, status) => { deliveryUpdates.push({ reportId, status }); }, fail: async () => undefined }, haStatus: { snapshot: async () => ({ available: false }) }, notifier: { notify: async (summary) => { notified.push(summary); return 'sent'; } } });

    await run.run({ runId: 'run-4', slotId: 'slot-4' });

    expect(commits[0]?.report.integrationStatus).toEqual({ available: false });
    expect(notified).toHaveLength(1);
    expect(commits[0]?.report.deliveryStatus).toBe('sent');
    expect(deliveryUpdates).toEqual([{ reportId: 'report-id', status: 'sent' }]);
  });

  it('keeps a committed report pending when notification delivery is unknown without losing the report', async () => {
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const deliveryUpdates: Array<{ reportId: string; status: string }> = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async (value) => { commits.push(value); return 'report-id'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async (reportId, status) => { deliveryUpdates.push({ reportId, status }); }, fail: async () => undefined },
      notifier: { notify: async () => { throw new Error('telegram delivery failed'); } }
    });

    await expect(run.run({ runId: 'run-5', slotId: 'slot-5' })).resolves.toMatchObject({ status: 'reported', reportId: 'report-id' });
    expect(commits).toHaveLength(1);
    expect(deliveryUpdates).toEqual([{ reportId: 'report-id', status: 'pending' }]);
  });

  it('commits a report before attempting notification and records each delivery outcome', async () => {
    const events: string[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: {
        commit: async () => { events.push('commit'); return 'report-id'; },
        claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }),
        updateDeliveryStatus: async (_reportId, status) => { events.push(`delivery:${status}`); },
        fail: async () => undefined
      },
      notifier: { notify: async () => { events.push('notify'); return 'sent'; } }
    });

    await run.run({ runId: 'run-order', slotId: 'slot-order' });

    expect(events).toEqual(['commit', 'notify', 'delivery:sent']);
  });

  it('preserves only the bounded Telegram delivery diagnostic after notification', async () => {
    const updates: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: {
        commit: async () => 'report-diagnostic', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }),
        updateDeliveryStatus: async (...args) => { updates.push(args); }, fail: async () => undefined
      },
      notifier: { notify: async () => ({ status: 'failed', targetRef: 'telegram:private-target', errorCode: 'TELEGRAM_HTTP_429', message: 'provider text must not persist' }) },
      now: () => '2026-08-13T10:00:01.000Z'
    });

    await run.run({ runId: 'run-diagnostic', slotId: 'slot-diagnostic' });

    expect(updates).toEqual([['report-diagnostic', 'failed', {
      channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_HTTP_429',
      messageKey: 'telegram_rate_limited', recordedAt: '2026-08-13T10:00:01.000Z'
    }]]);
    expect(JSON.stringify(updates)).not.toContain('private-target');
    expect(JSON.stringify(updates)).not.toContain('provider text');
  });

  it('persists an indeterminate Telegram response as pending without provider content', async () => {
    const updates: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: {
        commit: async () => 'report-invalid-response', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }),
        updateDeliveryStatus: async (...args) => { updates.push(args); }, fail: async () => undefined
      },
      notifier: { notify: async () => ({ status: 'pending', targetRef: 'telegram:private-target', errorCode: 'TELEGRAM_INVALID_RESPONSE', message: 'private response body' }) },
      now: () => '2026-08-13T10:00:01.000Z'
    });

    const outcome = await run.run({ runId: 'run-invalid-response', slotId: 'slot-invalid-response' });

    expect(outcome).toMatchObject({ reportId: 'report-invalid-response' });
    expect(updates).toEqual([['report-invalid-response', 'pending', {
      channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE',
      messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z'
    }]]);
    expect(JSON.stringify(updates)).not.toContain('private-target');
    expect(JSON.stringify(updates)).not.toContain('private response body');
  });

  it('maps an arbitrary notifier error code to a generic bounded diagnostic', async () => {
    const updates: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan }, provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async () => 'report-generic-diagnostic', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async (...args) => { updates.push(args); }, fail: async () => undefined },
      notifier: { notify: async () => ({ status: 'failed', targetRef: 'telegram:private', errorCode: 'ARBITRARY_PROVIDER_CODE', message: 'private provider detail' }) },
      now: () => '2026-08-13T10:00:01.000Z'
    });

    await run.run({ runId: 'run-generic-diagnostic', slotId: 'slot-generic-diagnostic' });

    expect(updates).toEqual([['report-generic-diagnostic', 'failed', { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_REJECTED', messageKey: 'telegram_rejected', recordedAt: '2026-08-13T10:00:01.000Z' }]]);
    expect(JSON.stringify(updates)).not.toContain('ARBITRARY_PROVIDER_CODE');
    expect(JSON.stringify(updates)).not.toContain('private provider detail');
  });

  it('emits a completed pending Telegram event when delivery throws', async () => {
    const events: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan }, provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async () => 'report-throw-event', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      notifier: { notify: async () => { throw new Error('private outbound URL'); } },
      eventReporter: (event) => { events.push(event); }
    });

    await run.run({ runId: 'run-throw-event', slotId: 'slot-throw-event' });

    expect(events).toContainEqual(expect.objectContaining({ event: 'telegram_delivery_completed', outcome: 'pending' }));
    expect(JSON.stringify(events)).not.toContain('private outbound URL');
  });

  it('reports aggregate report, HA snapshot, and Telegram lifecycle events without content', async () => {
    const events: unknown[] = [];
    let time = 100;
    const run = new BatchReportRun({
      log: { read: async () => delta }, signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'private provider content', recommendation: 'private action' }) },
      persistence: { commit: async () => 'report-events', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: true }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      haStatus: { snapshot: async () => ({ available: false, reason: 'socket_timeout' }) },
      notifier: { notify: async () => ({ status: 'sent', targetRef: 'telegram:private-chat' }) },
      eventReporter: (event) => { events.push(event); },
      clock: () => time++
    });

    await run.run({ runId: 'run-events', slotId: 'slot-events' });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'report_collection_completed', lineCount: 3, signatureCount: 3 }),
      expect.objectContaining({ event: 'ha_snapshot_failed', reason: 'socket_timeout' }),
      expect.objectContaining({ event: 'report_analysis_completed', analyzedCount: 3, failedCount: 0 }),
      expect.objectContaining({ event: 'report_commit_completed', reportId: 'report-events' }),
      expect.objectContaining({ event: 'telegram_delivery_started' }),
      expect.objectContaining({ event: 'telegram_delivery_completed', outcome: 'sent' })
    ]));
    expect(JSON.stringify(events)).not.toContain('private provider content');
    expect(JSON.stringify(events)).not.toContain('private-chat');
  });

  it('reports a safe collection failure without logging the thrown error', async () => {
    const events: unknown[] = [];
    const run = new BatchReportRun({
      log: { read: async () => { throw new Error('private Home Assistant log path and content'); } },
      signatures: { classifyAndStage: async () => plan }, provider: { analyze: async () => ({ summary: 'unused', recommendation: 'unused' }) },
      persistence: { commit: async () => 'unused', claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      eventReporter: (event) => { events.push(event); }
    });

    await expect(run.run({ runId: 'collection-failure', slotId: 'collection-failure' })).rejects.toThrow();

    expect(events).toEqual([{ event: 'report_collection_failed' }]);
    expect(JSON.stringify(events)).not.toContain('private Home Assistant');
  });

  it.each([
    ['no target', undefined, 'skipped'],
    ['successful target', { notify: async () => 'sent' as const }, 'sent'],
    ['failed target', { notify: async () => 'failed' as const }, 'failed']
  ])('persists %s notification state', async (_label, notifier, expected) => {
    const deliveryUpdates: string[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: { commit: async () => 'report-id', claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: true }), updateDeliveryStatus: async (_id, status) => { deliveryUpdates.push(status); }, fail: async () => undefined },
      notifier
    });

    await run.run({ runId: `run-${expected}`, slotId: `slot-${expected}` });

    expect(deliveryUpdates).toEqual([expected]);
  });

  it('keeps a committed report and completed job after sent notification status persistence fails without resending on retry', async () => {
    let job: { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; stage: 'queued' | 'completed' | 'failed'; retryCount: number; retryAvailable: boolean } = {
      id: 'job-delivery-persistence', status: 'queued', stage: 'queued', retryCount: 0, retryAvailable: false
    };
    let deliveryUpdateAttempts = 0;
    let notificationAttempts = 0;
    let committedReport: Parameters<BatchPersistence['commit']>[0]['report'] | undefined;
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      persistence: {
        commit: async (value) => { committedReport = value.report; return 'report-id'; },
        claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: notificationAttempts === 0 }),
        updateDeliveryStatus: async (_reportId, status) => {
          deliveryUpdateAttempts += 1;
          if (deliveryUpdateAttempts === 1) throw new Error('delivery state storage unavailable');
          committedReport!.deliveryStatus = status;
        },
        fail: async () => { job = { ...job, status: 'failed', stage: 'failed', retryAvailable: true }; }
      },
      notifier: { notify: async () => { notificationAttempts += 1; return 'sent'; } }
    });
    const worker = new DigestWorker({
      jobs: {
        leaseNext: async () => job.status === 'queued' ? { ...job, status: 'running' as const } as never : null,
        setStage: async () => undefined,
        complete: async () => { job = { ...job, status: 'completed', stage: 'completed', retryAvailable: false }; },
        fail: async () => { job = { ...job, status: 'failed', stage: 'failed', retryAvailable: true }; }
      },
      analysis: {
        runWithStages: async () => {
          const outcome = await run.run({ runId: job.id, slotId: 'delivery-persistence-slot' });
          if (outcome.status === 'failed') throw new Error(`${outcome.code}: ${outcome.errorMessage}`);
          return { status: 'completed', reportId: outcome.reportId };
        }
      }
    });

    await worker.runOnce();

    expect(job).toMatchObject({ status: 'completed', stage: 'completed', retryAvailable: false });
    expect(committedReport?.deliveryStatus).toBe('sent');
    expect(notificationAttempts).toBe(1);
    await worker.runOnce();
    expect(notificationAttempts).toBe(1);
  });

  it('extracts AI errors in ai mode and analyzes them through the common pipeline', async () => {
    const events: unknown[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const analyzed: string[] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async (entries) => ({ baselineEntries: [], signatures: entries.map((entry) => ({ ...entry, classification: 'new' as const, trend: 'new' as const, occurrences: [entry] })) }) },
      provider: { analyze: async (context) => { analyzed.push(context.component); return { summary: 'AI summary', recommendation: 'AI fix' }; } },
      extractor: { extract: async () => ({ entries: [{ timestamp: '2026-07-29 12:00:00', level: 'ERROR', component: 'ha.ai', message: 'ai boom' }], rejectedCount: 1 }) },
      logMode: async () => 'ai',
      persistence: { commit: async (value) => { commits.push(value); return 'ai-report'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      eventReporter: (event) => { events.push(event); },
      now: () => '2026-07-30T00:00:00.000Z'
    });

    await expect(run.run({ runId: 'run-ai', slotId: 'slot-ai' })).resolves.toMatchObject({ status: 'reported', reportId: 'ai-report' });
    expect(analyzed).toEqual(['ha.ai']);
    expect(commits[0]?.report.findings).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ event: 'report_extraction_completed', mode: 'ai', batchCount: 1, extractedCount: 1, rejectedCount: 1 }));
  });

  it('applies ignore rules to AI-extracted errors instead of re-reporting them', async () => {
    const analyze = vi.fn(async () => ({ summary: 'AI summary', recommendation: 'AI fix' }));
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async (entries) => ({ baselineEntries: [], signatures: entries.map((entry) => ({ ...entry, classification: 'new' as const, trend: 'new' as const, occurrences: [entry] })) }) },
      provider: { analyze },
      extractor: { extract: async () => ({ entries: [{ timestamp: '2026-07-29 12:00:00', level: 'ERROR', component: 'ha.ignored', message: 'known noise' }], rejectedCount: 0 }) },
      logMode: async () => 'ai',
      persistence: { commit: async (value) => { commits.push(value); return 'ai-ignored'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      ignores: { listActive: async () => [{ id: 'ignore-ai', match: 'ha.ignored', type: 'message', createdAt: '2026-07-29T12:03:00.000Z' }] },
      now: () => '2026-07-30T00:00:00.000Z'
    });

    await expect(run.run({ runId: 'run-ai-ignored', slotId: 'slot-ai-ignored' })).resolves.toMatchObject({ status: 'quiet' });
    expect(analyze).not.toHaveBeenCalled();
    expect(commits[0]?.report.status).toBe('quiet');
  });

  it('fails visibly without committing when every AI extraction batch fails', async () => {
    const events: unknown[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({
      log: { read: async () => delta },
      signatures: { classifyAndStage: async () => plan },
      provider: { analyze: async () => ({ summary: 'unused', recommendation: 'unused' }) },
      extractor: { extract: async () => { throw new Error('provider down'); } },
      logMode: async () => 'ai',
      persistence: { commit: async (value) => { commits.push(value); return 'unused'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      eventReporter: (event) => { events.push(event); },
      now: () => '2026-07-30T00:00:00.000Z'
    });

    await expect(run.run({ runId: 'run-ai-failed', slotId: 'slot-ai-failed' })).rejects.toThrow('AI_EXTRACTION_UNAVAILABLE');
    expect(commits).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'report_extraction_failed' }));
  });

  it('keeps AI-extracted warnings out unless warnings are included', async () => {
    const build = (includeWarnings: boolean) => {
      const commits: Parameters<BatchPersistence['commit']>[0][] = [];
      const run = new BatchReportRun({
        log: { read: async () => delta },
        signatures: { classifyAndStage: async (entries) => ({ baselineEntries: [], signatures: entries.map((entry) => ({ ...entry, classification: 'new' as const, trend: 'new' as const, occurrences: [entry] })) }) },
        provider: { analyze: async () => ({ summary: 'AI summary', recommendation: 'AI fix' }) },
        extractor: { extract: async () => ({ entries: [{ timestamp: '2026-07-29 12:00:00', level: 'WARNING', component: 'ha.wary', message: 'just a warning' }], rejectedCount: 0 }) },
        logMode: async () => 'ai',
        persistence: { commit: async (value) => { commits.push(value); return 'ai-warn'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
        now: () => '2026-07-30T00:00:00.000Z'
      });
      return { run, commits };
    };

    const excluded = build(false);
    await expect(excluded.run.run({ runId: 'run-ai-warn-off', slotId: 'slot-ai-warn-off', includeWarnings: false })).resolves.toMatchObject({ status: 'quiet' });

    const included = build(true);
    await expect(included.run.run({ runId: 'run-ai-warn-on', slotId: 'slot-ai-warn-on', includeWarnings: true })).resolves.toMatchObject({ status: 'reported' });
  });

  it('excludes a loader warning ignored by integration instead of re-reporting it', async () => {
    const loaderLines = ['2026-09-06 01:11:37 WARNING (SyncWorker_0) [homeassistant.loader] We found a custom integration spook which has not been tested by Home Assistant'];
    const loaderEntries = parseHomeAssistantLog(loaderLines, { includeWarnings: true });
    const loaderPlan: SignaturePlan = { baselineEntries: [], signatures: loaderEntries.map((entry) => ({ ...entry, classification: 'latent' as const, trend: 'unknown' as const, occurrences: [entry] })) };
    const analyze = vi.fn(async () => ({ summary: 'unused', recommendation: 'unused' }));
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: loaderLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async () => loaderPlan },
      provider: { analyze },
      persistence: { commit: async () => 'loader-ignored', claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      ignores: { listActive: async () => [{ id: 'ignore-spook', match: 'spook', type: 'integration', createdAt: '2026-09-06T00:00:00.000Z' }] },
      now: () => '2026-09-06T02:00:00.000Z'
    });

    await expect(run.run({ runId: 'run-loader-ignored', slotId: 'slot-loader-ignored', includeWarnings: true })).resolves.toMatchObject({ status: 'quiet' });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('does not commit or advance the cursor when any AI extraction batch fails', async () => {
    const manyLines = Array.from({ length: 151 }, (_, index) => `raw line ${index + 1}`);
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: manyLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async (entries) => ({ baselineEntries: [], signatures: entries.map((entry) => ({ ...entry, classification: 'new' as const, trend: 'new' as const, occurrences: [entry] })) }) },
      provider: { analyze: async () => ({ summary: 'AI summary', recommendation: 'AI fix' }) },
      extractor: {
        extract: async ({ batch }) => {
          if (batch.startLine !== 1) throw new Error('second batch down');
          return { entries: [{ timestamp: '2026-07-29 12:00:00', level: 'ERROR', component: 'ha.second', message: 'second batch boom' }], rejectedCount: 0 };
        }
      },
      logMode: async () => 'ai',
      persistence: { commit: async (value) => { commits.push(value); return 'ai-partial'; }, claimDeliveryAttempt: async () => ({ status: 'pending' as const, shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      now: () => '2026-07-30T00:00:00.000Z'
    });

    await expect(run.run({ runId: 'run-ai-partial', slotId: 'slot-ai-partial' })).rejects.toThrow('AI_EXTRACTION_UNAVAILABLE');
    expect(commits).toHaveLength(0);
  });

  it('extracts every chunk sequentially beyond eight chunks and reports the final candidate', async () => {
    const manyLines = Array.from({ length: 1501 }, (_, index) => `raw line ${index + 1}`);
    const starts: number[] = [];
    const commits: Parameters<BatchPersistence['commit']>[0][] = [];
    let active = 0;
    const run = new BatchReportRun({
      log: { read: async () => ({ lines: manyLines, cursor: delta.cursor }) },
      signatures: { classifyAndStage: async (entries, now) => classifySignatures(entries, [], { now }) },
      provider: { analyze: async () => ({ summary: 'summary', recommendation: 'fix' }) },
      extractor: { extract: async ({ batch }) => {
        expect(active++).toBe(0);
        starts.push(batch.startLine);
        await Promise.resolve();
        active--;
        return { entries: [{ timestamp: '2026-07-29 12:00:00', level: 'ERROR', component: `ha.chunk${batch.startLine}`, message: 'problem' }], rejectedCount: 0 };
      } },
      logMode: async () => 'ai',
      persistence: { commit: async (value) => { commits.push(value); return 'all-chunks'; }, claimDeliveryAttempt: async () => ({ status: 'pending', shouldSend: false }), updateDeliveryStatus: async () => undefined, fail: async () => undefined },
      now: () => '2026-07-30T00:00:00.000Z'
    });
    await run.run({ runId: 'chunks', slotId: 'chunks' });
    expect(starts).toEqual(Array.from({ length: 11 }, (_, index) => 1 + index * 150));
    expect(commits[0]?.reportedSignatures).toHaveLength(11);
    expect(commits[0]?.reportedSignatures?.at(-1)).toMatchObject({ component: 'ha.chunk1501', analysisStatus: 'not_attempted' });
  });
});
