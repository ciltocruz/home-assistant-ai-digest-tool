import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { IsoDateTimeSchema, type DeliveryStatus, type DigestDetail, type DigestHistoryResponse, type DigestSummary, type IgnoreRuleCreate, type IgnoreRuleDto, type NoteCreate, type NoteDto } from '@ha-digest/shared';
import type { BatchPersistence, CommitPlan, FailedRun, SignatureAnalysis, SignatureMemory } from '../../application/batch-report-run.js';
import { classifySignatures, type LogCursor, type ParsedLogEntry, type SignaturePlan } from '../../domain/batch.js';
import { redactProviderError } from '../../domain/safe-error.js';
import type { NoteStore } from '../../domain/stores.js';

export class SQLiteV2Stores implements BatchPersistence, SignatureMemory, NoteStore {
  constructor(private readonly db: DatabaseSync, private readonly reportRetention = 10, private readonly now: () => string = () => new Date().toISOString(), private readonly apiKey?: () => Promise<string | undefined>) {}

  async classifyAndStage(entries: ParsedLogEntry[], at: string): Promise<SignaturePlan> {
    const known = this.db.prepare(
      'select signature, first_seen_at as firstSeenAt, last_seen_at as lastSeenAt, previous_period_count as previousPeriodCount from v2_signatures'
    ).all() as Array<{ signature: string; firstSeenAt: string; lastSeenAt: string; previousPeriodCount: number }>;
    return classifySignatures(entries, known, { now: at });
  }

  async commit(plan: CommitPlan): Promise<string> {
    const apiKey = await this.apiKey?.();
    let reportId = `v2-report:${plan.request.runId}`;
    this.transaction(() => {
      const existingRun = this.findRun(plan.request.runId, plan.request.slotId);
      const runId = existingRun?.id ?? plan.request.runId;
      reportId = `v2-report:${runId}`;
      const existingReport = this.findReportForRun(runId);
      if (existingReport) {
        if (existingRun?.status === 'failed') {
          this.db.prepare('update v2_runs set status = ?, error_code = null, error_message = null where id = ?').run(existingReport.status, runId);
        }
        return;
      }
      const previousDeliveryStatus = existingRun ? deliveryStatusValue(existingRun.deliveryStatus) : null;
      const deliveryStatus = previousDeliveryStatus ?? plan.report.deliveryStatus ?? (plan.report.status === 'quiet' ? 'skipped' : 'pending');
      if (existingRun) {
        this.db.prepare('update v2_runs set status = ?, error_code = null, error_message = null, delivery_status = ? where id = ?')
          .run(plan.report.status, deliveryStatus, runId);
      } else {
        this.insertRun(runId, plan.request.slotId, plan.report.status, null, null, deliveryStatus);
      }
      this.saveCursor(plan.cursor);
      for (const signature of [...plan.signatures.baselineEntries, ...plan.signatures.signatures.flatMap((item) => item.occurrences)]) {
        this.upsertSignature(signature);
      }
      const createdAt = this.now();
      const findings = plan.report.findings.flatMap((finding) => {
        const analysis = safeSignatureAnalysis(finding.analysis, apiKey);
        return analysis ? [{ signature: finding.signature, analysis }] : [];
      });
      const storedReport = {
        status: plan.report.status,
        deliveryStatus,
        findings,
        warnings: safeWarnings(plan.report.warnings, apiKey),
        ...(safeIntegrationStatus(plan.report.integrationStatus, apiKey) ? { integrationStatus: safeIntegrationStatus(plan.report.integrationStatus, apiKey) } : {})
      };
      this.db.prepare(
        'insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)'
      ).run(reportId, runId, plan.report.status, JSON.stringify({ report: storedReport, signatures: safeSignatures(plan.reportedSignatures ?? plan.signatures.signatures), notesBySignature: safeNotes(plan.notesBySignature) ?? {} }), createdAt);
      if (plan.report.status !== 'quiet') {
        const attemptStatus = existingRun
          ? existingRun.status === 'failed' && !previousDeliveryStatus ? 'ready' : previousDeliveryStatus ?? 'pending'
          : 'ready';
        this.db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
          .run(reportId, attemptStatus, createdAt, createdAt);
      }
      for (const finding of findings) {
        this.db.prepare(
          'insert into v2_report_signatures(report_id, signature, summary, recommendation) values (?, ?, ?, ?)'
        ).run(reportId, finding.signature, finding.analysis.summary, finding.analysis.recommendation);
      }
      this.retainReports();
    });
    return reportId;
  }

