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
    expect(compose).toContain('host.docker.internal:host-gateway');
    expect(compose).toContain('HA_MAX_STATES');
    expect(compose).not.toMatch(/docker\.sock|network_mode:\s*host|privileged:\s*true|\/config:|watcher/);

    expect(reverseProxy).toContain('RUNTIME_MODE: reverse-proxy');
    expect(reverseProxy).toContain('TRUST_PROXY: "true"');
    expect(reverseProxy).toContain('SECURE_COOKIES: "true"');
    expect(environment).toContain('RUNTIME_MODE=local');
    expect(environment).toContain('TRUST_PROXY=false');
    expect(environment).toContain('SECURE_COOKIES=false');
    expect(environment).toContain('HA_LOG_FILE=');
    expect(environment).toContain('HA_MAX_LOG_LINES=200');
  });

  it('keeps application code and the HA log mount outside the writable data boundary', async () => {
    const dockerfile = await readRepositoryFile('Dockerfile');

    expect(dockerfile).not.toContain('chown -R root:root /app');
    expect(dockerfile).toContain('COPY --from=build /app/backend/dist ./backend/dist');
    expect(dockerfile).toContain('mkdir -p /data/logs /ha-logs && chown -R app:app /data');
    expect(dockerfile).not.toContain('chown -R app:app /data /ha-logs');
    expect(dockerfile).toContain('USER app');
  });

  it('defines an internal fake-HA verification overlay with no host HA mount or external dependency', async () => {
    const verification = await readRepositoryFile('compose.verify.yaml');

    expect(verification).toContain('fake-ha:');
    expect(verification).toContain('internal: true');
    expect(verification).toContain('host-access');
    expect(verification).toContain('docker/verify/fake-ha.mjs');
    expect(verification).not.toMatch(/network_mode:\s*host|privileged:\s*true|docker\.sock|\/config:/);
  });

  it('accelerates health polling only in the disposable verification overlay', async () => {
    const [compose, verification] = await Promise.all([
      readRepositoryFile('compose.yaml'),
      readRepositoryFile('compose.verify.yaml')
    ]);

    expect(compose).toContain('interval: 30s');
    expect(verification).toContain('healthcheck:');
    expect(verification).toContain('interval: 2s');
    expect(verification).toContain('timeout: 1s');
    expect(verification).toContain('retries: 3');
    expect(verification).toContain('start_period: 1s');
  });
});

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, `file://${repositoryRoot}/`), 'utf8');
}
