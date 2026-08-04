import { randomUUID } from 'node:crypto';
import type { PrivacyLevel } from '@ha-digest/shared';
import { buildRedactedDigestInput, prioritizeIncidents } from './incident-processing.js';
import type { CollectionResult } from '../domain/collectors.js';
import type { Incident } from '../domain/detectors.js';
import type { StructuredDigest } from '../domain/providers.js';
import type { RenderedDigest } from '../domain/renderers.js';
import type { ReportStore } from '../domain/stores.js';
import { createExecutionContext, raceWithCancellation, type ExecutionContext } from '../domain/execution.js';

export type ManualAnalysisDependencies = {
  collect(context: ExecutionContext): Promise<CollectionResult>;
  detect(facts: CollectionResult['facts'], context: ExecutionContext): Promise<Incident[]>;
  generate(input: ReturnType<typeof buildRedactedDigestInput>, context: ExecutionContext): Promise<StructuredDigest>;
  render(digest: StructuredDigest, context: ExecutionContext): Promise<RenderedDigest>;
  save(report: Parameters<ReportStore['save']>[0], context: ExecutionContext): Promise<void>;
  privacyLevel: PrivacyLevel;
  now?: () => string;
  timeoutMs?: number;
};

export type ManualAnalysisStage = 'collecting' | 'detecting' | 'generating' | 'rendering' | 'saving';

export class ManualAnalysis {
  private running = false;
  constructor(private readonly dependencies: ManualAnalysisDependencies) {}

  async run(): Promise<{ status: 'completed'; reportId: string }> {
    return this.runWithStages();
  }

  async runWithStages(onStage: (stage: ManualAnalysisStage) => void | Promise<void> = () => undefined): Promise<{ status: 'completed'; reportId: string }> {
    if (this.running) throw new Error('ANALYSIS_IN_PROGRESS');
    this.running = true;
    const context = createExecutionContext(this.dependencies.timeoutMs);
    const operation = this.execute(context, onStage);
    void operation.finally(() => {
      context.dispose();
      this.running = false;
    }).catch(() => undefined);
    return raceWithCancellation(operation, context);
  }

  private async execute(context: ExecutionContext, onStage: (stage: ManualAnalysisStage) => void | Promise<void>): Promise<{ status: 'completed'; reportId: string }> {
      context.checkpoint();
      const now = this.dependencies.now?.() ?? new Date().toISOString();
       await onStage('collecting');
       const collection = await this.stage(() => this.dependencies.collect(context), 'ANALYSIS_SOURCE_FAILED', context);
       await onStage('detecting');
       const incidents = await this.stage(() => this.dependencies.detect(collection.facts, context), 'ANALYSIS_SOURCE_FAILED', context);
      context.checkpoint();
      const input = buildRedactedDigestInput({
         window: { from: new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString(), to: now }, privacyLevel: this.dependencies.privacyLevel, incidents: prioritizeIncidents(incidents),
        entityStats: { factCount: collection.facts.length }, notes: [], unsupportedSignals: collection.unsupportedSignals
      });
       await onStage('generating');
       const digest = await this.stage(() => this.dependencies.generate(input, context), 'ANALYSIS_PROCESSING_FAILED', context);
       await onStage('rendering');
       const rendered = await this.stage(() => this.dependencies.render(digest, context), 'ANALYSIS_PROCESSING_FAILED', context);
      context.checkpoint();
      const reportId = randomUUID();
      const severityCounts = countSeverities(incidents);
       await onStage('saving');
       await this.stage(() => this.dependencies.save({ id: reportId, rendered, summary: { id: reportId, window: input.window, severityCounts, createdAt: now, deliveryStatus: 'pending' } }, context), 'ANALYSIS_SAVE_FAILED', context);
      return { status: 'completed', reportId };
  }

  private async stage<T>(operation: () => Promise<T>, fallback: string, context: ExecutionContext): Promise<T> {
    try {
      const result = await operation();
      context.checkpoint();
      return result;
    } catch (error) {
      if (context.signal.aborted) context.checkpoint();
      throw error instanceof Error && /^ANALYSIS_(DEADLINE_EXCEEDED|CANCELLED)$/.test(error.message) ? error : new Error(fallback);
    }
  }
}

function countSeverities(incidents: Incident[]) {
  return incidents.reduce((counts, incident) => ({ ...counts, [incident.severity]: counts[incident.severity] + 1 }), { critical: 0, warning: 0, info: 0 });
}
