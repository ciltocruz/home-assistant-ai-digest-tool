import type { BatchSignature, LogDelta, ParsedLogEntry, SignaturePlan } from '../domain/batch.js';
import { parseHomeAssistantLog } from '../domain/batch.js';
import type { DeliveryStatus, IgnoreRuleDto, NoteDto } from '@ha-digest/shared';
import type { IntegrationStatusSnapshot } from './integration-status.js';
import { redactProviderError } from '../domain/safe-error.js';

export type RunRequest = { runId: string; slotId: string; includeWarnings?: boolean };
export type SignatureAnalysis = { summary: string; recommendation: string };
export type BoundedSignatureContext = {
  signature: string;
  component: string;
  classification: BatchSignature['classification'];
  occurrences: string[];
};

export interface LogDeltaPort { read(): Promise<LogDelta>; }
export interface SignatureMemory { classifyAndStage(entries: ParsedLogEntry[], at: string): Promise<SignaturePlan>; }
export interface SignatureProvider { analyze(context: BoundedSignatureContext, signal: AbortSignal): Promise<SignatureAnalysis>; }
export interface BatchPersistence {
  commit(plan: CommitPlan): Promise<string>;
  getDeliveryStatus?(reportId: string): Promise<DeliveryStatus | null>;
  claimDeliveryAttempt(reportId: string): Promise<{ status: DeliveryStatus; shouldSend: boolean }>;
  updateDeliveryStatus(reportId: string, status: DeliveryStatus): Promise<void>;
  fail(run: FailedRun): Promise<void>;
}
export interface HAStatusPort { snapshot(): Promise<IntegrationStatusSnapshot>; }
export interface BatchNotifier { notify(summary: { findings: Array<{ signature: string; analysis: SignatureAnalysis }>; reportUrl?: string; language: 'en' | 'es' }): Promise<DeliveryStatus>; }

export type DeferredProviderAuth = { readonly status: 'deferred' };
export type CommitPlan = {
  request: RunRequest;
  cursor: LogDelta['cursor'];
  signatures: SignaturePlan;
  reportedSignatures?: SignaturePlan['signatures'];
  notesBySignature?: Record<string, NoteDto[]>;
  report: { status: 'quiet' | 'reported' | 'partial'; deliveryStatus?: DeliveryStatus; findings: Array<{ signature: string; analysis: SignatureAnalysis }>; warnings: string[]; integrationStatus?: IntegrationStatusSnapshot };
};
export type FailedRun = { request: RunRequest; code: 'AI_ANALYSIS_UNAVAILABLE'; errorMessage: string };
export type RunOutcome =
  | { status: 'quiet' | 'reported' | 'partial'; warnings: string[]; reportId: string; deliveryStatus?: DeliveryStatus }
  | { status: 'failed'; code: 'AI_ANALYSIS_UNAVAILABLE'; errorMessage: string };

export type BatchReportRunDependencies = {
  log: LogDeltaPort;
  signatures: SignatureMemory;
  provider: SignatureProvider;
  persistence: BatchPersistence;
  now?: () => string;
  maxContextOccurrences?: number;
  maxContextBytes?: number;
  providerAuth?: DeferredProviderAuth;
  haStatus?: HAStatusPort;
  notifier?: BatchNotifier;
  ignores?: { listActive(at: string): Promise<IgnoreRuleDto[]> };
  notes?: { listWindow(window: { from: string; to: string }): Promise<NoteDto[]> };
  reportUrl?: (request: RunRequest) => string | undefined;
  language?: () => Promise<'en' | 'es'>;
};

export class BatchReportRun {
  constructor(private readonly dependencies: BatchReportRunDependencies) {}

