import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const scanRoots = ['backend', 'frontend', 'packages', 'tests'];
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const focusedPattern = /\b(?:describe|it|test)\.only\s*\(/;

async function collectFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'coverage')
      .map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return collectFiles(fullPath);
        }
        if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
          return [fullPath];
        }
        return [];
      })
  );

  return files.flat();
}

const files = (await Promise.all(scanRoots.map((scanRoot) => collectFiles(path.join(root, scanRoot))))).flat();
const offenders = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (focusedPattern.test(content)) {
    offenders.push(path.relative(root, file));
  }
}

if (offenders.length > 0) {
  console.error('Focused tests are not allowed. Remove .only from:');
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

console.log(`No focused tests found in ${files.length} files.`);
