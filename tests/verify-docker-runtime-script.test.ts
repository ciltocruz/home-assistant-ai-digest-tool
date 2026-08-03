import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/verify-docker-runtime.sh', import.meta.url));
let verificationRun: Promise<{ stdout: string; stderr: string }> | undefined;
let timeoutContract: Promise<{ callerTimeoutSeconds: number }> | undefined;

describe('Docker runtime verification command', () => {
  it('provides a runnable, secret-safe verification entry point', async () => {
    await expect(access(scriptPath, constants.R_OK)).resolves.toBeUndefined();

    const { stdout, stderr } = await execute('bash', [scriptPath, '--help'], { cwd: repositoryRoot });

    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: pnpm verify:docker');
    expect(stdout).toContain('does not print supplied tokens');
  });

  it('publishes one authoritative verifier timeout contract', async () => {
    const { stdout, stderr } = await execute('bash', [scriptPath, '--print-timeout-contract'], {
      cwd: repositoryRoot
    });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      durationSeconds: 180,
      cleanupGraceSeconds: 20,
      callerTimeoutSeconds: 205
    });
  });

  it('exposes the lightweight preflight through pnpm without the full runtime lifecycle', async () => {
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    expect(packageManifest.scripts['verify:docker:preflight']).toBe('bash scripts/verify-docker-runtime.sh --preflight');
  });

  it('documents the verifier preflight, deadline contract, cleanup, and rollback boundary', async () => {
    const guide = await readFile(new URL('../docs/operations/docker-runtime.md', import.meta.url), 'utf8');

    expect(guide).toContain('pnpm verify:docker:preflight');
    expect(guide).toContain('--print-timeout-contract');
    expect(guide).toContain('180 seconds');
    expect(guide).toContain('SIGINT');
    expect(guide).toContain('stale verifier-owned');
    expect(guide).toContain('Rollback');
  });

  it('uses a fallback port during preflight without invoking Docker Compose', async () => {
    const occupiedPort = 38123;
    const listener = createServer();
    const fakeDocker = await createFakeDocker();
    await new Promise<void>((resolve) => listener.listen(occupiedPort, '127.0.0.1', resolve));

    try {
      const { VERIFY_DOCKER_PORT: _ignored, ...environment } = process.env;
      const { stdout, stderr } = await execute('bash', [scriptPath, '--preflight'], {
        cwd: repositoryRoot,
        env: { ...environment, ...fakeDocker.environment }
      });
      const result = JSON.parse(stdout);

      expect(stderr).toBe('');
      expect(result.port).not.toBe(occupiedPort);
      expect(result.projectName).toMatch(/^ha-digest-verify-/);
      expect(result.projectName).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      await expect(access(fakeDocker.calls)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await fakeDocker.cleanup();
    }
  });

  it('gives concurrent preflight runs separate workspaces, projects, and fallback ports', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ha-digest-concurrent-runs-'));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(38123, '127.0.0.1', resolve));

    try {
      const environment = { ...process.env, VERIFY_DOCKER_RUN_ROOT: runRoot };
      const results = await Promise.all([
        execute('bash', [scriptPath, '--preflight'], { cwd: repositoryRoot, env: environment }),
        execute('bash', [scriptPath, '--preflight'], { cwd: repositoryRoot, env: environment })
      ]);
      const [first, second] = results.map(({ stdout }) => JSON.parse(stdout) as { workspace: string; projectName: string; port: number });

      expect(first.workspace).not.toBe(second.workspace);
      expect(first.projectName).not.toBe(second.projectName);
      expect(first.port).not.toBe(second.port);
      await expect(readdir(runRoot)).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('rejects an occupied requested port during preflight before Docker Compose starts', async () => {
    const listener = createServer();
    const fakeDocker = await createFakeDocker();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port');

    try {
      const result = await execute('bash', [scriptPath, '--preflight'], {
        cwd: repositoryRoot,
        env: { ...process.env, ...fakeDocker.environment, VERIFY_DOCKER_PORT: String(address.port) }
      }).then(
        () => ({ stdout: '', stderr: '', code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error
      );

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(`Requested verification port ${address.port} is unavailable`);
      await expect(access(fakeDocker.calls)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await fakeDocker.cleanup();
    }
  });

  it('recovers only a complete dead verifier run before preflight', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ha-digest-verifier-runs-'));
    const staleRun = join(runRoot, 'run.stale');
    const liveRun = join(runRoot, 'run.live');
    const youngRun = join(runRoot, 'run.young');
    const malformedRun = join(runRoot, 'run.malformed');
    const unrelatedRun = join(runRoot, 'outside');
    const fakeDocker = await createFakeDocker();
    await mkdir(staleRun);
    await mkdir(liveRun);
    await mkdir(youngRun);
    await mkdir(malformedRun);
    await mkdir(unrelatedRun);
    await writeFile(join(staleRun, 'metadata'), [
      'owner_pid=999999',
      'owner_start_token=never-active',
      'project_name=ha-digest-verify-run-stale',
      'port=38123',
      'created_at=1'
    ].join('\n'));
    await writeFile(join(liveRun, 'metadata'), [
      `owner_pid=${process.pid}`,
      `owner_start_token=${await getCurrentProcessStartToken()}`,
      'project_name=ha-digest-verify-run-live',
      'port=38124',
      'created_at=1'
    ].join('\n'));
    await writeFile(join(youngRun, 'metadata'), [
      'owner_pid=999998',
      'owner_start_token=never-active',
      'project_name=ha-digest-verify-run-young',
      'port=38125',
      `created_at=${Math.floor(Date.now() / 1_000)}`
    ].join('\n'));
    await writeFile(join(malformedRun, 'metadata'), 'project_name=not-a-verifier\n');
    await writeFile(join(unrelatedRun, 'metadata'), 'unrelated=true\n');

    try {
      const { stderr } = await execute('bash', [scriptPath, '--preflight'], {
        cwd: repositoryRoot,
        env: { ...process.env, ...fakeDocker.environment, VERIFY_DOCKER_RUN_ROOT: runRoot }
      });

      expect(stderr).not.toContain('Recovering stale verifier project');
      await expect(access(staleRun)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(liveRun)).resolves.toBeUndefined();
      await expect(access(youngRun)).resolves.toBeUndefined();
      await expect(access(malformedRun)).resolves.toBeUndefined();
      await expect(access(unrelatedRun)).resolves.toBeUndefined();
      await expect(readFile(fakeDocker.calls, 'utf8')).resolves.toContain('--project-name ha-digest-verify-run-stale');
    } finally {
      await fakeDocker.cleanup();
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  it('bounds readiness observation by the verifier deadline and reports the last HTTP status', async () => {
    const fakes = await createDeadlineFakes();
    const startedAt = Date.now();

    try {
      const result = await execute('bash', [scriptPath], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ...fakes.environment,
          VERIFY_DOCKER_DURATION_SECONDS: '2',
          VERIFY_DOCKER_CLEANUP_GRACE_SECONDS: '1'
        },
        timeout: 6_000
      }).then(
        () => ({ stdout: '', stderr: '', code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error
      );

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('phase=readiness');
      expect(`${result.stdout}${result.stderr}`).toContain('last_http_status=000');
    } finally {
      await fakes.cleanup();
    }
  }, 10_000);

  it('bounds Docker health observation by the same deadline and reports the last health state', async () => {
    const fakes = await createHealthDeadlineFakes();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ha-digest-health-deadline-'));

    try {
      const result = await execute('bash', ['-c', [
        'source "$1"',
        'temp_dir="$2"',
        'app_port=38124',
        'project_name=ha-digest-verify-health-test',
        'deadline_started_at=$SECONDS',
        'wait_for_health_status healthy'
      ].join('; '), 'bash', scriptPath, temporaryDirectory], {
        cwd: repositoryRoot,
        env: { ...process.env, ...fakes.environment, VERIFY_DOCKER_DURATION_SECONDS: '1' }
      }).then(
        () => ({ stdout: '', stderr: '', code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error
      );

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('phase=health');
      expect(`${result.stdout}${result.stderr}`).toContain('last_health_status=starting');
    } finally {
      await fakes.cleanup();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 10_000);

  it('cleans the owned workspace and Compose project after SIGTERM', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'ha-digest-signal-runs-'));
    const fakes = await createDeadlineFakes({ delayedCurl: true });
    const child = spawn('bash', [scriptPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...fakes.environment,
        VERIFY_DOCKER_RUN_ROOT: runRoot,
        VERIFY_DOCKER_DURATION_SECONDS: '10',
        VERIFY_DOCKER_CLEANUP_GRACE_SECONDS: '1'
      }
    });

    try {
      await waitFor(() => readdir(runRoot).then((entries) => entries.some((entry) => entry.startsWith('run.'))));
      await new Promise((resolve) => setTimeout(resolve, 200));
      child.kill('SIGTERM');
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });

      expect(signal).toBeNull();
      expect(code).toBe(143);
      await expect(readdir(runRoot)).resolves.toEqual([]);
      await expect(readFile(fakes.calls, 'utf8')).resolves.toContain('down --volumes --remove-orphans');
    } finally {
      child.kill('SIGKILL');
      await fakes.cleanup();
      await rm(runRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('uses a free verification port when the historic default port is occupied', async () => {
    const occupiedPort = 38123;
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(occupiedPort, '127.0.0.1', resolve));

    try {
      const { VERIFY_DOCKER_PORT: _ignored, ...environment } = process.env;
      const { stdout, stderr } = await execute('bash', [scriptPath], { cwd: repositoryRoot, env: environment, timeout: 175_000 });

      expect(stderr).toBe('');
      expect(stdout).toContain('Docker runtime verification passed.');
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  }, 215_000);

  it('redacts failure diagnostics without treating sed expressions as file paths', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'ha-digest-fake-docker-'));
    const fakeDocker = join(fakeBin, 'docker');
    await writeFile(fakeDocker, `#!/usr/bin/env sh
if [ "$1" = "info" ] || { [ "$1" = "compose" ] && [ "$2" = "version" ]; }; then
  exit 0
fi
printf 'Authorization: Bearer fixture-bearer-secret\\ncsrfToken=fixture-csrf-secret\\n' >&2
exit 1
`);
    await chmod(fakeDocker, 0o755);

    try {
      const result = await execute('bash', [scriptPath], {
        cwd: repositoryRoot,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }
      }).then(
        () => ({ stdout: '', stderr: '', code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error
      );
      const output = `${result.stdout}${result.stderr}`;

      expect(result.code).not.toBe(0);
      expect(output).toContain('[REDACTED]');
      expect(output).not.toContain('fixture-bearer-secret');
      expect(output).not.toContain('fixture-csrf-secret');
      expect(output).not.toContain("sed: can't read");
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it('executes local and reverse-proxy container boundaries instead of inspecting script strings', async () => {
    const { stdout, stderr } = await runDockerVerification();

    expect(stderr).toBe('');
    expect(stdout).toContain('Validating local Docker runtime mode.');
    expect(stdout).toContain('Verified write boundaries and restart persistence.');
    expect(stdout).toContain('Validating reverse-proxy Docker runtime mode.');
  }, 215_000);

  it('executes startup-failure persistence verification without exposing supplied tokens', async () => {
    const { stdout, stderr } = await runDockerVerification();

    expect(stderr).toBe('');
    expect(stdout).toContain('Verified secret-safe startup failure logging.');
    expect(`${stdout}${stderr}`).not.toContain('docker-runtime-verification-admin-token');
    expect(`${stdout}${stderr}`).not.toContain('docker-runtime-verification-setup-token');
  }, 215_000);

  it('reports a successful executable verification result', async () => {
    const { stdout, stderr } = await runDockerVerification();

    expect(stderr).toBe('');
    expect(stdout).toContain('Docker runtime verification passed.');
  }, 215_000);

  it('proves fake-provider/fake-HA analysis, mounted logs, restart retrieval, and failed-source no-persistence without leaking verification credentials', async () => {
    const { stdout, stderr } = await runDockerVerification();

    expect(stderr).toBe('');
    expect(stdout).toContain('Verified fake-provider, fake-HA REST, and mounted-log analysis.');
    expect(stdout).toContain('Verified report retrieval after restart.');
    expect(stdout).toContain('Verified fake-HA source failure without a new report.');
    expect(`${stdout}${stderr}`).not.toContain('docker-runtime-verification-ha-token');
  }, 180_000);

  it('proves persisted onboarding, settings, and completed report jobs after a container restart', async () => {
    const { stdout, stderr } = await runDockerVerification();

    expect(stderr).toBe('');
    expect(stdout).toContain('Verified persisted onboarding, settings, and report job after restart.');
  }, 180_000);
});

async function runDockerVerification(): Promise<{ stdout: string; stderr: string }> {
  timeoutContract ??= execute('bash', [scriptPath, '--print-timeout-contract'], { cwd: repositoryRoot })
    .then(({ stdout }) => JSON.parse(stdout) as { callerTimeoutSeconds: number });
  const { callerTimeoutSeconds } = await timeoutContract;
  verificationRun ??= execute('pnpm', ['verify:docker'], {
    cwd: repositoryRoot,
    timeout: callerTimeoutSeconds * 1_000
  });
  return verificationRun;
}

async function getCurrentProcessStartToken(): Promise<string> {
  return (await readFile(`/proc/${process.pid}/stat`, 'utf8')).trim().split(' ')[21];
}

async function createFakeDocker(): Promise<{
  calls: string;
  environment: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'ha-digest-fake-docker-'));
  const calls = join(directory, 'calls');
  const docker = join(directory, 'docker');
  await writeFile(docker, `#!/usr/bin/env sh
if [ "$1" = "info" ] || { [ "$1" = "compose" ] && [ "$2" = "version" ]; }; then
  exit 0
fi
printf '%s\\n' "$*" >> "$VERIFY_DOCKER_FAKE_CALLS"
if [ "$1" = "compose" ] && printf '%s\\n' "$*" | grep -q ' down'; then
  exit 0
fi
exit 91
`);
  await chmod(docker, 0o755);

  return {
    calls,
    environment: {
      PATH: `${directory}:${process.env.PATH}`,
      VERIFY_DOCKER_FAKE_CALLS: calls
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function createDeadlineFakes(options: { delayedCurl?: boolean } = {}): Promise<{
  environment: Record<string, string>;
  calls: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'ha-digest-deadline-fakes-'));
  const docker = join(directory, 'docker');
  const curl = join(directory, 'curl');
  const calls = join(directory, 'calls');
  await writeFile(docker, `#!/usr/bin/env sh
printf '%s\\n' "$*" >> "$VERIFY_DOCKER_FAKE_CALLS"
exit 0
`);
  await writeFile(curl, `#!/usr/bin/env sh
${options.delayedCurl ? 'sleep 1' : ''}
printf 000
`);
  await chmod(docker, 0o755);
  await chmod(curl, 0o755);

  return {
    environment: { PATH: `${directory}:${process.env.PATH}`, VERIFY_DOCKER_FAKE_CALLS: calls },
    calls,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function createHealthDeadlineFakes(): Promise<{
  environment: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'ha-digest-health-fakes-'));
  const docker = join(directory, 'docker');
  await writeFile(docker, `#!/usr/bin/env sh
case "$*" in
  *'ps --quiet app'*) printf 'fake-app-container' ;;
  inspect*) printf 'starting' ;;
esac
`);
  await chmod(docker, 0o755);
  return {
    environment: { PATH: `${directory}:${process.env.PATH}` },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for verifier process state');
}
