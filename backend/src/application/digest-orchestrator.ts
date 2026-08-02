import { randomUUID } from 'node:crypto';
import type { DeliveryResult, DigestSummary, PrivacyLevel } from '@ha-digest/shared';
import type { Collector, UnsupportedSignal } from '../domain/collectors.js';
import type { IncidentDetector, Incident } from '../domain/detectors.js';
import type { DigestJob, DigestJobStore } from '../domain/jobs.js';
import type { Notifier, ResolvedTargetConfig } from '../domain/notifiers.js';
import type { AIProvider, RedactedDigestInput } from '../domain/providers.js';
import type { ReportRenderer, RenderedDigest } from '../domain/renderers.js';
import type { DeliveryStore, IgnoreRuleStore, NoteStore, ReportStore } from '../domain/stores.js';
import { applyIgnoreRules, buildRedactedDigestInput, prioritizeIncidents } from './incident-processing.js';
import { createExecutionContext, type ExecutionContext } from '../domain/execution.js';

export type TransactionBoundary = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export type DigestRunContextStore = {
  save(context: {
    jobId: string;
    window: { from: string; to: string };
    incidents: Incident[];
    unsupportedSignals: UnsupportedSignal[];
    providerInput: RedactedDigestInput;
    capturedAt: string;
  }): Promise<void>;
};

export type DigestNotifierTarget = ResolvedTargetConfig & { targetRef: string };

export type DigestOrchestratorResult =
  | { status: 'idle' }
  | { status: 'completed'; jobId: string; reportId: string }
  | { status: 'retrying'; jobId: string; stage: RuntimeFailureStage };

export type RuntimeFailureStage = 'collector' | 'detector' | 'provider' | 'renderer' | 'notifier';

export type DigestOperationalFailureEvent = {
  jobId: string;
  stage: RuntimeFailureStage;
  errorName: string;
};

type DigestOrchestratorOptions = {
  collectors: Collector[];
  detectors: IncidentDetector[];
  provider: AIProvider;
  renderer: ReportRenderer;
  notifiers: Notifier[];
  notifierTargets: DigestNotifierTarget[];
  reportStore: ReportStore;
  deliveryStore: DeliveryStore;
  contextStore: DigestRunContextStore;
  jobStore: Pick<DigestJobStore, 'leaseNext' | 'complete' | 'retry'>;
  transaction: TransactionBoundary;
  ignoreRules?: Pick<IgnoreRuleStore, 'listActive'>;
  notes?: Pick<NoteStore, 'listWindow'>;
  privacyLevel: PrivacyLevel;
  now?: () => string;
  /** Receives secret-safe operational failure events. Do not include raw error messages here. */
  failureReporter?: (event: DigestOperationalFailureEvent) => void;
};

export class DigestOrchestrator {
  private readonly now: () => string;