  async updateDeliveryStatus(reportId: string, status: DeliveryStatus): Promise<void> {
    const apiKey = await this.apiKey?.();
    this.transaction(() => {
      const row = this.db.prepare('select payload_json, status, (select status from v2_runs where id = v2_reports.run_id) as run_status from v2_reports where id = ?').get(reportId) as V2ReportRow | undefined;
      if (!row) return;
      const stored = payload(row);
      if (!stored.valid || isCorruptReport(row, stored)) {
        this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?').run('pending', this.now(), reportId);
        this.db.prepare('update v2_runs set delivery_status = ? where id = (select run_id from v2_reports where id = ?)').run('pending', reportId);
        return;
      }
      const storedReport = safeReport(stored.value.report, status, apiKey);
      this.db.prepare('update v2_reports set payload_json = ? where id = ?')
        .run(JSON.stringify({ report: storedReport, signatures: safeSignatures(stored.value.signatures), notesBySignature: safeNotes(stored.value.notesBySignature) ?? {} }), reportId);
      this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?')
        .run(status, this.now(), reportId);
      this.db.prepare('update v2_runs set delivery_status = ? where id = (select run_id from v2_reports where id = ?)')
        .run(status, reportId);
    });
  }

  async claimDeliveryAttempt(reportId: string): Promise<{ status: DeliveryStatus; shouldSend: boolean }> {
    this.db.exec('begin immediate');
    try {
      const existing = this.db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get(reportId) as { status: string } | undefined;
      const report = this.db.prepare('select id, payload_json, status, created_at, (select status from v2_runs where id = v2_reports.run_id) as run_status, (select delivery_status from v2_runs where id = v2_reports.run_id) as run_delivery_status from v2_reports where id = ?').get(reportId) as V2ReportRow | undefined;
      if (!report) {
        this.db.exec('commit');
        return { status: 'skipped', shouldSend: false };
      }
      const runDeliveryStatus = deliveryStatusValue(report.run_delivery_status);
      if (runDeliveryStatus === 'sent' || runDeliveryStatus === 'skipped') {
        if (existing) {
          this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?').run(runDeliveryStatus, this.now(), reportId);
        } else {
          this.db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)').run(reportId, runDeliveryStatus, this.now(), this.now());
        }
        this.db.exec('commit');
        return { status: runDeliveryStatus, shouldSend: false };
      }
      const stored = payload(report);
      if (!stored.valid || isCorruptReport(report, stored)) {
        if (existing) {
          this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?')
            .run('pending', this.now(), reportId);
        } else {
          this.db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
            .run(reportId, 'pending', this.now(), this.now());
        }
        this.db.exec('commit');
        return { status: 'pending', shouldSend: false };
      }
      if (!existing) {
        const storedStatus = deliveryStatusValue(stored.value.report?.deliveryStatus);
        const status = storedStatus === 'sent' ? 'sent' : 'pending';
        this.db.prepare('insert into v2_report_delivery_attempts(report_id, status, created_at, updated_at) values (?, ?, ?, ?)')
          .run(reportId, status, this.now(), this.now());
        this.db.exec('commit');
        return { status: storedStatus === 'sent' ? 'sent' : storedStatus === 'skipped' ? 'skipped' : 'pending', shouldSend: false };
      }
      const attemptStatus = deliveryAttemptStatus(existing.status);
      if (attemptStatus === 'ready' || attemptStatus === 'failed') {
        this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?')
          .run('pending', this.now(), reportId);
        this.db.exec('commit');
        return { status: 'pending', shouldSend: true };
      }
      if (!attemptStatus) {
        this.db.prepare('update v2_report_delivery_attempts set status = ?, updated_at = ? where report_id = ?')
          .run('pending', this.now(), reportId);
        this.db.exec('commit');
        return { status: 'pending', shouldSend: false };
      }
      this.db.exec('commit');
      return { status: attemptStatus, shouldSend: false };
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  async getDeliveryStatus(reportId: string): Promise<DeliveryStatus | null> {
    const row = this.db.prepare('select payload_json, status, created_at, (select status from v2_runs where id = v2_reports.run_id) as run_status, (select delivery_status from v2_runs where id = v2_reports.run_id) as run_delivery_status from v2_reports where id = ?').get(reportId) as V2ReportRow | undefined;
    if (!row) return null;
    const runDeliveryStatus = deliveryStatusValue(row.run_delivery_status);
    if (runDeliveryStatus === 'sent' || runDeliveryStatus === 'skipped') return runDeliveryStatus;
    const stored = payload(row);
    if (!stored.valid || isCorruptReport(row, stored)) return 'pending';
    const attempt = this.db.prepare('select status from v2_report_delivery_attempts where report_id = ?').get(reportId) as { status: string } | undefined;
    if (attempt) {
      const attemptStatus = deliveryAttemptStatus(attempt.status);
      return attemptStatus === 'ready' || !attemptStatus ? 'pending' : attemptStatus;
    }
    return deliveryStatusValue(stored.value.report?.deliveryStatus);
  }

  async fail(run: FailedRun): Promise<void> {
    this.transaction(() => {
      const safeErrorMessage = redactProviderError(run.errorMessage);
      const existingRun = this.findRun(run.request.runId, run.request.slotId);
      if (existingRun) {
        if (existingRun.status === 'failed') {
          this.db.prepare('update v2_runs set status = ?, error_code = ?, error_message = ? where id = ?')
            .run('failed', run.code, safeErrorMessage, existingRun.id);
        }
        return;
      }
      this.insertRun(run.request.runId, run.request.slotId, 'failed', run.code, safeErrorMessage);
    });
  }

  async readCursor(): Promise<LogCursor | null> {
    const row = this.db.prepare('select dev, ino, size, offset from v2_log_cursor where singleton = 1').get() as LogCursor | undefined;
    return row ?? null;
  }

  async listReports(): Promise<DigestHistoryResponse> {
    const reports = this.db.prepare('select id, status, payload_json, created_at, (select status from v2_runs where id = v2_reports.run_id) as run_status from v2_reports order by created_at desc').all() as V2ReportRow[];
    const failures = this.db.prepare("select id, status, error_code, error_message, created_at from v2_runs where (status = 'failed' or status not in ('quiet', 'reported', 'partial')) and not exists (select 1 from v2_reports where v2_reports.run_id = v2_runs.id) order by created_at desc").all() as FailedRunRow[];
    const apiKey = await this.apiKey?.();
    return [...reports.map((row) => summaryFor(row, apiKey)), ...failures.map((row) => failedSummary(row))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getReport(id: string): Promise<DigestDetail | null> {
    if (id.startsWith('v2-run:')) {
      const run = this.db.prepare("select id, status, error_code, error_message, created_at from v2_runs where id = ? and (status = 'failed' or status not in ('quiet', 'reported', 'partial'))").get(id.slice(7)) as FailedRunRow | undefined;
      return run ? failedDetail(run) : null;
    }
    const row = this.db.prepare('select id, status, payload_json, created_at, (select status from v2_runs where id = v2_reports.run_id) as run_status from v2_reports where id = ?').get(id) as V2ReportRow | undefined;
    return row ? detailFor(row, await this.apiKey?.()) : null;
  }

  async add(input: NoteCreate): Promise<NoteDto> {
    const note = { id: randomUUID(), ...input, createdAt: this.now() };
    this.db.prepare('insert into notes(id, text, occurred_at, created_at, tags_json) values (?, ?, ?, ?, ?)')
      .run(note.id, note.text, note.occurredAt, note.createdAt, JSON.stringify(note.tags));
    return note;
  }

  async listWindow(window: { from: string; to: string }): Promise<NoteDto[]> {
    const rows = this.db.prepare(
      'select id, text, occurred_at, created_at, tags_json from notes where occurred_at >= ? and occurred_at <= ? order by occurred_at desc, id desc limit 100'
    ).all(window.from, window.to) as Array<{ id: string; text: string; occurred_at: string; created_at: string; tags_json: string }>;
    return rows.map((row) => ({ id: row.id, text: row.text, occurredAt: row.occurred_at, createdAt: row.created_at, tags: JSON.parse(row.tags_json) as string[] }));
  }

  async addIgnore(input: IgnoreRuleCreate): Promise<IgnoreRuleDto> {
    const rule = { id: randomUUID(), match: input.match, type: input.type, reason: input.reason, expiresAt: input.expiresAt, createdAt: this.now() };
    this.db.prepare('insert into ignore_rules(id, match, type, reason, expires_at, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(rule.id, rule.match, rule.type ?? null, rule.reason ?? null, rule.expiresAt ?? null, rule.createdAt);
    return rule;
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('update ignore_rules set removed_at = ? where id = ? and removed_at is null').run(this.now(), id);
  }

  async listActive(at: string): Promise<IgnoreRuleDto[]> {
    const rows = this.db.prepare(
      'select id, match, type, reason, expires_at, created_at from ignore_rules where removed_at is null and (expires_at is null or expires_at > ?) order by created_at desc, id desc limit 100'
    ).all(at) as Array<{ id: string; match: string; type: IgnoreRuleDto['type']; reason: string | null; expires_at: string | null; created_at: string }>;
    return rows.map((row) => ({ id: row.id, match: row.match, ...(row.type ? { type: row.type } : {}), ...(row.reason ? { reason: row.reason } : {}), ...(row.expires_at ? { expiresAt: row.expires_at } : {}), createdAt: row.created_at }));
  }

  private findRun(id: string, slotId: string): { id: string; status: string; deliveryStatus: string | null } | undefined {
    return this.db.prepare('select id, status, delivery_status as deliveryStatus from v2_runs where id = ? or slot_id = ?').get(id, slotId) as { id: string; status: string; deliveryStatus: string | null } | undefined;
  }

  private findReportForRun(runId: string): { id: string; status: 'quiet' | 'reported' | 'partial' } | undefined {
    return this.db.prepare('select id, status from v2_reports where run_id = ?').get(runId) as { id: string; status: 'quiet' | 'reported' | 'partial' } | undefined;
  }

  private insertRun(id: string, slotId: string, status: string, errorCode: string | null, errorMessage: string | null, deliveryStatus: DeliveryStatus | null = null): void {
    this.db.prepare('insert into v2_runs(id, slot_id, status, error_code, error_message, delivery_status, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, slotId, status, errorCode, errorMessage, deliveryStatus, this.now());
  }

  private saveCursor(cursor: LogCursor): void {
    this.db.prepare(
      `insert into v2_log_cursor(singleton, dev, ino, size, offset, updated_at) values (1, ?, ?, ?, ?, ?)
       on conflict(singleton) do update set dev = excluded.dev, ino = excluded.ino, size = excluded.size,
       offset = excluded.offset, updated_at = excluded.updated_at`
    ).run(cursor.dev, cursor.ino, cursor.size, cursor.offset, this.now());
  }

  private upsertSignature(entry: ParsedLogEntry): void {
    this.db.prepare(
      `insert into v2_signatures(signature, component, level, normalized_message, first_seen_at, last_seen_at, total_count, previous_period_count)
       values (?, ?, ?, ?, ?, ?, 1, 0)
       on conflict(signature) do update set last_seen_at = excluded.last_seen_at,
       previous_period_count = v2_signatures.total_count, total_count = v2_signatures.total_count + 1`
    ).run(entry.signature, entry.component, entry.level, entry.normalizedMessage, entry.at, entry.at);
  }

  private retainReports(): void {
    this.db.prepare(
      'delete from v2_reports where id in (select id from v2_reports order by created_at desc, id desc limit -1 offset ?)'
    ).run(this.reportRetention);
  }

  private transaction(operation: () => void): void {
    this.db.exec('begin immediate');
    try {
      operation();
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }
}

type V2ReportRow = { id: string; status: string; run_status?: string | null; run_delivery_status?: string | null; payload_json: string; created_at: string };
type FailedRunRow = { id: string; status: string; error_code: string | null; error_message: string | null; created_at: string };
type V2Payload = { report?: Partial<CommitPlan['report']>; signatures?: unknown; notesBySignature?: unknown };
function safeSignatureAnalysis(value: unknown, apiKey?: string): SignatureAnalysis | null {
  const analysis = asRecord(value);
  if (typeof analysis.summary !== 'string' || analysis.summary.trim().length === 0 || typeof analysis.recommendation !== 'string' || analysis.recommendation.trim().length === 0) return null;
  return { summary: redactProviderError(analysis.summary, apiKey), recommendation: redactProviderError(analysis.recommendation, apiKey) };
}
function payload(row: Pick<V2ReportRow, 'payload_json'>): { value: V2Payload; valid: boolean } {
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: {}, valid: false };
    return { value: asRecord(parsed) as V2Payload, valid: true };
  } catch {
    return { value: {}, valid: false };
  }
}
function safeSignatures(value: unknown): SignaturePlan['signatures'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const signature = asRecord(item);
    if (typeof signature.signature !== 'string' || signature.signature.trim().length === 0 || typeof signature.component !== 'string' || signature.component.trim().length === 0 || !isLevel(signature.level) || !isClassification(signature.classification) || !isTrend(signature.trend) || !Array.isArray(signature.occurrences)) return [];
    const occurrences = signature.occurrences.flatMap((item) => { const occurrence = safeOccurrence(item); return occurrence ? [occurrence] : []; });
    return occurrences.length > 0 ? [{ signature: signature.signature, component: signature.component, level: signature.level, normalizedMessage: typeof signature.normalizedMessage === 'string' ? signature.normalizedMessage : '', classification: signature.classification, trend: signature.trend, occurrences }] : [];
  });
}
function safeFindings(value: unknown, apiKey?: string): Array<{ signature: string; analysis: SignatureAnalysis }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => { const finding = asRecord(item); const analysis = safeSignatureAnalysis(finding.analysis, apiKey); return typeof finding.signature === 'string' && finding.signature.trim().length > 0 && analysis ? [{ signature: finding.signature, analysis }] : []; });
}
function safeWarnings(value: unknown, apiKey?: string): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).map((item) => redactProviderError(item, apiKey)) : []; }
function safeNotes(value: unknown): Record<string, NoteDto[]> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const notes = Object.fromEntries(Object.entries(value).flatMap(([signature, entries]) => {
    if (!Array.isArray(entries)) return [];
    const safeEntries = entries.flatMap((entry) => {
      const note = asRecord(entry);
       const occurredAt = safeIsoDate(note.occurredAt);
       const createdAt = safeIsoDate(note.createdAt);
       if (typeof note.id !== 'string' || !note.id || typeof note.text !== 'string' || !note.text || !occurredAt || !createdAt || !Array.isArray(note.tags) || !note.tags.every((tag) => typeof tag === 'string' && tag.length > 0)) return [];
       return [{ id: note.id, text: note.text, occurredAt, createdAt, tags: note.tags }];
    });
    return safeEntries.length > 0 ? [[signature, safeEntries]] : [];
  }));
  return Object.keys(notes).length > 0 ? notes as Record<string, NoteDto[]> : undefined;
}
function safeIntegrationStatus(value: unknown, apiKey?: string): { available: boolean; integrations: Array<{ domain: string; title?: string; state?: string }> } | undefined {
  const status = asRecord(value);
  if (typeof status.available !== 'boolean' || !Array.isArray(status.integrations)) return undefined;
  const integrations = status.integrations.flatMap((entry) => {
    const integration = asRecord(entry);
    if (typeof integration.domain !== 'string') return [];
    return [{ domain: redactProviderError(integration.domain, apiKey), ...(typeof integration.title === 'string' ? { title: redactProviderError(integration.title, apiKey) } : {}), ...(typeof integration.state === 'string' ? { state: redactProviderError(integration.state, apiKey) } : {}) }];
  });
  return { available: status.available, integrations };
}
function safeReport(value: unknown, deliveryStatus: DeliveryStatus, apiKey?: string): { status: 'quiet' | 'reported' | 'partial' | 'failed'; deliveryStatus: DeliveryStatus; findings: Array<{ signature: string; analysis: SignatureAnalysis }>; warnings: string[]; integrationStatus?: { available: boolean; integrations: Array<{ domain: string; title?: string; state?: string }> } } {
  const report = asRecord(value);
  const status = isRunStatus(report.status) ? report.status : 'reported';
  return { status, deliveryStatus, findings: safeFindings(report.findings, apiKey), warnings: safeWarnings(report.warnings, apiKey), ...(safeIntegrationStatus(report.integrationStatus, apiKey) ? { integrationStatus: safeIntegrationStatus(report.integrationStatus, apiKey) } : {}) };
}
function counts(signatures: SignaturePlan['signatures']): NonNullable<DigestSummary['signatureCounts']> {
  return signatures.reduce((total, item) => ({ ...total, [item.classification]: total[item.classification] + 1 }), { new: 0, recurring: 0, reactivated: 0, latent: 0 });
}
function severity(signatures: SignaturePlan['signatures']) {
  return signatures.reduce((total, item) => ({ ...total, critical: total.critical + Number(item.level === 'CRITICAL'), warning: total.warning + Number(item.level === 'ERROR' || item.level === 'WARNING') }), { critical: 0, warning: 0, info: 0 });
}
function summaryFor(row: V2ReportRow, apiKey?: string): DigestSummary {
  const stored = payload(row);
  if (!stored.valid) return invalidSummary(row);
  if (isCorruptReport(row, stored)) return invalidSummary(row, 'REPORT_CORRUPT');
  const signatures = safeSignatures(stored.value.signatures);
  const createdAt = safeTimestamp(row.created_at);
  return { id: row.id, window: pointInTimeWindow(createdAt), severityCounts: severity(signatures), createdAt, deliveryStatus: deliveryStatusValue(stored.value.report?.deliveryStatus) ?? 'pending', source: 'v2', runStatus: row.status as 'quiet' | 'reported' | 'partial' | 'failed', warningCodes: safeWarnings(stored.value.report?.warnings, apiKey), signatureCounts: counts(signatures) };
}
function detailFor(row: V2ReportRow, apiKey?: string): DigestDetail {
  const stored = payload(row);
  if (!stored.valid) return invalidDetail(row);
  if (isCorruptReport(row, stored)) return invalidDetail(row, 'REPORT_CORRUPT');
  const value = stored.value; const signatures = safeSignatures(value.signatures); const analyses = new Map(safeFindings(value.report?.findings, apiKey).map((finding) => [finding.signature, finding.analysis]));
  return {
    id: row.id, summary: summaryFor(row, apiKey), rendered: { format: 'markdown', body: '' },
     presentation: { version: 2, mode: 'batch', status: row.status as 'quiet' | 'reported' | 'partial' | 'failed', warnings: safeWarnings(value.report?.warnings, apiKey), ...(safeIntegrationStatus(value.report?.integrationStatus, apiKey) ? { integrationStatus: safeIntegrationStatus(value.report?.integrationStatus, apiKey) } : {}),
      signatures: signatures.map((item) => ({ signature: item.signature, component: item.component, level: item.level, classification: item.classification, trend: item.trend, occurrences: item.occurrences.length, ...(analyses.has(item.signature) ? { analysis: analyses.get(item.signature) } : {}), ...(safeNotes(value.notesBySignature)?.[item.signature] ? { notes: safeNotes(value.notesBySignature)![item.signature] } : {}) })) }
  };
}
function invalidSummary(row: V2ReportRow, warning = 'REPORT_PAYLOAD_INVALID'): DigestSummary {
  const createdAt = safeTimestamp(row.created_at);
  return { id: row.id, window: pointInTimeWindow(createdAt), severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt, deliveryStatus: 'pending', source: 'v2', runStatus: 'failed', warningCodes: [warning], signatureCounts: counts([]) };
}
function invalidDetail(row: V2ReportRow, warning = 'REPORT_PAYLOAD_INVALID'): DigestDetail {
  return { id: row.id, summary: invalidSummary(row, warning), rendered: { format: 'markdown', body: '' }, presentation: { version: 2, mode: 'batch', status: 'failed', warnings: [warning], signatures: [], failure: 'The persisted report payload is invalid.' } };
}
function failedSummary(row: FailedRunRow): DigestSummary {
  const createdAt = safeTimestamp(row.created_at);
  const warningCodes = isRunStatus(row.status) ? (row.error_code ? [row.error_code] : []) : ['REPORT_CORRUPT'];
  return { id: `v2-run:${row.id}`, window: pointInTimeWindow(createdAt), severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt, deliveryStatus: 'skipped', source: 'v2', runStatus: 'failed', warningCodes };
}
function failedDetail(row: FailedRunRow): DigestDetail {
  const summary = failedSummary(row);
  return { id: summary.id, summary, rendered: { format: 'markdown', body: '' }, presentation: { version: 2, mode: 'batch', status: 'failed', warnings: summary.warningCodes ?? [], signatures: [], failure: redactProviderError(row.error_message ?? row.error_code ?? 'REPORT_FAILED') } };
}

