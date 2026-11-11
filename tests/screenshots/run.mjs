import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const browser =
  process.env.MXU_TEST_BROWSER ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
assert.ok(browser, 'Set MXU_TEST_BROWSER to a Chromium browser executable');

const scratch = mkdtempSync(join(tmpdir(), 'mxu-screenshot-test-'));
try {
  await build({
    configFile: false,
    root: repo,
    publicDir: false,
    logLevel: 'error',
    resolve: { alias: { '@': join(repo, 'src') } },
    esbuild: { jsx: 'automatic' },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __MXU_VERSION__: JSON.stringify('test'),
    },
    build: {
      outDir: scratch,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./browser.jsx', import.meta.url)),
        name: 'ScreenshotTests',
        formats: ['iife'],
        fileName: () => 'test.js',
      },
    },
  });
  const html = join(scratch, 'test.html');
  writeFileSync(
    html,
    `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; img-src data:; style-src 'unsafe-inline'">
<div id="root"></div><pre id="result"></pre><script src="./test.js"></script>`,
  );
  const result = spawnSync(
    browser,
    [
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(scratch, 'profile')}`,
      '--dump-dom',
      '--virtual-time-budget=190000',
      pathToFileURL(html).href,
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Browser failed: ${result.stderr.slice(-2000)}`);
  const encoded = /<pre id="result">([a-zA-Z0-9+/=]+)<\/pre>/.exec(result.stdout)?.[1];
  assert.ok(encoded, `Screenshot tests did not finish: ${result.stderr.slice(-2000)}`);
  const results = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  assert.ok(results.length, 'No screenshot tests ran');
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
  assert.ok(
    results.every((result) => result.passed),
    'Screenshot regression failed',
  );
} finally {
  // Only this run's private browser profile and generated bundle are removed.
  assert.equal(dirname(scratch), tmpdir());
  assert.ok(basename(scratch).startsWith('mxu-screenshot-test-'));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
