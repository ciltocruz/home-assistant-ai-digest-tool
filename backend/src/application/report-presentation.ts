import { IsoDateTimeSchema, ManualTelegramSendAttemptSchema, projectIntegrationStatus, type DigestDetail, type ReportPresentationItem, type ReportPresentationV1 } from '@ha-digest/shared';
import { redactProviderError } from '../domain/safe-error.js';
import { sanitizeTraceExcerpt } from '../domain/safe-trace.js';

type ReportSource = Pick<DigestDetail, 'id' | 'summary' | 'rendered'> & { source?: 'legacy' | 'v2' };
type StructuredSection = 'attention' | 'observations' | 'recommendations' | 'evidence';

const SECTION_HEADINGS: Record<string, StructuredSection> = {
  'attention items': 'attention',
  observations: 'observations',
  recommendations: 'recommendations',
  evidence: 'evidence'
};
const ITEM_PATTERN = /^- \*\*(.+?)\*\*(?:\s+\((critical|warning|info)\))?:\s+(.+)$/;

export function projectReportPresentation(report: ReportSource): ReportPresentationV1 {
  const safeMarkdown = redactProviderError(report.rendered.body);
  const parsed = parseCanonicalMarkdown(safeMarkdown);
  if (!parsed) return { version: 1, mode: 'legacy_markdown', legacyMarkdown: safeMarkdown };

  const attention = parsed.attention
    .filter((item) => item.severity === 'critical' || item.severity === 'warning')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const observations = parsed.observations.filter((item) => item.severity === 'info');
  const allGood = hasActionableIncidents(report)
    ? []
    : [{ id: 'all-good-1', title: 'No actionable incidents', detail: 'No critical or warning incidents were recorded for this report.' }];
  const recommendations = attention.length > 0
    ? [{ ...attention[0], id: 'recommendation-1' }]
    : parsed.recommendations;

  return {
    version: 1,
    mode: 'structured',
    overview: parsed.overview,
    attention,
    observations,
    allGood,
    recommendations,
    evidence: parsed.evidence
  };
}

export function projectLegacyReportPresentation(report: ReportSource): ReportPresentationV1 {
  return { version: 1, mode: 'legacy_markdown', legacyMarkdown: redactProviderError(report.rendered.body) };
}

export function redactReportDetail(report: DigestDetail): DigestDetail {
  const rendered = { ...report.rendered, body: redactProviderError(report.rendered.body) };
  const manualTelegram = safeManualTelegram(report.manualTelegram);
  const base = {
    id: report.id,
    ...(report.source === 'legacy' || report.source === 'v2' ? { source: report.source } : {}),
    summary: safeSummary(report.summary),
    rendered,
    ...(manualTelegram ? { manualTelegram } : {})
  };
  if (!report.presentation) {
    const presentation = report.source === 'legacy' ? projectLegacyReportPresentation({ ...report, rendered }) : projectReportPresentation({ ...report, rendered });
    return { ...base, presentation };
  }
  if (report.presentation.mode === 'legacy_markdown') {
    return { ...base, presentation: { version: 1, mode: 'legacy_markdown', legacyMarkdown: redactProviderError(report.presentation.legacyMarkdown) } };
  }
  if (report.presentation.mode === 'batch') {
    const statusIsValid = isBatchStatus(report.presentation.status);
    const summaryIsCorrupt = report.summary.warningCodes?.includes('REPORT_CORRUPT') ?? false;
    const warnings = safeWarnings(report.presentation.warnings);
    const integrationStatus = projectIntegrationStatus(report.presentation.integrationStatus);
    if ((!statusIsValid || summaryIsCorrupt) && !warnings.includes('REPORT_CORRUPT')) warnings.push('REPORT_CORRUPT');
    return {
      ...base,
      presentation: {
        version: 2,
        mode: 'batch',
        status: statusIsValid && !summaryIsCorrupt ? report.presentation.status : 'failed',
        warnings,
        ...(integrationStatus ? { integrationStatus } : {}),
        ...(typeof report.presentation.failure === 'string' ? { failure: redactProviderError(report.presentation.failure) } : {}),
        signatures: safeBatchSignatures(report.presentation.signatures)
      }
    };
  }
  if (report.presentation.mode === 'structured') {
    return { ...base, presentation: projectReportPresentation({ ...report, rendered }) };
  }
  return base;
}