  constructor(private readonly options: DigestOrchestratorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runNext(): Promise<DigestOrchestratorResult> {
    const job = await this.options.jobStore.leaseNext();
    if (!job) return { status: 'idle' };
    const execution = createExecutionContext();

    let context: Parameters<DigestRunContextStore['save']>[0];
    try {
      context = await this.buildContext(job, execution);
    } catch (error) {
      const stage = error instanceof DigestStageFailure ? error.stage : 'collector';
      return this.retryWithoutContext(job, stage, error);
    }

    let digest: Awaited<ReturnType<AIProvider['generate']>>;
    try {
      digest = await this.options.provider.generate(context.providerInput, execution);
    } catch (error) {
      this.reportFailure(job.id, 'provider', error);
      await this.options.transaction.run(async () => {
        await this.options.contextStore.save(context);
        await this.options.jobStore.retry(job.id, 'provider failed');
      });
      return { status: 'retrying', jobId: job.id, stage: 'provider' };
    }

    let rendered: RenderedDigest;
    try {
      rendered = await this.options.renderer.render(digest, execution);
    } catch (error) {
      this.reportFailure(job.id, 'renderer', error);
      await this.options.transaction.run(async () => {
        await this.options.contextStore.save(context);
        await this.options.jobStore.retry(job.id, 'renderer failed');
      });
      return { status: 'retrying', jobId: job.id, stage: 'renderer' };
    }

    const reportId = randomUUID();
    const sentDeliveries: Array<DeliveryResult & { digestId: string }> = [];

    for (const target of this.options.notifierTargets) {
      try {
        const notifier = this.findNotifier(target);
        const delivery = { ...(await notifier.send(rendered, target)), digestId: reportId };
        if (delivery.status === 'failed') {
          this.reportFailure(job.id, 'notifier', new DeliveryFailureError());
          sentDeliveries.push(this.failedDelivery(reportId, target.targetRef));
          await this.options.transaction.run(async () => {
            await this.options.contextStore.save(context);
            await this.saveReport(reportId, rendered, context, 'failed');
            for (const sentDelivery of sentDeliveries) await this.options.deliveryStore.record(sentDelivery);
            await this.options.jobStore.retry(job.id, 'notifier failed');
          });
          return { status: 'retrying', jobId: job.id, stage: 'notifier' };
        }
        sentDeliveries.push(delivery);
      } catch (error) {
        this.reportFailure(job.id, 'notifier', error);
        const failedDelivery = this.failedDelivery(reportId, target.targetRef);
        await this.options.transaction.run(async () => {
          await this.options.contextStore.save(context);
          await this.saveReport(reportId, rendered, context, 'failed');
          for (const delivery of sentDeliveries) await this.options.deliveryStore.record(delivery);
          await this.options.deliveryStore.record(failedDelivery);
          await this.options.jobStore.retry(job.id, 'notifier failed');
        });
        return { status: 'retrying', jobId: job.id, stage: 'notifier' };
      }
    }

    await this.options.transaction.run(async () => {
      await this.options.contextStore.save(context);
      await this.saveReport(reportId, rendered, context, this.deliveryStatus(sentDeliveries));
      for (const delivery of sentDeliveries) await this.options.deliveryStore.record(delivery);
      await this.options.jobStore.complete(job.id);
    });
    execution.dispose();
    return { status: 'completed', jobId: job.id, reportId };
  }

  private async buildContext(job: DigestJob, execution: ExecutionContext): Promise<Parameters<DigestRunContextStore['save']>[0]> {
    const window = parseWindow(job.triggerWindowId, this.now());
    let collections: Awaited<ReturnType<Collector['collect']>>[];
    try {
      collections = await Promise.all(this.options.collectors.map((collector) => collector.collect(execution)));
    } catch (error) {
      throw new DigestStageFailure('collector', error);
    }
    const facts = collections.flatMap((collection) => collection.facts);
    const unsupportedSignals = collections.flatMap((collection) => collection.unsupportedSignals);
    let detected: Incident[];
    try {
      detected = (await Promise.all(this.options.detectors.map((detector) => detector.detect(facts, execution)))).flat();
    } catch (error) {
      throw new DigestStageFailure('detector', error);
    }
    const rules = (await this.options.ignoreRules?.listActive(this.now())) ?? [];
    const notes = (await this.options.notes?.listWindow(window)) ?? [];
    const incidents = prioritizeIncidents(applyIgnoreRules(detected, rules, this.now()));
    const providerInput = buildRedactedDigestInput({
      window,
      privacyLevel: this.options.privacyLevel,
      incidents,
      entityStats: { factCount: facts.length },
      notes: notes.map((note) => ({ id: note.id, text: note.text, occurredAt: note.occurredAt })),
      unsupportedSignals
    });

    return { jobId: job.id, window, incidents: providerInput.incidents, unsupportedSignals: providerInput.unsupportedSignals, providerInput, capturedAt: this.now() };
  }

  private findNotifier(target: DigestNotifierTarget): Notifier {
    const notifier = this.options.notifiers.find((candidate) => candidate.channel === target.channel);
    if (!notifier) throw new Error('Notifier not configured');
    return notifier;
  }

  private async saveReport(
    id: string,
    rendered: RenderedDigest,
    context: Parameters<DigestRunContextStore['save']>[0],
    deliveryStatus: DigestSummary['deliveryStatus']
  ): Promise<void> {
    await this.options.reportStore.save({
      id,
      rendered,
      summary: {
        id,
        window: context.window,
        severityCounts: severityCounts(context.incidents),
        createdAt: this.now(),
        deliveryStatus
      }
    });
  }

  private deliveryStatus(deliveries: Array<DeliveryResult & { digestId: string }>): DigestSummary['deliveryStatus'] {
    if (deliveries.length === 0) return 'skipped';
    return deliveries.some((delivery) => delivery.status === 'failed') ? 'failed' : 'sent';
  }

  private failedDelivery(digestId: string, targetRef: string): DeliveryResult & { digestId: string } {
    return { digestId, status: 'failed', targetRef, errorCode: 'NOTIFIER_FAILED', message: 'Delivery failed.', deliveredAt: undefined };
  }

  private async retryWithoutContext(job: DigestJob, stage: RuntimeFailureStage, error: unknown): Promise<DigestOrchestratorResult> {
    this.reportFailure(job.id, stage, error instanceof DigestStageFailure ? error.cause : error);
    await this.options.transaction.run(async () => {
      await this.options.jobStore.retry(job.id, `${stage} failed`);
    });
    return { status: 'retrying', jobId: job.id, stage };
  }

  private reportFailure(jobId: string, stage: RuntimeFailureStage, error: unknown): void {
    try {
      this.options.failureReporter?.({ jobId, stage, errorName: getErrorName(error) });
    } catch {
      // Never let telemetry/reporting failures change the digest retry path.
    }
  }
}

class DigestStageFailure extends Error {
  constructor(readonly stage: RuntimeFailureStage, readonly cause: unknown) {
    super(`${stage} failed`);
    this.name = 'DigestStageFailure';
  }
}

class DeliveryFailureError extends Error {
  constructor() {
    super('delivery failed');
    this.name = 'DeliveryFailure';
  }
}

function getErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function severityCounts(incidents: Incident[]): DigestSummary['severityCounts'] {
  return incidents.reduce(
    (counts, incident) => ({ ...counts, [incident.severity]: counts[incident.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 }
  );
}

function parseWindow(triggerWindowId: string, fallbackTo: string): { from: string; to: string } {
  const match = triggerWindowId.match(/^[^:]+:(\d{4}-.+?Z):(\d{4}-.+Z)$/);
  if (match?.[1] && match[2]) return { from: match[1], to: match[2] };

  const to = new Date(fallbackTo);
  return { from: new Date(to.getTime() - 86_400_000).toISOString(), to: to.toISOString() };
}