function pointInTimeWindow(createdAt: unknown): { from: string; to: string } {
  const to = safeTimestamp(createdAt);
  return { from: new Date(Date.parse(to) - 1).toISOString(), to };
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function deliveryStatusValue(value: unknown): DeliveryStatus | null { return value === 'pending' || value === 'sent' || value === 'failed' || value === 'skipped' ? value : null; }
function isRunStatus(value: unknown): value is 'quiet' | 'reported' | 'partial' | 'failed' { return value === 'quiet' || value === 'reported' || value === 'partial' || value === 'failed'; }
function isCorruptReport(row: V2ReportRow, stored: { value: V2Payload; valid: boolean }): boolean {
  const payloadStatus = stored.value.report?.status;
  return !isRunStatus(row.status) || (row.run_status !== null && row.run_status !== undefined && !isRunStatus(row.run_status)) || (payloadStatus !== undefined && !isRunStatus(payloadStatus));
}
function safeTimestamp(value: unknown): string {
  return safeIsoDate(value) ?? '1970-01-01T00:00:00.000Z';
}
function safeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !IsoDateTimeSchema.safeParse(value).success) return null;
  return new Date(value).toISOString();
}
function deliveryAttemptStatus(value: unknown): 'ready' | 'pending' | 'sent' | 'failed' | null { return value === 'ready' || value === 'pending' || value === 'sent' || value === 'failed' ? value : null; }
function isLevel(value: unknown): value is SignaturePlan['signatures'][number]['level'] { return value === 'ERROR' || value === 'CRITICAL' || value === 'WARNING'; }
function isClassification(value: unknown): value is SignaturePlan['signatures'][number]['classification'] { return value === 'new' || value === 'recurring' || value === 'reactivated' || value === 'latent'; }
function isTrend(value: unknown): value is SignaturePlan['signatures'][number]['trend'] { return value === 'new' || value === 'increasing' || value === 'flat' || value === 'decreasing'; }
function safeOccurrence(value: unknown): ParsedLogEntry | null {
  const occurrence = asRecord(value);
  if (typeof occurrence.at !== 'string' || !isLevel(occurrence.level) || typeof occurrence.component !== 'string' || occurrence.component.trim().length === 0 || typeof occurrence.message !== 'string' || occurrence.message.trim().length === 0 || typeof occurrence.normalizedMessage !== 'string' || occurrence.normalizedMessage.trim().length === 0 || typeof occurrence.signature !== 'string' || occurrence.signature.trim().length === 0) return null;
  return { at: occurrence.at, level: occurrence.level, component: occurrence.component, message: occurrence.message, normalizedMessage: occurrence.normalizedMessage, signature: occurrence.signature };
}

export class SQLiteScheduleStateStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {}

  async firstRunEnqueuedAt(): Promise<string | null> {
    return this.value('__initial__', 'first_run_enqueued_at');
  }

  async lastScheduledAt(scheduleId: string): Promise<string | null> {
    return this.value(scheduleId, 'last_scheduled_at');
  }

  async markFirstRunEnqueued(at: string): Promise<void> {
    this.save('__initial__', 'first_run_enqueued_at', at);
  }

  async markScheduled(scheduleId: string, at: string): Promise<void> {
    this.save(scheduleId, 'last_scheduled_at', at);
  }

  private value(scheduleId: string, column: 'first_run_enqueued_at' | 'last_scheduled_at'): string | null {
    const row = this.db.prepare(`select ${column} as value from schedule_state where schedule_id = ?`).get(scheduleId) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private save(scheduleId: string, column: 'first_run_enqueued_at' | 'last_scheduled_at', value: string): void {
    this.db.prepare(
      `insert into schedule_state(schedule_id, ${column}, updated_at) values (?, ?, ?)
       on conflict(schedule_id) do update set ${column} = excluded.${column}, updated_at = excluded.updated_at`
    ).run(scheduleId, value, this.now());
  }
}
