import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SQLiteManualTelegramSendStore } from './sqlite-manual-telegram-send-store.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('SQLiteManualTelegramSendStore', () => {
  it('claims each new action once, returns duplicate actions, and blocks a second in-flight action', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const store = new SQLiteManualTelegramSendStore(db, () => '2026-08-14T12:00:00.000Z');
    const firstAction = '11111111-1111-4111-8111-111111111111';
    const secondAction = '22222222-2222-4222-8222-222222222222';

    await expect(store.claim('report-1', 'v2', firstAction)).resolves.toMatchObject({ shouldSend: true, alreadyRequested: false, attempt: { status: 'pending' } });
    await expect(store.claim('report-1', 'v2', firstAction)).resolves.toMatchObject({ shouldSend: false, alreadyRequested: true, attempt: { actionId: firstAction, status: 'pending' } });
    await expect(store.claim('report-1', 'v2', secondAction)).rejects.toThrow('MANUAL_TELEGRAM_SEND_IN_FLIGHT');
    expect(db.prepare('select count(*) as count from manual_telegram_sends').get()).toEqual({ count: 1 });
  });

  it('completes attempts with allowlisted diagnostics and lists the latest ten without sensitive fields', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    let second = 0;
    const store = new SQLiteManualTelegramSendStore(db, () => `2026-08-14T12:00:${String(second++).padStart(2, '0')}.000Z`);
    for (let index = 0; index < 12; index += 1) {
      const actionId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      await store.claim('report-1', 'legacy', actionId);
      await store.complete('report-1', actionId, index === 11 ? 'indeterminate' : 'sent', index === 11 ? { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response', recordedAt: '2026-08-14T12:00:23.000Z' } : undefined);
    }

    const attempts = await store.list('report-1');
    expect(attempts).toHaveLength(10);
    expect(attempts[0]).toMatchObject({ status: 'indeterminate', diagnostic: { errorCode: 'TELEGRAM_INVALID_RESPONSE' } });
    expect(JSON.stringify(attempts)).not.toMatch(/private-target|private-token|private-chat|private-message|private-response-body|private-request-url|192\.0\.2\.10/);
    const row = db.prepare('select * from manual_telegram_sends order by requested_at desc limit 1').get() as Record<string, unknown>;
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['target_ref', 'token', 'chat_id', 'message_text', 'response_body', 'request_url', 'ip']));
  });

  it('never reclaims an indeterminate attempt automatically', async () => {
    const db = await openTestDatabase();
    runMigrations(db);
    const store = new SQLiteManualTelegramSendStore(db);
    const actionId = '11111111-1111-4111-8111-111111111111';
    await store.claim('report-1', 'v2', actionId);
    await store.complete('report-1', actionId, 'indeterminate');

    await expect(store.claim('report-1', 'v2', actionId)).resolves.toMatchObject({ shouldSend: false, alreadyRequested: true, attempt: { status: 'indeterminate' } });
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
