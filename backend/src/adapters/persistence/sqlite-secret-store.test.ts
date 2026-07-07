import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SQLiteSecretStore } from './sqlite-secret-store.js';

process.emitWarning = (() => undefined) as typeof process.emitWarning;

describe('SQLiteSecretStore', () => {
  it('stores encrypted secrets behind masked refs and resolves raw values only on explicit lookup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-secret-store-'));
    const db = await openTestDatabase();
    runMigrations(db);
    const store = await SQLiteSecretStore.create({ db, dataDir });

    const rawSecret = 'raw-provider-secret-value';
    const stored = await store.put('ai_provider', rawSecret);

    expect(stored.ref).toMatch(/^secret_/);
    expect(stored.mask).not.toContain(rawSecret);
    expect(JSON.stringify(stored)).not.toContain(rawSecret);
    await expect(store.resolve(stored.ref)).resolves.toBe(rawSecret);

    const persisted = db.prepare('select encrypted_value from secrets where id = ?').get(stored.ref) as {
      encrypted_value: string;
    };
    expect(persisted.encrypted_value).not.toContain(rawSecret);
    expect(await readFile(join(dataDir, 'app.key'), 'utf8')).not.toContain(rawSecret);
  });

  it('creates /data/app.key equivalent material with owner-only permissions where supported', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ha-digest-key-'));
    const db = await openTestDatabase();
    runMigrations(db);

    await SQLiteSecretStore.create({ db, dataDir });

    const keyMode = (await stat(join(dataDir, 'app.key'))).mode & 0o777;
    expect(keyMode).toBe(0o600);
  });
});

async function openTestDatabase() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(':memory:');
}
