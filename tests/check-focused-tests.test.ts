import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardScript = path.join(projectRoot, 'scripts/check-focused-tests.mjs');

async function createWorkspaceWithFile(relativeFilePath: string, content: string) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'focused-tests-'));
  const filePath = path.join(workspace, relativeFilePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return workspace;
}

describe('focused-test guard', () => {
  it('passes when scanned files do not contain focused tests', async () => {
    const workspace = await createWorkspaceWithFile(
      'packages/shared/src/example.test.ts',
      "import { it } from 'vitest';\nit('runs normally', () => {});\n"
    );

    await expect(execFileAsync(process.execPath, [guardScript], { cwd: workspace })).resolves.toMatchObject({
      stdout: expect.stringContaining('No focused tests found in 1 files.')
    });
  });

  it.each(['describe.only', 'it.only', 'test.only'])('fails when %s is found', async (focusedApi) => {
    const workspace = await createWorkspaceWithFile(
      'packages/shared/src/example.test.ts',
      `import { ${focusedApi.split('.')[0]} } from 'vitest';\n${focusedApi}('focuses accidentally', () => {});\n`
    );

    await expect(execFileAsync(process.execPath, [guardScript], { cwd: workspace })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('packages/shared/src/example.test.ts')
    });
  });
});
