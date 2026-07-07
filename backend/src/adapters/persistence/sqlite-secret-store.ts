import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretKind, SecretStore, StoredSecretRef } from '../../domain/stores.js';

type SecretStoreOptions = {
  db: DatabaseSync;
  dataDir?: string;
};

type SecretRow = {
  id: string;
  kind: SecretKind;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
};

export class SQLiteSecretStore implements SecretStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer
  ) {}

  static async create(options: SecretStoreOptions): Promise<SQLiteSecretStore> {
    return new SQLiteSecretStore(options.db, await loadOrCreateKey(options.dataDir ?? '/data'));
  }

  async put(kind: SecretKind, raw: string): Promise<StoredSecretRef> {
    const ref = `secret_${kind}_${randomUUID()}`;
    const encrypted = encrypt(raw, this.key);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `insert into secrets(id, kind, encrypted_value, iv, auth_tag, created_at, updated_at)
         values (@id, @kind, @encryptedValue, @iv, @authTag, @now, @now)`
      )
      .run({ id: ref, kind, encryptedValue: encrypted.value, iv: encrypted.iv, authTag: encrypted.authTag, now });

    return { ref, kind, mask: maskSecret(raw) };
  }

  async resolve(ref: string): Promise<string> {
    const row = this.getRow(ref);
    return decrypt({ value: row.encrypted_value, iv: row.iv, authTag: row.auth_tag }, this.key);
  }

  async mask(ref: string): Promise<StoredSecretRef> {
    const row = this.getRow(ref);
    const raw = decrypt({ value: row.encrypted_value, iv: row.iv, authTag: row.auth_tag }, this.key);
    return { ref: row.id, kind: row.kind, mask: maskSecret(raw) };
  }

  async rotate(ref: string, raw: string): Promise<void> {
    const encrypted = encrypt(raw, this.key);
    const result = this.db
      .prepare(
        `update secrets
         set encrypted_value = @encryptedValue, iv = @iv, auth_tag = @authTag, updated_at = @updatedAt
         where id = @id`
      )
      .run({ id: ref, encryptedValue: encrypted.value, iv: encrypted.iv, authTag: encrypted.authTag, updatedAt: new Date().toISOString() });
    if (result.changes !== 1) throw new Error('Secret ref not found');
  }

  private getRow(ref: string): SecretRow {
    const row = this.db.prepare('select id, kind, encrypted_value, iv, auth_tag from secrets where id = ?').get(ref) as
      | SecretRow
      | undefined;
    if (!row) throw new Error('Secret ref not found');
    return row;
  }
}

async function loadOrCreateKey(dataDir: string): Promise<Buffer> {
  const keyPath = join(dataDir, 'app.key');
  await mkdir(dataDir, { recursive: true });
  try {
    return Buffer.from(await readFile(keyPath, 'utf8'), 'base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    await writeFile(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
    return key;
  }
}

function encrypt(raw: string, key: Buffer): { value: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const value = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return { value: value.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

function decrypt(input: { value: string; iv: string; authTag: string }, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(input.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(input.value, 'base64')), decipher.final()]).toString('utf8');
}

function maskSecret(raw: string): string {
  if (raw.length <= 4) return '••••';
  return `${raw.slice(0, 2)}…${raw.slice(-2)}`;
}