  async run(request: RunRequest): Promise<RunOutcome> {
    const delta = await this.dependencies.log.read();
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const plan = await this.dependencies.signatures.classifyAndStage(
      parseHomeAssistantLog(delta.lines, { includeWarnings: request.includeWarnings }),
      now
    );
    const [rules, notes] = await Promise.all([
      this.dependencies.ignores?.listActive(now) ?? [],
      this.dependencies.notes?.listWindow({ from: '1970-01-01T00:00:00.000Z', to: now }) ?? []
    ]);
    const reportedSignatures = plan.signatures.filter((signature) => !isIgnored(signature, rules));
    const notesBySignature = notesForSignatures(reportedSignatures, notes);
    const integrationStatus = await this.readIntegrationStatus();
    if (reportedSignatures.length === 0) {
      const reportId = await this.dependencies.persistence.commit({ request, cursor: delta.cursor, signatures: plan, reportedSignatures, notesBySignature, report: { status: 'quiet', deliveryStatus: 'skipped', findings: [], warnings: [], integrationStatus } });
      return { status: 'quiet', warnings: [], reportId };
    }

    const analyses = await Promise.all(reportedSignatures.map(async (signature) => {
      try {
        return { signature, analysis: await this.dependencies.provider.analyze(this.contextFor(signature), new AbortController().signal), error: undefined };
      } catch (error) {
        return { signature, analysis: null, error };
      }
    }));
    const findings = analyses.flatMap(({ signature, analysis }) => analysis ? [{ signature: signature.signature, analysis }] : []);
    if (findings.length === 0) {
      const errorMessage = firstProviderFailureMessage(analyses.map(({ error }) => error));
      await this.dependencies.persistence.fail({ request, code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage });
      return { status: 'failed', code: 'AI_ANALYSIS_UNAVAILABLE', errorMessage };
    }
    const warnings = findings.length === analyses.length ? [] : ['AI_ANALYSIS_PARTIAL'];
    const status = warnings.length ? 'partial' : 'reported';
    const report: CommitPlan['report'] = { status, deliveryStatus: 'pending', findings, warnings, integrationStatus };
    const reportId = await this.dependencies.persistence.commit({ request, cursor: delta.cursor, signatures: plan, reportedSignatures, notesBySignature, report });
    if (await this.dependencies.persistence.getDeliveryStatus?.(reportId) === 'sent') {
      return { status, warnings, reportId, deliveryStatus: 'sent' };
    }
    let deliveryStatus: DeliveryStatus = 'skipped';
    try {
      if (this.dependencies.notifier) {
        const attempt = await this.dependencies.persistence.claimDeliveryAttempt(reportId);
        if (!attempt.shouldSend) return { status, warnings, reportId, deliveryStatus: attempt.status };
        deliveryStatus = await this.dependencies.notifier.notify({ findings, reportUrl: this.dependencies.reportUrl?.(request), language: await this.dependencies.language?.() ?? 'en' });
      }
    } catch {
      // An exception leaves external delivery unknown; pending prevents an automatic duplicate.
      deliveryStatus = 'pending';
    }
    report.deliveryStatus = deliveryStatus;
    try {
      await this.dependencies.persistence.updateDeliveryStatus(reportId, deliveryStatus);
    } catch {
      // The notification outcome is known; do not make a committed run retryable because its status write failed.
      return { status, warnings: [...warnings, 'DELIVERY_STATUS_PERSISTENCE_FAILED'], reportId, deliveryStatus };
    }
    return { status, warnings, reportId };
  }

  private async readIntegrationStatus(): Promise<IntegrationStatusSnapshot> {
    try {
      return await this.dependencies.haStatus?.snapshot() ?? { available: false, integrations: [] };
    } catch {
      return { available: false, integrations: [] };
    }
  }

  private contextFor(signature: BatchSignature): BoundedSignatureContext {
    const occurrences: string[] = [];
    let bytes = 0;
    for (const occurrence of signature.occurrences.slice(0, this.dependencies.maxContextOccurrences ?? 3)) {
      const value = redact(occurrence.message);
      const size = Buffer.byteLength(value);
      if (bytes + size > (this.dependencies.maxContextBytes ?? 2_048)) break;
      occurrences.push(value);
      bytes += size;
    }
    return { signature: signature.signature, component: signature.component, classification: signature.classification, occurrences };
  }
}

function isIgnored(signature: BatchSignature, rules: IgnoreRuleDto[]): boolean {
  const haystack = `${signature.signature} ${signature.component} ${signature.normalizedMessage}`.toLowerCase();
  return rules.some((rule) => haystack.includes(rule.match.toLowerCase()));
}

function notesForSignatures(signatures: BatchSignature[], notes: NoteDto[]): Record<string, NoteDto[]> {
  return Object.fromEntries(signatures.map((signature) => [
    signature.signature,
    notes.filter((note) => note.tags.includes(signature.signature)).slice(0, 10)
  ]).filter(([, attached]) => attached.length > 0));
}

function redact(value: string): string {
  return redactProviderError(value);
}

function firstProviderFailureMessage(errors: unknown[]): string {
  const detail = errors.find((error): error is Error => error instanceof Error && error.message.length > 0)?.message;
  return redactProviderError(detail ?? 'The AI provider failed without an error message.');
}
