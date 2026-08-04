import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DigestDetail, DigestHistoryResponse, DigestSummary, IgnoreRuleCreate, IgnoreRuleDto, NoteCreate, NoteDto } from '@ha-digest/shared';
import type { BatchPersistence, CommitPlan, FailedRun, SignatureMemory } from '../../application/batch-report-run.js';
import { classifySignatures, type LogCursor, type ParsedLogEntry, type SignaturePlan } from '../../domain/batch.js';
import type { NoteStore } from '../../domain/stores.js';

export class SQLiteV2Stores implements BatchPersistence, SignatureMemory, NoteStore {
  constructor(private readonly db: DatabaseSync, private readonly reportRetention = 10, private readonly now: () => string = () => new Date().toISOString()) {}

  async classifyAndStage(entries: ParsedLogEntry[], at: string): Promise<SignaturePlan> {
    const known = this.db.prepare(
      'select signature, first_seen_at as firstSeenAt, last_seen_at as lastSeenAt, previous_period_count as previousPeriodCount from v2_signatures'
    ).all() as Array<{ signature: string; firstSeenAt: string; lastSeenAt: string; previousPeriodCount: number }>;
    return classifySignatures(entries, known, { now: at });
  }

  async commit(plan: CommitPlan): Promise<void> {
    this.transaction(() => {
      if (this.runExists(plan.request.runId, plan.request.slotId)) return;
      this.insertRun(plan.request.runId, plan.request.slotId, plan.report.status, null);
      this.saveCursor(plan.cursor);
      for (const signature of [...plan.signatures.baselineEntries, ...plan.signatures.signatures.flatMap((item) => item.occurrences)]) {
        this.upsertSignature(signature);
      }
      const reportId = `v2-report:${plan.request.runId}`;
      const createdAt = new Date().toISOString();
      this.db.prepare(
        'insert into v2_reports(id, run_id, status, payload_json, created_at) values (?, ?, ?, ?, ?)'
       ).run(reportId, plan.request.runId, plan.report.status, JSON.stringify({ report: plan.report, signatures: plan.reportedSignatures ?? plan.signatures.signatures, notesBySignature: plan.notesBySignature ?? {} }), createdAt);
      for (const finding of plan.report.findings) {
        this.db.prepare(
          'insert into v2_report_signatures(report_id, signature, summary, recommendation) values (?, ?, ?, ?)'
        ).run(reportId, finding.signature, finding.analysis.summary, finding.analysis.recommendation);
      }
      this.retainReports();
    });
  }

  async fail(run: FailedRun): Promise<void> {
    this.transaction(() => {
      if (!this.runExists(run.request.runId, run.request.slotId)) {
        this.insertRun(run.request.runId, run.request.slotId, 'failed', run.code);
      }
    });
  }

  async readCursor(): Promise<LogCursor | null> {
    const row = this.db.prepare('select dev, ino, size, offset from v2_log_cursor where singleton = 1').get() as LogCursor | undefined;
    return row ?? null;
  }

