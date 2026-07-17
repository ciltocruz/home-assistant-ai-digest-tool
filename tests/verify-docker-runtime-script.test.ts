import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/verify-docker-runtime.sh', import.meta.url));
const operationsGuidePath = fileURLToPath(new URL('../docs/operations/docker-runtime.md', import.meta.url));

describe('Docker runtime verification command', () => {
  it('provides a runnable, secret-safe verification entry point', async () => {
    await expect(access(scriptPath, constants.R_OK)).resolves.toBeUndefined();

    const { stdout, stderr } = await execute('bash', [scriptPath, '--help'], { cwd: repositoryRoot });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: pnpm verify:docker');
    expect(stdout).toContain('does not print supplied tokens');
  });

  it('covers both modes and every Docker boundary required by the runtime contract', async () => {
    const script = await readFile(scriptPath, 'utf8');

    expect(script).toContain('compose.reverse-proxy.yaml');
    expect(script).toContain('X-Forwarded-Proto: https');
    expect(script).toContain('Secure');
    expect(script).toContain('/ready');
    expect(script).toContain('/app');
    expect(script).toContain('/tmp');
    expect(script).toContain('/data');
    expect(script).toContain('restart');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain('[REDACTED]');
  });

  it('documents owner-only backups for the complete sensitive data unit', async () => {
    const guide = await readFile(operationsGuidePath, 'utf8');

    expect(guide).toContain('umask 077');
    expect(guide).toContain('chmod 0700 "$backup_dir"');
    expect(guide).toContain('chmod 0600 "$archive"');
  });
});
