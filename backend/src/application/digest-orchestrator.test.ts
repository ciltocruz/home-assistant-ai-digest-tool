import { describe, expect, it } from 'vitest';
import type { CollectedFact } from '../domain/collectors.js';
import type { Incident } from '../domain/detectors.js';
import type { DigestJob } from '../domain/jobs.js';
import type { DeliveryStore, ReportStore } from '../domain/stores.js';
import { DigestOrchestrator, type DigestRunContextStore, type TransactionBoundary } from './digest-orchestrator.js';

const window = { from: '2026-07-07T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' };
const now = '2026-07-08T08:00:00.000Z';

describe('DigestOrchestrator', () => {
  it('preserves incidents and retry state when the provider fails', async () => {
    const contextStore = new FakeContextStore();
    const jobStore = new FakeJobStore(job('provider-failure'));
    const transaction = new RecordingTransaction();
    const orchestrator = createOrchestrator({
      contextStore,
      jobStore,
      transaction,
      provider: { id: 'fake', generate: async () => { throw new Error('provider token=synthetic-secret failed'); } }
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'provider-failure', stage: 'provider' });

    expect(contextStore.saved).toHaveLength(1);
    expect(contextStore.saved[0]?.incidents.map((incident) => incident.id)).toEqual(['incident-1']);
    expect(JSON.stringify(contextStore.saved[0]?.providerInput)).not.toContain('synthetic-secret');
    expect(jobStore.retried).toEqual([{ id: 'provider-failure', reason: 'provider failed' }]);
    expect(transaction.commits).toBe(1);
  });

  it('preserves generated reports and delivery failure state when a notifier fails', async () => {
    const reportStore = new FakeReportStore();
    const deliveryStore = new FakeDeliveryStore();
    const jobStore = new FakeJobStore(job('notifier-failure'));
    const orchestrator = createOrchestrator({
      reportStore,
      deliveryStore,
      jobStore,
      notifiers: [{ channel: 'telegram', test: async () => ({ status: 'success', message: 'ok', checkedAt: now }), send: async () => { throw new Error('telegram bot token=synthetic-secret failed'); } }]
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'notifier-failure', stage: 'notifier' });

    expect(reportStore.saved).toHaveLength(1);
    expect(deliveryStore.recorded).toEqual([{ digestId: reportStore.saved[0]?.id, status: 'failed', targetRef: 'telegram-main', errorCode: 'NOTIFIER_FAILED', message: 'Delivery failed.', deliveredAt: undefined }]);
    expect(JSON.stringify(deliveryStore.recorded)).not.toContain('synthetic-secret');
    expect(jobStore.retried).toEqual([{ id: 'notifier-failure', reason: 'notifier failed' }]);
  });

  it('retries and reports a redacted operational event when a collector fails', async () => {
    const jobStore = new FakeJobStore(job('collector-failure'));
    const operationalEvents: unknown[] = [];
    const orchestrator = createOrchestrator({
      jobStore,
      collectors: [{ id: 'collector', collect: async () => { throw new Error('collector token=synthetic-secret failed'); } }],
      failureReporter: (event) => operationalEvents.push(event)
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'collector-failure', stage: 'collector' });

    expect(jobStore.retried).toEqual([{ id: 'collector-failure', reason: 'collector failed' }]);
    expect(JSON.stringify(operationalEvents)).not.toContain('synthetic-secret');
    expect(operationalEvents).toEqual([expect.objectContaining({ jobId: 'collector-failure', stage: 'collector', errorName: 'Error' })]);
  });

  it('retries and reports a redacted operational event when a detector fails', async () => {
    const jobStore = new FakeJobStore(job('detector-failure'));
    const operationalEvents: unknown[] = [];
    const orchestrator = createOrchestrator({
      jobStore,
      detectors: [{ id: 'detector', detect: async () => { throw new Error('detector token=synthetic-secret failed'); } }],
      failureReporter: (event) => operationalEvents.push(event)
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'detector-failure', stage: 'detector' });

    expect(jobStore.retried).toEqual([{ id: 'detector-failure', reason: 'detector failed' }]);
    expect(JSON.stringify(operationalEvents)).not.toContain('synthetic-secret');
    expect(operationalEvents).toEqual([expect.objectContaining({ jobId: 'detector-failure', stage: 'detector', errorName: 'Error' })]);
  });

  it('preserves context, retries, and reports a redacted operational event when rendering fails', async () => {
    const contextStore = new FakeContextStore();
    const jobStore = new FakeJobStore(job('renderer-failure'));
    const operationalEvents: unknown[] = [];
    const orchestrator = createOrchestrator({
      contextStore,
      jobStore,
      renderer: { render: async () => { throw new Error('renderer token=synthetic-secret failed'); } },
      failureReporter: (event) => operationalEvents.push(event)
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'renderer-failure', stage: 'renderer' });

    expect(contextStore.saved).toHaveLength(1);
    expect(contextStore.saved[0]?.incidents.map((incident) => incident.id)).toEqual(['incident-1']);
    expect(jobStore.retried).toEqual([{ id: 'renderer-failure', reason: 'renderer failed' }]);
    expect(JSON.stringify(operationalEvents)).not.toContain('synthetic-secret');
    expect(operationalEvents).toEqual([expect.objectContaining({ jobId: 'renderer-failure', stage: 'renderer', errorName: 'Error' })]);
  });

  it('treats failed delivery results as notifier failures without persisting adapter secrets', async () => {
    const reportStore = new FakeReportStore();
    const deliveryStore = new FakeDeliveryStore();
    const jobStore = new FakeJobStore(job('failed-delivery-result'));
    const orchestrator = createOrchestrator({
      reportStore,
      deliveryStore,
      jobStore,
      notifiers: [
        {
          channel: 'telegram',
          test: async () => ({ status: 'success', message: 'ok', checkedAt: now }),
          send: async () => ({
            status: 'failed',
            targetRef: 'chat_id=synthetic-secret-target',
            errorCode: 'TELEGRAM_TOKEN_synthetic-secret-code',
            message: 'Telegram rejected bot token=synthetic-secret-message.'
          })
        }
      ]
    });

    await expect(orchestrator.runNext()).resolves.toEqual({ status: 'retrying', jobId: 'failed-delivery-result', stage: 'notifier' });

    expect(reportStore.saved).toHaveLength(1);
    expect(reportStore.saved[0]?.summary.deliveryStatus).toBe('failed');
    expect(deliveryStore.recorded).toEqual([
      { digestId: reportStore.saved[0]?.id, status: 'failed', targetRef: 'telegram-main', errorCode: 'NOTIFIER_FAILED', message: 'Delivery failed.', deliveredAt: undefined }
    ]);
    expect(JSON.stringify(deliveryStore.recorded)).not.toContain('synthetic-secret');
    expect(jobStore.completed).toEqual([]);
    expect(jobStore.retried).toEqual([{ id: 'failed-delivery-result', reason: 'notifier failed' }]);
  });

  it('persists redacted run context instead of raw incident and unsupported signal text', async () => {
    const contextStore = new FakeContextStore();
    const orchestrator = createOrchestrator({
      contextStore,
      detectors: [{ id: 'detector', detect: async () => [incident('Token rawIncidentSecret123 failed')] }],
      collectors: [
        {
          id: 'collector',
          collect: async () => ({
            facts: [fact()],
            unsupportedSignals: [{ source: 'supervisor', reason: 'Supervisor token=rawUnsupportedSecret123 is unavailable in Docker/Core mode' }]
          })
        }
      ]
    });

    await expect(orchestrator.runNext()).resolves.toMatchObject({ status: 'completed' });

    expect(JSON.stringify(contextStore.saved[0])).not.toContain('rawIncidentSecret123');
    expect(JSON.stringify(contextStore.saved[0])).not.toContain('rawUnsupportedSecret123');
    expect(contextStore.saved[0]?.incidents[0]?.summary).toContain('[REDACTED]');
    expect(contextStore.saved[0]?.unsupportedSignals[0]?.reason).toContain('[REDACTED]');
  });

  it('stores report deliveries and completes the job on success', async () => {
    const reportStore = new FakeReportStore();
    const deliveryStore = new FakeDeliveryStore();
    const jobStore = new FakeJobStore(job('success'));
    const orchestrator = createOrchestrator({ reportStore, deliveryStore, jobStore });

    const result = await orchestrator.runNext();

    expect(result).toEqual({ status: 'completed', jobId: 'success', reportId: reportStore.saved[0]?.id });
    expect(reportStore.saved[0]?.summary.deliveryStatus).toBe('sent');
    expect(deliveryStore.recorded[0]).toMatchObject({ digestId: reportStore.saved[0]?.id, status: 'sent', targetRef: 'telegram-main' });
    expect(jobStore.completed).toEqual(['success']);
  });
});

