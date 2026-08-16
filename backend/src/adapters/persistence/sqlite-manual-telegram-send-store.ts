import type { DatabaseSync } from 'node:sqlite';
import { DeliveryDiagnosticSchema, ManualTelegramSendAttemptSchema, type DeliveryDiagnostic, type ManualTelegramSendAttempt } from '@ha-digest/shared';

type ManualSendStatus = ManualTelegramSendAttempt['status'];

export class SQLiteManualTelegramSendStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {}

  async claim(reportId: string, source: 'legacy' | 'v2', actionId: string): Promise<{ attempt: ManualTelegramSendAttempt; alreadyRequested: boolean; shouldSend: boolean }> {
    this.db.exec('begin immediate');
    try {
      const existing = this.find(reportId, actionId);
      if (existing) {
        this.db.exec('commit');
        return { attempt: existing, alreadyRequested: true, shouldSend: false };
      }
      const pending = this.db.prepare("select 1 from manual_telegram_sends where report_id = ? and status = 'pending'").get(reportId);
      if (pending) throw new Error('MANUAL_TELEGRAM_SEND_IN_FLIGHT');
      const requestedAt = this.now();
      this.db.prepare('insert into manual_telegram_sends(report_id, report_source, action_id, status, requested_at) values (?, ?, ?, ?, ?)')
        .run(reportId, source, actionId, 'pending', requestedAt);
      this.db.exec('commit');
      return { attempt: { actionId, status: 'pending', requestedAt }, alreadyRequested: false, shouldSend: true };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('rollback');
      throw error;
    }
  }

  async complete(reportId: string, actionId: string, status: Exclude<ManualSendStatus, 'pending'>, diagnostic?: DeliveryDiagnostic): Promise<ManualTelegramSendAttempt> {
    const completedAt = this.now();
    const safeDiagnostic = DeliveryDiagnosticSchema.safeParse(diagnostic);
    this.db.prepare(`update manual_telegram_sends set status = ?, diagnostic_error_code = ?, diagnostic_message_key = ?, diagnostic_stage = ?, completed_at = ?
      where report_id = ? and action_id = ? and status = 'pending'`)
      .run(status, safeDiagnostic.success ? safeDiagnostic.data.errorCode : null, safeDiagnostic.success ? safeDiagnostic.data.messageKey : null, safeDiagnostic.success ? safeDiagnostic.data.stage : null, completedAt, reportId, actionId);
    const attempt = this.find(reportId, actionId, safeDiagnostic.success ? safeDiagnostic.data.recordedAt : completedAt);
    if (!attempt) throw new Error('MANUAL_TELEGRAM_SEND_NOT_FOUND');
    return attempt;
  }

  async list(reportId: string): Promise<ManualTelegramSendAttempt[]> {
    const rows = this.db.prepare(`select action_id, status, diagnostic_error_code, diagnostic_message_key, diagnostic_stage, requested_at, completed_at
      from manual_telegram_sends where report_id = ? order by requested_at desc, action_id desc limit 10`).all(reportId) as ManualSendRow[];
    return rows.flatMap((row) => { const attempt = attemptFrom(row); return attempt ? [attempt] : []; });
  }

  private find(reportId: string, actionId: string, diagnosticAt?: string): ManualTelegramSendAttempt | undefined {
    const row = this.db.prepare(`select action_id, status, diagnostic_error_code, diagnostic_message_key, diagnostic_stage, requested_at, completed_at
      from manual_telegram_sends where report_id = ? and action_id = ?`).get(reportId, actionId) as ManualSendRow | undefined;
    return row ? attemptFrom(row, diagnosticAt) : undefined;
  }
}

type ManualSendRow = {
  action_id: string;
  status: string;
  diagnostic_error_code: string | null;
  diagnostic_message_key: string | null;
  diagnostic_stage: string | null;
  requested_at: string;
  completed_at: string | null;
};

function attemptFrom(row: ManualSendRow, diagnosticAt?: string): ManualTelegramSendAttempt | undefined {
  const diagnostic = DeliveryDiagnosticSchema.safeParse({
    channel: 'telegram', stage: row.diagnostic_stage, errorCode: row.diagnostic_error_code,
    messageKey: row.diagnostic_message_key, recordedAt: diagnosticAt ?? row.completed_at
  });
  const attempt = ManualTelegramSendAttemptSchema.safeParse({
    actionId: row.action_id,
    status: row.status,
    ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
    requestedAt: row.requested_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  });
  return attempt.success ? attempt.data : undefined;
}
