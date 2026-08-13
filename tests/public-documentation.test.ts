import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const repository = new URL('..', import.meta.url);

describe('public product documentation', () => {
  it('describes the real six-screen setup, editable settings, and durable report lifecycle', async () => {
    const [readme, configuration, operations, experienceShell] = await Promise.all([
      readRepositoryFile('README.md'),
      readRepositoryFile('docs/configuration.md'),
      readRepositoryFile('docs/operations/docker-runtime.md'),
      readRepositoryFile('docs/architecture/experience-shell.md')
    ]);

    expect(readme).toContain('## Six-screen onboarding');
    expect(readme).toContain('## Report job lifecycle');
    expect(readme).toContain('Settings are editable after setup');
    expect(configuration).toContain('## First-run onboarding (six screens)');
    expect(configuration).toContain('## Edit saved settings');
    expect(configuration).toContain('## Report job lifecycle and recovery');
    expect(operations).toContain('onboarding, settings, completed jobs, and reports survive a restart');
    expect(experienceShell).toContain('## Operational shell');
    expect(experienceShell).toContain('## Configuration ownership');
    expect(experienceShell).toContain('## Reports and lifecycle');
  });

  it('documents the v2 Docker contract without obsolete bootstrap tokens or preview-only claims', async () => {
    const [readme, configuration, operations, context] = await Promise.all([
      readRepositoryFile('README.md'),
      readRepositoryFile('docs/configuration.md'),
      readRepositoryFile('docs/operations/docker-runtime.md'),
      readRepositoryFile('CONTEXT.md')
    ]);

    for (const document of [readme, configuration, operations]) {
      expect(document).not.toContain('ADMIN_TOKEN');
      expect(document).not.toContain('SETUP_TOKEN');
    }
    expect(readme).toContain('Home Assistant Core running in Docker');
    expect(readme).toContain('AI costs scale with the number of error signatures analyzed');
    expect(configuration).toContain('OpenAI, Gemini, and Ollama');
    expect(configuration).toContain('no Telegram message is sent');
    expect(operations).toContain('No Docker socket, host networking, privileged mode');
    expect(context).toContain('Admin account');
  });

  it('documents stdout lifecycle separately from HTTP health and readiness', async () => {
    const operations = await readRepositoryFile('docs/operations/docker-runtime.md');

    expect(operations).toContain('startup, listening, and shutdown');
    expect(operations).toContain('Readiness is exposed by `/ready`');
    expect(operations).toContain('liveness is exposed by `/health`');
    expect(operations).not.toContain('stdout for runtime startup, readiness, shutdown');
  });
});

function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repository), 'utf8');
}