function createOrchestrator(overrides: Partial<ConstructorParameters<typeof DigestOrchestrator>[0]> = {}) {
  return new DigestOrchestrator({
    collectors: [{ id: 'collector', collect: async () => ({ facts: [fact()], unsupportedSignals: [] }) }],
    detectors: [{ id: 'detector', detect: async () => [incident()] }],
    provider: { id: 'fake', generate: async () => ({ severity: 'warning', summary: 'Summary', attentionItems: [] }) },
    renderer: { render: async () => ({ format: 'markdown', body: '# Digest' }) },
    notifiers: [{ channel: 'telegram', test: async () => ({ status: 'success', message: 'ok', checkedAt: now }), send: async () => ({ status: 'sent', targetRef: 'telegram-main', deliveredAt: now }) }],
    notifierTargets: [{ channel: 'telegram', label: 'Telegram', config: {}, targetRef: 'telegram-main' }],
    reportStore: new FakeReportStore(),
    deliveryStore: new FakeDeliveryStore(),
    contextStore: new FakeContextStore(),
    jobStore: new FakeJobStore(job('default')),
    transaction: new RecordingTransaction(),
    privacyLevel: 'balanced',
    now: () => now,
    ...overrides
  });
}

function fact(): CollectedFact {
  return { id: 'fact-1', source: 'ha', observedAt: now, summary: 'Entity unavailable' };
}