function parseCanonicalMarkdown(markdown: string): {
  overview: { title: string; detail: string };
  attention: ReportPresentationItem[];
  observations: ReportPresentationItem[];
  recommendations: ReportPresentationItem[];
  evidence: ReportPresentationItem[];
} | null {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const title = /^#\s+(.+)$/.exec(lines[0] ?? '')?.[1]?.trim();
  const severityIndex = lines.findIndex((line) => /^\*\*Severity:\*\*\s*\S/.test(line));
  if (!title || severityIndex < 0) return null;

  const sections: Record<StructuredSection, ReportPresentationItem[]> = {
    attention: [], observations: [], recommendations: [], evidence: []
  };
  const overviewLines: string[] = [];
  let currentSection: StructuredSection | null = null;

  for (let index = severityIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    const heading = /^##\s+(.+)$/.exec(line)?.[1]?.trim().toLowerCase();
    if (heading) {
      const section = SECTION_HEADINGS[heading];
      if (!section) return null;
      currentSection = section;
      continue;
    }
    if (!currentSection) {
      overviewLines.push(line);
      continue;
    }
    const item = parseItem(line, currentSection, sections[currentSection].length + 1);
    if (!item) return null;
    sections[currentSection].push(item);
  }

  if (overviewLines.length === 0) return null;
  return {
    overview: { title, detail: overviewLines.join(' ') },
    attention: sections.attention,
    observations: sections.observations,
    recommendations: sections.recommendations,
    evidence: sections.evidence
  };
}

function parseItem(line: string, section: StructuredSection, position: number): ReportPresentationItem | null {
  const match = ITEM_PATTERN.exec(line);
  if (!match) return null;
  const [, title, rawSeverity, detail] = match;
  if (!title || !detail) return null;
  if (rawSeverity && !isPresentationSeverity(rawSeverity)) return null;
  const severity = rawSeverity && isPresentationSeverity(rawSeverity) ? rawSeverity : undefined;
  if ((section === 'attention' || section === 'observations') && !severity) return null;
  if (section === 'observations' && severity !== 'info') return null;
  if (section === 'attention' && severity !== 'critical' && severity !== 'warning') return null;
  return { id: `${section}-${position}`, ...(severity ? { severity } : {}), title, detail };
}

function isPresentationSeverity(value: string): value is NonNullable<ReportPresentationItem['severity']> {
  return value === 'critical' || value === 'warning' || value === 'info';
}

function hasActionableIncidents(report: ReportSource): boolean {
  return safeCount(report.summary.severityCounts.critical) + safeCount(report.summary.severityCounts.warning) > 0;
}

function severityRank(severity: ReportPresentationItem['severity']): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}

function safeWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).map((item) => redactProviderError(item)) : [];
}

function safeBatchSignatures(value: unknown): Array<{
  signature: string;
  component: string;
  level: 'ERROR' | 'CRITICAL' | 'WARNING';
  classification: 'new' | 'recurring' | 'reactivated' | 'latent';
  trend: 'new' | 'increasing' | 'flat' | 'decreasing' | 'unknown';
  problemKind?: 'endpoint_resolution';
  occurrences: number;
  analysis?: { summary: string; recommendation: string };
  safeExcerpt?: { lines: string[]; truncated: boolean; redacted: true };
  ignoredForFuture?: boolean;
  notes?: Array<{ id: string; text: string; occurredAt: string; createdAt: string; tags: string[] }>;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const signature = item as Record<string, unknown>;
    if (typeof signature.signature !== 'string' || !signature.signature || typeof signature.component !== 'string' || !signature.component || !isBatchLevel(signature.level) || !isClassification(signature.classification) || !isTrend(signature.trend) || typeof signature.occurrences !== 'number' || !Number.isInteger(signature.occurrences) || signature.occurrences < 1) return [];
    const analysis = signature.analysis && typeof signature.analysis === 'object' ? signature.analysis as Record<string, unknown> : undefined;
    const safeAnalysis = analysis && typeof analysis.summary === 'string' && analysis.summary && typeof analysis.recommendation === 'string' && analysis.recommendation
      ? { summary: redactProviderError(analysis.summary), recommendation: redactProviderError(analysis.recommendation) }
      : undefined;
     const notes = safeNotes(signature.notes);
     const safeExcerpt = safeTraceExcerpt(signature.safeExcerpt);
    return [{ signature: signature.signature, component: signature.component, level: signature.level, classification: signature.classification, trend: signature.trend, occurrences: signature.occurrences, ...(signature.problemKind === 'endpoint_resolution' ? { problemKind: signature.problemKind } : {}), ...(safeAnalysis ? { analysis: safeAnalysis } : {}), ...(safeExcerpt ? { safeExcerpt } : {}), ...(signature.ignoredForFuture === true ? { ignoredForFuture: true } : {}), ...(notes ? { notes } : {}) }];
  });
}

