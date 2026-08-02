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
});

function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, repository), 'utf8');
}
