import { describe, expect, it, vi } from 'vitest';
import { BatchReportRun, type BatchPersistence, type SignatureMemory, type SignatureProvider } from './batch-report-run.js';
import { parseHomeAssistantLog, type LogDelta, type SignaturePlan } from '../domain/batch.js';
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
  it('analyzes every signature without a signature limit and atomically stages cursor and report', async () => {
    const analyze = vi.fn(async (context) => ({ summary: context.signature, recommendation: 'fix it' }));
    const { run, commits, deliveryUpdates } = harness(analyze);

    await expect(run.run({ runId: 'run-1', slotId: 'slot-1' })).resolves.toEqual({ status: 'reported', warnings: [], reportId: 'report-id' });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(analyze.mock.calls[0]?.[0].occurrences).toEqual(['one token=[REDACTED]']);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ cursor: delta.cursor, report: { status: 'reported', deliveryStatus: 'skipped', findings: [{}, {}, {}] } });
    expect(deliveryUpdates).toEqual([{ reportId: 'report-id', status: 'skipped' }]);
  });

  it('commits available findings with a partial-analysis warning when one signature provider call fails', async () => {
    const { run, commits, failures } = harness(async (context) => {
      if (context.component === 'ha.two') throw new Error('provider down');
      return { summary: context.component, recommendation: 'fix it' };
    });

    await expect(run.run({ runId: 'run-2', slotId: 'slot-2' })).resolves.toEqual({ status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'], reportId: 'report-id' });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.report.warnings).toEqual(['AI_ANALYSIS_PARTIAL']);
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

  it('records an all-provider failure as a web-only failed run without advancing the cursor', async () => {
    const providerSecret = 'AIzaSyA1B2C3D4E5F6G7H8';
    const { run, commits, failures } = harness(async () => { throw new Error(`Gemini request failed at https://example.test/generate?key=${providerSecret}`); });

    await expect(run.run({ runId: 'run-3', slotId: 'slot-3' })).resolves.toEqual({ status: 'failed', code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: 'Gemini request failed at https://example.test/generate?key=[REDACTED]' });
    expect(commits).toEqual([]);
    expect(failures).toEqual([{ request: { runId: 'run-3', slotId: 'slot-3' }, code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage: 'Gemini request failed at https://example.test/generate?key=[REDACTED]' }]);
    expect(JSON.stringify(failures)).not.toContain(providerSecret);
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
    expect(deliveryUpdateAttempts).toBe(1);
    await worker.runOnce();
    expect(notificationAttempts).toBe(1);
  });
});