function safeTraceExcerpt(value: unknown): { lines: string[]; truncated: boolean; redacted: true } | undefined {
  return sanitizeTraceExcerpt(value);
}

function safeManualTelegram(value: unknown): DigestDetail['manualTelegram'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const manual = value as Record<string, unknown>;
  if (typeof manual.configured !== 'boolean' || !Array.isArray(manual.attempts)) return undefined;
  const attempts = manual.attempts.flatMap((attempt) => {
    const parsed = ManualTelegramSendAttemptSchema.safeParse(attempt);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 10);
  return { configured: manual.configured, attempts };
}

function safeNotes(value: unknown): Array<{ id: string; text: string; occurredAt: string; createdAt: string; tags: string[] }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const note = item as Record<string, unknown>;
     const occurredAt = safeIsoDate(note.occurredAt);
     const createdAt = safeIsoDate(note.createdAt);
     if (typeof note.id !== 'string' || !note.id || typeof note.text !== 'string' || !note.text || !occurredAt || !createdAt || !Array.isArray(note.tags) || !note.tags.every((tag) => typeof tag === 'string' && tag.length > 0)) return [];
     return [{ id: note.id, text: note.text, occurredAt, createdAt, tags: note.tags as string[] }];
  });
  return notes.length > 0 ? notes.slice(0, 10) : undefined;
}

function safeSummary(summary: DigestDetail['summary']): DigestDetail['summary'] {
  const window = safeWindow(summary.window);
  const createdAt = safeIsoDate(summary.createdAt) ?? '1970-01-01T00:00:00.000Z';
  const severityCounts = {
    critical: safeCount(asRecord(summary.severityCounts).critical),
    warning: safeCount(asRecord(summary.severityCounts).warning),
    info: safeCount(asRecord(summary.severityCounts).info)
  };
  const signatureCounts = summary.signatureCounts ? {
    new: safeCount(asRecord(summary.signatureCounts).new),
    recurring: safeCount(asRecord(summary.signatureCounts).recurring),
    reactivated: safeCount(asRecord(summary.signatureCounts).reactivated),
    latent: safeCount(asRecord(summary.signatureCounts).latent)
  } : undefined;
  const countsAreValid = isSafeCountObject(summary.severityCounts, ['critical', 'warning', 'info']) && (!summary.signatureCounts || isSafeCountObject(summary.signatureCounts, ['new', 'recurring', 'reactivated', 'latent']));
  const corrupt = !isRunStatus(summary.runStatus) && summary.runStatus !== undefined || !isIsoDate(summary.createdAt) || !isIsoDate(asRecord(summary.window).from) || !isIsoDate(asRecord(summary.window).to) || !countsAreValid;
  return {
    id: summary.id,
    window,
    severityCounts,
    createdAt,
    deliveryStatus: isDeliveryStatus(summary.deliveryStatus) ? summary.deliveryStatus : 'pending',
    ...(deliveryDiagnostic(summary.deliveryDiagnostic) ? { deliveryDiagnostic: deliveryDiagnostic(summary.deliveryDiagnostic) } : {}),
    ...(summary.source === 'legacy' || summary.source === 'v2' ? { source: summary.source } : {}),
    runStatus: corrupt ? 'failed' : summary.runStatus,
    warningCodes: [...(Array.isArray(summary.warningCodes) ? summary.warningCodes.filter((code): code is string => typeof code === 'string' && code.length > 0).map((code) => redactProviderError(code)) : []), ...(corrupt ? ['REPORT_CORRUPT'] : [])].filter((code, index, codes) => codes.indexOf(code) === index),
    ...(signatureCounts ? { signatureCounts } : {})
  };
}

