import type { DeliveryDiagnostic, DeliveryResult, DigestDetail, ManualTelegramSendAttempt, ManualTelegramSendResult } from '@ha-digest/shared';

type AttemptStore = {
  claim(reportId: string, source: 'legacy' | 'v2', actionId: string): Promise<{ attempt: ManualTelegramSendAttempt; alreadyRequested: boolean; shouldSend: boolean }>;
  complete(reportId: string, actionId: string, status: Exclude<ManualTelegramSendAttempt['status'], 'pending'>, diagnostic?: DeliveryDiagnostic): Promise<ManualTelegramSendAttempt>;
  list(reportId: string): Promise<ManualTelegramSendAttempt[]>;
};

type ManualTelegramSummary = { critical: number; warnings: number; detectedProblems: number; reportUrl?: string; language: 'en' | 'es' };

export class ManualTelegramSendService {
  constructor(private readonly dependencies: {
    reports: { get(id: string): Promise<DigestDetail | null> };
    attempts: AttemptStore;
    notifier: { configured(): Promise<boolean>; send(summary: ManualTelegramSummary): Promise<DeliveryResult> };
    reportUrl?: (reportId: string) => string | undefined;
    language(): Promise<'en' | 'es'>;
    now?: () => string;
  }) {}

  async send(reportId: string, actionId: string): Promise<ManualTelegramSendResult> {
    const report = await this.dependencies.reports.get(reportId);
    if (!report) throw new Error('REPORT_NOT_FOUND');
    if (isFailedPlaceholder(report)) throw new Error('REPORT_NOT_SENDABLE');
    const source = report.source ?? report.summary.source ?? (report.presentation?.mode === 'batch' ? 'v2' : 'legacy');
    const claim = await this.dependencies.attempts.claim(reportId, source, actionId);
    if (!claim.shouldSend) return { attempt: claim.attempt, alreadyRequested: claim.alreadyRequested };

    const recordedAt = this.dependencies.now?.() ?? new Date().toISOString();
    let configured = false;
    try { configured = await this.dependencies.notifier.configured(); } catch { configured = false; }
    if (!configured) {
      const diagnostic = diagnosticFor('configuration_failed', recordedAt);
      return { attempt: await this.dependencies.attempts.complete(reportId, actionId, 'failed', diagnostic), alreadyRequested: false };
    }

    try {
      const reportUrl = this.dependencies.reportUrl?.(reportId);
      const result = await this.dependencies.notifier.send({
        critical: report.summary.severityCounts.critical,
        warnings: report.summary.severityCounts.warning,
        detectedProblems: report.presentation?.mode === 'batch' ? report.presentation.signatures.length : report.summary.severityCounts.critical + report.summary.severityCounts.warning,
        ...(reportUrl ? { reportUrl } : {}),
        language: await this.dependencies.language()
      });
      const status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'indeterminate';
      const diagnostic = status === 'sent' ? undefined : diagnosticFor(result.errorCode, recordedAt);
      return { attempt: await this.dependencies.attempts.complete(reportId, actionId, status, diagnostic), alreadyRequested: false };
    } catch {
      return { attempt: await this.dependencies.attempts.complete(reportId, actionId, 'indeterminate', diagnosticFor('TELEGRAM_REQUEST_FAILED', recordedAt)), alreadyRequested: false };
    }
  }

  list(reportId: string): Promise<ManualTelegramSendAttempt[]> {
    return this.dependencies.attempts.list(reportId);
  }
}

function isFailedPlaceholder(report: DigestDetail): boolean {
  return report.id.startsWith('v2-run:') || report.presentation?.mode === 'batch' && report.presentation.status === 'failed';
}

function diagnosticFor(code: unknown, recordedAt: string): DeliveryDiagnostic {
  if (code === 'configuration_failed') return { channel: 'telegram', stage: 'configuration', errorCode: code, messageKey: 'telegram_configuration_failed', recordedAt };
  if (code === 'TELEGRAM_HTTP_400') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_bad_request', recordedAt };
  if (code === 'TELEGRAM_HTTP_401') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_auth_failed', recordedAt };
  if (code === 'TELEGRAM_HTTP_403') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_forbidden', recordedAt };
  if (code === 'TELEGRAM_HTTP_404') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_not_found', recordedAt };
  if (code === 'TELEGRAM_HTTP_409') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_conflict', recordedAt };
  if (code === 'TELEGRAM_HTTP_429') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_rate_limited', recordedAt };
  if (code === 'TELEGRAM_HTTP_5XX') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_service_unavailable', recordedAt };
  if (code === 'TELEGRAM_REJECTED') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_rejected', recordedAt };
  if (code === 'TELEGRAM_INVALID_RESPONSE') return { channel: 'telegram', stage: 'response', errorCode: code, messageKey: 'telegram_invalid_response', recordedAt };
  return { channel: 'telegram', stage: 'request', errorCode: 'TELEGRAM_REQUEST_FAILED', messageKey: 'telegram_request_failed', recordedAt };
}
