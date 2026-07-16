import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

describe('Docker Compose runtime modes', () => {
  it('declares safe local defaults and a hardened reverse-proxy override', async () => {
    const [compose, reverseProxy, environment] = await Promise.all([
      readRepositoryFile('compose.yaml'),
      readRepositoryFile('compose.reverse-proxy.yaml'),
      readRepositoryFile('.env.example')
    ]);

    expect(compose).toContain('RUNTIME_MODE: "${RUNTIME_MODE:-local}"');
    expect(compose).toContain('TRUST_PROXY: "${TRUST_PROXY:-false}"');
    expect(compose).toContain('SECURE_COOKIES: "${SECURE_COOKIES:-false}"');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('pids_limit: 100');
    expect(compose).toContain('/tmp:rw,noexec,nosuid,size=64m');
    expect(compose).toContain('/data');
    expect(compose).toContain('HA_LOG_FILE');
    expect(compose).toContain(':/ha-logs/home-assistant.log:ro');
    expect(compose).not.toMatch(/docker\.sock|network_mode:\s*host|privileged:\s*true|\/config:/);

    expect(reverseProxy).toContain('RUNTIME_MODE: reverse-proxy');
    expect(reverseProxy).toContain('TRUST_PROXY: "true"');
    expect(reverseProxy).toContain('SECURE_COOKIES: "true"');
    expect(environment).toContain('RUNTIME_MODE=local');
    expect(environment).toContain('TRUST_PROXY=false');
    expect(environment).toContain('SECURE_COOKIES=false');
    expect(environment).toContain('HA_LOG_FILE=');
  });

  it('keeps application code and the HA log mount outside the writable data boundary', async () => {
    const dockerfile = await readRepositoryFile('Dockerfile');

    expect(dockerfile).toContain('chown -R root:root /app');
    expect(dockerfile).toContain('mkdir -p /data/logs /ha-logs && chown -R app:app /data');
    expect(dockerfile).not.toContain('chown -R app:app /data /ha-logs');
    expect(dockerfile).toContain('USER app');
  });
});

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, `file://${repositoryRoot}/`), 'utf8');
}