function safeCount(value: unknown): number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0; }
function isSafeCountObject(value: unknown, keys: string[]): boolean {
  const record = asRecord(value);
  return keys.every((key) => typeof record[key] === 'number' && Number.isInteger(record[key]) && record[key] >= 0);
}

function safeWindow(value: unknown): { from: string; to: string } {
  const window = asRecord(value);
  const to = safeIsoDate(window.to) ?? '1970-01-01T00:00:00.000Z';
  const candidateFrom = safeIsoDate(window.from);
  const toMs = Date.parse(to);
  const from = candidateFrom && Date.parse(candidateFrom) < toMs ? candidateFrom : new Date(toMs - 1).toISOString();
  return { from, to };
}

function isIsoDate(value: unknown): boolean { return safeIsoDate(value) !== null; }
function safeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !IsoDateTimeSchema.safeParse(value).success) return null;
  return new Date(value).toISOString();
}
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }

function isDeliveryStatus(value: unknown): value is DigestDetail['summary']['deliveryStatus'] { return value === 'pending' || value === 'sent' || value === 'failed' || value === 'skipped'; }
function isRunStatus(value: unknown): value is NonNullable<DigestDetail['summary']['runStatus']> { return value === 'quiet' || value === 'reported' || value === 'partial' || value === 'failed'; }
function isBatchStatus(value: unknown): value is 'quiet' | 'reported' | 'partial' | 'failed' { return value === 'quiet' || value === 'reported' || value === 'partial' || value === 'failed'; }
function isBatchLevel(value: unknown): value is 'ERROR' | 'CRITICAL' | 'WARNING' { return value === 'ERROR' || value === 'CRITICAL' || value === 'WARNING'; }
function isClassification(value: unknown): value is 'new' | 'recurring' | 'reactivated' | 'latent' { return value === 'new' || value === 'recurring' || value === 'reactivated' || value === 'latent'; }
function isTrend(value: unknown): value is 'new' | 'increasing' | 'flat' | 'decreasing' | 'unknown' { return value === 'new' || value === 'increasing' || value === 'flat' || value === 'decreasing' || value === 'unknown'; }

function deliveryDiagnostic(value: unknown): DigestDetail['summary']['deliveryDiagnostic'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const diagnostic = value as Record<string, unknown>;
  const errorCode = diagnostic.errorCode;
  const messageKey = diagnostic.messageKey;
  if (diagnostic.channel !== 'telegram' || !isDeliveryStage(diagnostic.stage) || !isDeliveryErrorCode(errorCode) || !isDeliveryMessageKey(messageKey)) return undefined;
  const recordedAt = safeIsoDate(diagnostic.recordedAt);
  return recordedAt ? { channel: 'telegram', stage: diagnostic.stage, errorCode, messageKey, recordedAt } : undefined;
}

function isDeliveryStage(value: unknown): value is 'configuration' | 'request' | 'response' { return value === 'configuration' || value === 'request' || value === 'response'; }
function isDeliveryErrorCode(value: unknown): value is NonNullable<DigestDetail['summary']['deliveryDiagnostic']>['errorCode'] { return value === 'TELEGRAM_HTTP_400' || value === 'TELEGRAM_HTTP_401' || value === 'TELEGRAM_HTTP_403' || value === 'TELEGRAM_HTTP_404' || value === 'TELEGRAM_HTTP_409' || value === 'TELEGRAM_HTTP_429' || value === 'TELEGRAM_HTTP_5XX' || value === 'TELEGRAM_REJECTED' || value === 'TELEGRAM_INVALID_RESPONSE' || value === 'TELEGRAM_REQUEST_FAILED' || value === 'configuration_failed'; }
function isDeliveryMessageKey(value: unknown): value is NonNullable<DigestDetail['summary']['deliveryDiagnostic']>['messageKey'] { return value === 'telegram_bad_request' || value === 'telegram_auth_failed' || value === 'telegram_forbidden' || value === 'telegram_not_found' || value === 'telegram_conflict' || value === 'telegram_rate_limited' || value === 'telegram_service_unavailable' || value === 'telegram_rejected' || value === 'telegram_invalid_response' || value === 'telegram_request_failed' || value === 'telegram_configuration_failed'; }