  async listReports(): Promise<DigestHistoryResponse> {
    const reports = this.db.prepare('select id, status, payload_json, created_at from v2_reports order by created_at desc').all() as V2ReportRow[];
    const failures = this.db.prepare("select id, error_code, created_at from v2_runs where status = 'failed' order by created_at desc").all() as FailedRunRow[];
    return [...reports.map((row) => summaryFor(row)), ...failures.map((row) => failedSummary(row))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getReport(id: string): Promise<DigestDetail | null> {
    if (id.startsWith('v2-run:')) {
      const run = this.db.prepare("select id, error_code, created_at from v2_runs where id = ? and status = 'failed'").get(id.slice(7)) as FailedRunRow | undefined;
      return run ? failedDetail(run) : null;
    }
    const row = this.db.prepare('select id, status, payload_json, created_at from v2_reports where id = ?').get(id) as V2ReportRow | undefined;
    return row ? detailFor(row) : null;
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

  private runExists(id: string, slotId: string): boolean {
    return Boolean(this.db.prepare('select 1 from v2_runs where id = ? or slot_id = ?').get(id, slotId));
  }

  private insertRun(id: string, slotId: string, status: string, errorCode: string | null): void {
    this.db.prepare('insert into v2_runs(id, slot_id, status, error_code, created_at) values (?, ?, ?, ?, ?)')
      .run(id, slotId, status, errorCode, new Date().toISOString());
  }

  private saveCursor(cursor: LogCursor): void {
    this.db.prepare(
      `insert into v2_log_cursor(singleton, dev, ino, size, offset, updated_at) values (1, ?, ?, ?, ?, ?)
       on conflict(singleton) do update set dev = excluded.dev, ino = excluded.ino, size = excluded.size,
       offset = excluded.offset, updated_at = excluded.updated_at`
    ).run(cursor.dev, cursor.ino, cursor.size, cursor.offset, new Date().toISOString());
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

type V2ReportRow = { id: string; status: 'quiet' | 'reported' | 'partial'; payload_json: string; created_at: string };
type FailedRunRow = { id: string; error_code: string | null; created_at: string };
type V2Payload = { report: CommitPlan['report']; signatures: SignaturePlan['signatures']; notesBySignature?: Record<string, NoteDto[]> };
function payload(row: V2ReportRow): V2Payload { return JSON.parse(row.payload_json) as V2Payload; }
function counts(signatures: SignaturePlan['signatures']): NonNullable<DigestSummary['signatureCounts']> {
  return signatures.reduce((total, item) => ({ ...total, [item.classification]: total[item.classification] + 1 }), { new: 0, recurring: 0, reactivated: 0, latent: 0 });
}
function severity(signatures: SignaturePlan['signatures']) {
  return signatures.reduce((total, item) => ({ ...total, critical: total.critical + Number(item.level === 'CRITICAL'), warning: total.warning + Number(item.level === 'ERROR' || item.level === 'WARNING') }), { critical: 0, warning: 0, info: 0 });
}
function summaryFor(row: V2ReportRow): DigestSummary {
  const value = payload(row); const now = row.created_at;
  return { id: row.id, window: { from: now, to: now }, severityCounts: severity(value.signatures), createdAt: now, deliveryStatus: 'skipped', runStatus: row.status, warningCodes: value.report.warnings, signatureCounts: counts(value.signatures) };
}
function detailFor(row: V2ReportRow): DigestDetail {
  const value = payload(row); const analyses = new Map(value.report.findings.map((finding) => [finding.signature, finding.analysis]));
  return {
    id: row.id, summary: summaryFor(row), rendered: { format: 'markdown', body: '' },
    presentation: { version: 2, mode: 'batch', status: row.status, warnings: value.report.warnings, integrationStatus: value.report.integrationStatus,
      signatures: value.signatures.map((item) => ({ signature: item.signature, component: item.component, level: item.level, classification: item.classification, trend: item.trend, occurrences: item.occurrences.length, ...(analyses.has(item.signature) ? { analysis: analyses.get(item.signature) } : {}), ...(value.notesBySignature?.[item.signature] ? { notes: value.notesBySignature[item.signature] } : {}) })) }
  };
}
function failedSummary(row: FailedRunRow): DigestSummary {
  return { id: `v2-run:${row.id}`, window: { from: row.created_at, to: row.created_at }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: row.created_at, deliveryStatus: 'skipped', runStatus: 'failed', warningCodes: row.error_code ? [row.error_code] : [] };
}
function failedDetail(row: FailedRunRow): DigestDetail {
  const summary = failedSummary(row);
  return { id: summary.id, summary, rendered: { format: 'markdown', body: '' }, presentation: { version: 2, mode: 'batch', status: 'failed', warnings: summary.warningCodes ?? [], signatures: [], failure: row.error_code ?? 'REPORT_FAILED' } };
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
