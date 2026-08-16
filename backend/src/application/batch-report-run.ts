import type { BatchSignature, LogDelta, LogReadRange, ParsedLogEntry, SignaturePlan } from '../domain/batch.js';
import { parseHomeAssistantLog } from '../domain/batch.js';
import type { DeliveryDiagnostic, DeliveryDiagnosticErrorCode, DeliveryResult, DeliveryStatus, IgnoreRuleDto, NoteDto } from '@ha-digest/shared';
import type { IntegrationStatusFailureReason, IntegrationStatusSnapshot } from './integration-status.js';
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
export interface SignatureProvider { analyze(context: BoundedSignatureContext, signal: AbortSignal, language?: 'en' | 'es'): Promise<SignatureAnalysis>; }
export interface BatchPersistence {
  commit(plan: CommitPlan): Promise<string>;
  getDeliveryStatus?(reportId: string): Promise<DeliveryStatus | null>;
  claimDeliveryAttempt(reportId: string): Promise<{ status: DeliveryStatus; shouldSend: boolean }>;
  updateDeliveryStatus(reportId: string, status: DeliveryStatus, diagnostic?: DeliveryDiagnostic): Promise<void>;
  fail(run: FailedRun): Promise<void>;
}
export interface HAStatusPort { snapshot(): Promise<IntegrationStatusSnapshot>; }
export interface BatchNotifier { notify(summary: { findings: Array<{ signature: string; analysis: SignatureAnalysis }>; reportUrl?: string; language: 'en' | 'es' }): Promise<DeliveryStatus | DeliveryResult>; }

export type BatchOperationalEvent =
  | { event: 'report_collection_completed'; lineCount: number; signatureCount: number; durationMs: number }
  | { event: 'report_collection_failed' }
  | { event: 'report_analysis_completed'; analyzedCount: number; failedCount: number; durationMs: number; error?: string }
  | { event: 'report_commit_completed'; reportId: string; status: 'quiet' | 'reported' | 'partial'; signatureCount: number }
  | { event: 'report_commit_failed' }
  | { event: 'ha_snapshot_completed'; integrationCount: number; durationMs: number }
  | { event: 'ha_snapshot_failed'; reason: IntegrationStatusFailureReason; durationMs: number }
  | { event: 'telegram_delivery_started' }
  | { event: 'telegram_delivery_completed'; outcome: DeliveryStatus; errorCode?: DeliveryDiagnosticErrorCode; durationMs: number };

export type DeferredProviderAuth = { readonly status: 'deferred' };
export type CommitPlan = {
  request: RunRequest;
  cursor: LogDelta['cursor'];
  signatures: SignaturePlan;
  logRead: LogReadRange | null;
  reportedSignatures?: SignaturePlan['signatures'];
  notesBySignature?: Record<string, NoteDto[]>;
  report: {
    status: 'quiet' | 'reported' | 'partial';
    deliveryStatus?: DeliveryStatus;
    findings: Array<{ signature: string; analysis: SignatureAnalysis }>;
    warnings: string[];
    failure?: string;
    integrationStatus?: IntegrationStatusSnapshot;
  };
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
  reportUrl?: (reportId: string) => string | undefined;
  language?: () => Promise<'en' | 'es'>;
  eventReporter?: (event: BatchOperationalEvent) => void;
  clock?: () => number;
};

export class BatchReportRun {
  constructor(private readonly dependencies: BatchReportRunDependencies) {}

