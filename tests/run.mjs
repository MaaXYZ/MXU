import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = dirname(fileURLToPath(import.meta.url));

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return findTestFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const testFiles = findTestFiles(testsDirectory).sort();
if (testFiles.length === 0) {
  throw new Error('No .test.ts files found under tests/');
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  stdio: 'inherit',
});
if (result.error) {
  throw result.error;
}
if (result.signal) {
  throw new Error(`Node test runner exited on signal ${result.signal}`);
}
process.exitCode = result.status ?? 1;
