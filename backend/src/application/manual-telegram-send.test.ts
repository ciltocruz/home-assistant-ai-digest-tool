import { describe, expect, it, vi } from 'vitest';
import type { DigestDetail, ManualTelegramSendAttempt } from '@ha-digest/shared';
import { ManualTelegramSendService } from './manual-telegram-send.js';

describe('ManualTelegramSendService', () => {
  it('sends the same action once, sends two action IDs twice, and allows resend after automatic success', async () => {
    const attempts = new Map<string, ManualTelegramSendAttempt>();
    const sends: unknown[] = [];
    const automaticDeliveryMutation = vi.fn();
    const service = new ManualTelegramSendService({
      reports: { get: async () => report({ deliveryStatus: 'sent' }) },
      attempts: attemptStore(attempts),
      notifier: { configured: async () => true, send: async (summary) => { sends.push(summary); return { status: 'sent', targetRef: 'telegram:private-target', deliveredAt: '2026-08-14T12:00:01.000Z' }; } },
      reportUrl: (reportId) => `https://digest.example/reports/${encodeURIComponent(reportId)}`,
      language: async () => 'en'
    });
    const firstAction = '11111111-1111-4111-8111-111111111111';
    const secondAction = '22222222-2222-4222-8222-222222222222';

    await expect(service.send('v2-report:report-1', firstAction)).resolves.toMatchObject({ alreadyRequested: false, attempt: { status: 'sent' } });
    await expect(service.send('v2-report:report-1', firstAction)).resolves.toMatchObject({ alreadyRequested: true, attempt: { status: 'sent' } });
    await expect(service.send('v2-report:report-1', secondAction)).resolves.toMatchObject({ alreadyRequested: false, attempt: { status: 'sent' } });

    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual({ critical: 1, warnings: 2, detectedProblems: 2, reportUrl: 'https://digest.example/reports/v2-report%3Areport-1', language: 'en' });
    expect(automaticDeliveryMutation).not.toHaveBeenCalled();
  });

  it('records missing Telegram configuration as a safe failure without sending', async () => {
    const attempts = new Map<string, ManualTelegramSendAttempt>();
    const send = vi.fn();
    const service = new ManualTelegramSendService({
      reports: { get: async () => report({ deliveryStatus: 'skipped' }) },
      attempts: attemptStore(attempts),
      notifier: { configured: async () => false, send },
      language: async () => 'es'
    });

    const result = await service.send('v2-report:report-1', '11111111-1111-4111-8111-111111111111');

    expect(result).toMatchObject({ attempt: { status: 'failed', diagnostic: { errorCode: 'configuration_failed', messageKey: 'telegram_configuration_failed', stage: 'configuration' } } });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/target|token|chat|secret|message text/i);
  });

  it('treats an unreadable Telegram configuration as a safe failure before sending', async () => {
    const attempts = new Map<string, ManualTelegramSendAttempt>();
    const send = vi.fn();
    const service = new ManualTelegramSendService({
      reports: { get: async () => report() }, attempts: attemptStore(attempts),
      notifier: { configured: async () => { throw new Error('private secret storage failure'); }, send },
      language: async () => 'en'
    });

    const result = await service.send('v2-report:report-1', '11111111-1111-4111-8111-111111111111');

    expect(result).toMatchObject({ attempt: { status: 'failed', diagnostic: { errorCode: 'configuration_failed' } } });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private secret storage failure');
  });

  it('records thrown and unconfirmed sends as indeterminate without retrying the action', async () => {
    const attempts = new Map<string, ManualTelegramSendAttempt>();
    let sends = 0;
    const service = new ManualTelegramSendService({
      reports: { get: async () => report({ deliveryStatus: 'pending' }) },
      attempts: attemptStore(attempts),
      notifier: { configured: async () => true, send: async () => { sends += 1; throw new Error('private request URL and response body'); } },
      language: async () => 'en'
    });
    const actionId = '11111111-1111-4111-8111-111111111111';

    const first = await service.send('v2-report:report-1', actionId);
    const duplicate = await service.send('v2-report:report-1', actionId);

    expect(first).toMatchObject({ attempt: { status: 'indeterminate', diagnostic: { errorCode: 'TELEGRAM_REQUEST_FAILED', messageKey: 'telegram_request_failed' } } });
    expect(duplicate).toMatchObject({ alreadyRequested: true, attempt: { status: 'indeterminate' } });
    expect(sends).toBe(1);
    expect(JSON.stringify([first, duplicate])).not.toContain('private request URL');
  });

  it('rejects failed-run placeholders and missing reports before creating attempts', async () => {
    const attempts = new Map<string, ManualTelegramSendAttempt>();
    const store = attemptStore(attempts);
    const service = new ManualTelegramSendService({
      reports: { get: async (id) => id === 'v2-run:failed' ? report({ id, failed: true }) : null },
      attempts: store,
      notifier: { configured: async () => true, send: async () => ({ status: 'sent', targetRef: 'private' }) },
      language: async () => 'en'
    });

    await expect(service.send('missing', '11111111-1111-4111-8111-111111111111')).rejects.toThrow('REPORT_NOT_FOUND');
    await expect(service.send('v2-run:failed', '22222222-2222-4222-8222-222222222222')).rejects.toThrow('REPORT_NOT_SENDABLE');
    expect(attempts).toHaveLength(0);
  });
});

function report(options: { id?: string; deliveryStatus?: DigestDetail['summary']['deliveryStatus']; failed?: boolean } = {}): DigestDetail {
  const id = options.id ?? 'v2-report:report-1';
  return {
    id,
    source: 'v2',
    summary: { id, window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 1, warning: 2, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: options.deliveryStatus ?? 'pending', source: 'v2', runStatus: options.failed ? 'failed' : 'reported' },
    rendered: { format: 'markdown', body: 'private persisted message that must not be sent' },
    presentation: { version: 2, mode: 'batch', status: options.failed ? 'failed' : 'reported', warnings: [], signatures: options.failed ? [] : [
      { signature: 'one', component: 'private.component', level: 'CRITICAL', classification: 'new', trend: 'new', occurrences: 1 },
      { signature: 'two', component: 'private.component', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 2 }
    ], ...(options.failed ? { failure: 'failed' } : {}) }
  };
}

function attemptStore(attempts: Map<string, ManualTelegramSendAttempt>) {
  return {
    claim: async (_reportId: string, _source: 'legacy' | 'v2', actionId: string) => {
      const existing = attempts.get(actionId);
      if (existing) return { attempt: existing, alreadyRequested: true, shouldSend: false };
      const attempt: ManualTelegramSendAttempt = { actionId, status: 'pending', requestedAt: '2026-08-14T12:00:00.000Z' };
      attempts.set(actionId, attempt);
      return { attempt, alreadyRequested: false, shouldSend: true };
    },
    complete: async (_reportId: string, actionId: string, status: Exclude<ManualTelegramSendAttempt['status'], 'pending'>, diagnostic?: ManualTelegramSendAttempt['diagnostic']) => {
      const attempt: ManualTelegramSendAttempt = { actionId, status, ...(diagnostic ? { diagnostic } : {}), requestedAt: attempts.get(actionId)!.requestedAt, completedAt: '2026-08-14T12:00:01.000Z' };
      attempts.set(actionId, attempt);
      return attempt;
    },
    list: async () => [...attempts.values()]
  };
}