  async run(request: RunRequest): Promise<RunOutcome> {
    const collectionStarted = this.time();
    let delta: LogDelta;
    try {
      delta = await this.dependencies.log.read();
    } catch (error) {
      this.report({ event: 'report_collection_failed' });
      throw error;
    }
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const entries = parseHomeAssistantLog(delta.lines, { includeWarnings: request.includeWarnings });
    const plan = await this.dependencies.signatures.classifyAndStage(entries, now);
    const logRead: LogReadRange | null = entries.length > 0 ? { from: entries[0].at, to: entries[entries.length - 1].at } : null;
    const [rules, notes] = await Promise.all([
      this.dependencies.ignores?.listActive(now) ?? [],
      this.dependencies.notes?.listWindow({ from: '1970-01-01T00:00:00.000Z', to: now }) ?? []
    ]);
    const filteredSignatures = plan.signatures.filter((signature) => !isIgnored(signature, rules));
    const sortedSignatures = [...filteredSignatures].sort((a, b) => b.occurrences.length - a.occurrences.length);
    const reportedSignatures = sortedSignatures.slice(0, 10);
    this.report({ event: 'report_collection_completed', lineCount: delta.lines.length, signatureCount: reportedSignatures.length, durationMs: this.duration(collectionStarted) });
    const notesBySignature = notesForSignatures(reportedSignatures, notes);
    const integrationStatus = await this.readIntegrationStatus();
    if (reportedSignatures.length === 0) {
      const reportId = await this.commit({ request, cursor: delta.cursor, signatures: plan, logRead, reportedSignatures, notesBySignature, report: { status: 'quiet', deliveryStatus: 'skipped', findings: [], warnings: [], integrationStatus } });
      this.report({ event: 'report_commit_completed', reportId, status: 'quiet', signatureCount: 0 });
      return { status: 'quiet', warnings: [], reportId };
    }

    const language = await this.dependencies.language?.() ?? 'en';
    const analysisStarted = this.time();
    const analyses: Array<{ signature: BatchSignature; analysis: SignatureAnalysis | null; error?: unknown }> = [];
    let firstError: string | undefined;
    for (const signature of reportedSignatures) {
      try {
        const analysis = await this.dependencies.provider.analyze(this.contextFor(signature), new AbortController().signal, language);
        analyses.push({ signature, analysis, error: undefined });
      } catch (error) {
        if (!firstError) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          firstError = redactProviderError(rawMessage);
        }
        analyses.push({ signature, analysis: null, error });
      }
    }
    const findings = analyses.flatMap(({ signature, analysis }) => analysis ? [{ signature: signature.signature, analysis }] : []);
    this.report({
      event: 'report_analysis_completed',
      analyzedCount: findings.length,
      failedCount: analyses.length - findings.length,
      durationMs: this.duration(analysisStarted),
      ...(firstError ? { error: firstError } : {})
    });
    if (findings.length === 0) {
      const warnings = firstError ? ['AI_ANALYSIS_UNAVAILABLE', firstError] : ['AI_ANALYSIS_UNAVAILABLE'];
      const reportId = await this.commit({
        request,
        cursor: delta.cursor,
        signatures: plan,
        logRead,
        reportedSignatures,
        notesBySignature,
        report: {
          status: 'partial',
          deliveryStatus: 'skipped',
          findings: [],
          warnings,
          ...(firstError ? { failure: firstError } : {}),
          integrationStatus
        }
      });
      this.report({ event: 'report_commit_completed', reportId, status: 'partial', signatureCount: reportedSignatures.length });
      return { status: 'partial', warnings, reportId };
    }
    const warnings = findings.length === analyses.length
      ? []
      : (firstError ? ['AI_ANALYSIS_PARTIAL', firstError] : ['AI_ANALYSIS_PARTIAL']);
    const status = warnings.length ? 'partial' : 'reported';
    const report: CommitPlan['report'] = {
      status,
      deliveryStatus: 'pending',
      findings,
      warnings,
      ...(firstError ? { failure: firstError } : {}),
      integrationStatus
    };
    const reportId = await this.commit({ request, cursor: delta.cursor, signatures: plan, logRead, reportedSignatures, notesBySignature, report });
    this.report({ event: 'report_commit_completed', reportId, status, signatureCount: reportedSignatures.length });
    if (await this.dependencies.persistence.getDeliveryStatus?.(reportId) === 'sent') {
      return { status, warnings, reportId, deliveryStatus: 'sent' };
    }
    let deliveryStatus: DeliveryStatus = 'skipped';
    let deliveryDiagnostic: DeliveryDiagnostic | undefined;
    let deliveryStarted: number | undefined;
    try {
      if (this.dependencies.notifier) {
        const attempt = await this.dependencies.persistence.claimDeliveryAttempt(reportId);
        if (!attempt.shouldSend) return { status, warnings, reportId, deliveryStatus: attempt.status };
        deliveryStarted = this.time();
        this.report({ event: 'telegram_delivery_started' });
        const reportUrl = this.dependencies.reportUrl?.(reportId);
        const result = await this.dependencies.notifier.notify({ findings, ...(reportUrl ? { reportUrl } : {}), language });
        deliveryStatus = typeof result === 'string' ? result : result.status;
        deliveryDiagnostic = typeof result === 'string' ? undefined : deliveryDiagnosticFor(result, this.dependencies.now?.() ?? new Date().toISOString());
        this.report({ event: 'telegram_delivery_completed', outcome: deliveryStatus, ...(deliveryDiagnostic ? { errorCode: deliveryDiagnostic.errorCode } : {}), durationMs: this.duration(deliveryStarted) });
      }
    } catch {
      // An exception leaves external delivery unknown; pending prevents an automatic duplicate.
      deliveryStatus = 'pending';
      this.report({ event: 'telegram_delivery_completed', outcome: 'pending', errorCode: 'TELEGRAM_REQUEST_FAILED', durationMs: deliveryStarted === undefined ? 0 : this.duration(deliveryStarted) });
    }
    report.deliveryStatus = deliveryStatus;
    try {
      await this.dependencies.persistence.updateDeliveryStatus(reportId, deliveryStatus, deliveryDiagnostic);
    } catch {
      // The notification outcome is known; do not make a committed run retryable because its status write failed.
      return { status, warnings: [...warnings, 'DELIVERY_STATUS_PERSISTENCE_FAILED'], reportId, deliveryStatus };
    }
    return { status, warnings, reportId };
  }

  private async readIntegrationStatus(): Promise<IntegrationStatusSnapshot> {
    const started = this.time();
    try {
      const snapshot = await this.dependencies.haStatus?.snapshot() ?? { available: false, reason: 'connection_failed' as const };
      if (snapshot.available) this.report({ event: 'ha_snapshot_completed', integrationCount: snapshot.total, durationMs: this.duration(started) });
      else this.report({ event: 'ha_snapshot_failed', reason: snapshot.reason ?? 'connection_failed', durationMs: this.duration(started) });
      return snapshot;
    } catch {
      this.report({ event: 'ha_snapshot_failed', reason: 'connection_failed', durationMs: this.duration(started) });
      return { available: false, reason: 'connection_failed' };
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

  private async commit(plan: CommitPlan): Promise<string> {
    try {
      return await this.dependencies.persistence.commit(plan);
    } catch (error) {
      this.report({ event: 'report_commit_failed' });
      throw error;
    }
  }

  private report(event: BatchOperationalEvent): void {
    try { this.dependencies.eventReporter?.(event); } catch { /* Operational logging must not affect the report. */ }
  }

  private time(): number { return this.dependencies.clock?.() ?? Date.now(); }
  private duration(started: number): number { return Math.max(0, this.time() - started); }
}

function isIgnored(signature: BatchSignature, rules: IgnoreRuleDto[]): boolean {
  const haystack = `${signature.signature} ${signature.component} ${signature.normalizedMessage}`.toLowerCase();
  return rules.some((rule) => rule.type === 'signature'
    ? signature.signature === rule.match
    : haystack.includes(rule.match.toLowerCase()));
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

function deliveryDiagnosticFor(result: DeliveryResult, recordedAt: string): DeliveryDiagnostic | undefined {
  if (result.status !== 'failed' && !(result.status === 'pending' && result.errorCode === 'TELEGRAM_INVALID_RESPONSE')) return undefined;
  const errorCode = isDeliveryDiagnosticErrorCode(result.errorCode) ? result.errorCode : 'TELEGRAM_REJECTED';
  const messageKey = deliveryMessageKey(errorCode);
  if (!messageKey) return undefined;
  return {
    channel: 'telegram',
    stage: errorCode === 'configuration_failed' ? 'configuration' : errorCode === 'TELEGRAM_REQUEST_FAILED' ? 'request' : 'response',
    errorCode,
    messageKey,
    recordedAt
  };
}

function isDeliveryDiagnosticErrorCode(value: unknown): value is DeliveryDiagnosticErrorCode {
  return value === 'TELEGRAM_HTTP_400' || value === 'TELEGRAM_HTTP_401' || value === 'TELEGRAM_HTTP_403' || value === 'TELEGRAM_HTTP_404' || value === 'TELEGRAM_HTTP_409' || value === 'TELEGRAM_HTTP_429' || value === 'TELEGRAM_HTTP_5XX' || value === 'TELEGRAM_REJECTED' || value === 'TELEGRAM_INVALID_RESPONSE' || value === 'TELEGRAM_REQUEST_FAILED' || value === 'configuration_failed';
}

function deliveryMessageKey(errorCode: DeliveryDiagnosticErrorCode): DeliveryDiagnostic['messageKey'] {
  const keys: Record<DeliveryDiagnosticErrorCode, DeliveryDiagnostic['messageKey']> = {
    TELEGRAM_HTTP_400: 'telegram_bad_request', TELEGRAM_HTTP_401: 'telegram_auth_failed', TELEGRAM_HTTP_403: 'telegram_forbidden',
    TELEGRAM_HTTP_404: 'telegram_not_found', TELEGRAM_HTTP_409: 'telegram_conflict', TELEGRAM_HTTP_429: 'telegram_rate_limited',
    TELEGRAM_HTTP_5XX: 'telegram_service_unavailable', TELEGRAM_REJECTED: 'telegram_rejected', TELEGRAM_INVALID_RESPONSE: 'telegram_invalid_response',
    TELEGRAM_REQUEST_FAILED: 'telegram_request_failed', configuration_failed: 'telegram_configuration_failed'
  };
  return keys[errorCode];
}