function incident(summary = 'Sensor unavailable'): Incident {
  return { id: 'incident-1', type: 'entity', severity: 'warning', summary, redactedEvidence: [summary], detectedAt: now };
}

function job(id: string): DigestJob {
  return { id, triggerWindowId: `manual:${window.from}:${window.to}`, kind: 'manual', status: 'running', stage: 'queued', attempts: 0, retryCount: 0, retryAvailable: false, availableAt: now, createdAt: now, updatedAt: now };
}

class FakeJobStore {
  completed: string[] = [];
  retried: Array<{ id: string; reason: string }> = [];
  constructor(private readonly next: DigestJob | null) {}
  async leaseNext() { return this.next; }
  async complete(id: string) { this.completed.push(id); }
  async retry(id: string, reason: string) { this.retried.push({ id, reason }); }
}

class FakeReportStore implements ReportStore {
  saved: Array<Parameters<ReportStore['save']>[0] & { id: string }> = [];
  async save(report: Parameters<ReportStore['save']>[0]) { this.saved.push({ ...report, id: report.id }); }
  async list() { return this.saved.map((report) => report.summary); }
  async get(id: string) { return this.saved.find((report) => report.id === id) ?? null; }
}

class FakeDeliveryStore implements DeliveryStore {
  recorded: Array<Parameters<DeliveryStore['record']>[0]> = [];
  async record(delivery: Parameters<DeliveryStore['record']>[0]) { this.recorded.push(delivery); }
}

class FakeContextStore implements DigestRunContextStore {
  saved: Array<Parameters<DigestRunContextStore['save']>[0]> = [];
  async save(context: Parameters<DigestRunContextStore['save']>[0]) { this.saved.push(context); }
}

class RecordingTransaction implements TransactionBoundary {
  commits = 0;
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const value = await operation();
    this.commits += 1;
    return value;
  }
}
