import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = process.env.SKIN_BROWSER_OUTPUT;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};
const server = http.createServer((request, response) => {
  const filename = path.resolve(
    root,
    '.' + decodeURIComponent(new URL(request.url, 'http://local').pathname),
  );
  if (!filename.startsWith(root) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
    'Content-Length': fs.statSync(filename).size,
  });
  fs.createReadStream(filename).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/demo/index.html`;
let browser;
const checks = [];
const skipped = [];
try {
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  // Effective CSS viewports of an 850x525 window at 100%, 125%, and 150% page zoom.
  const viewports = [
    [1440, 1100],
    [850, 525],
    [680, 420],
    [566, 350],
    [390, 844],
  ];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    for (const scene of ['deepseek', 'naiwa']) {
      await page.goto(`${base}#${scene}`);
      await page.locator('#run-button').scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect();
        const controlIds = ['run-button', 'stop-button', 'fail-button'];
        const boxes = controlIds.map((id) => {
          const element = document.getElementById(id),
            r = element.getBoundingClientRect();
          return {
            id,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        });
        const portrait = document.querySelector('.meme-portrait').getBoundingClientRect();
        const overlap = (a, b) =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          clipped: boxes.filter(
            (r) =>
              r.left < stage.left ||
              r.right > stage.right ||
              r.top < stage.top ||
              r.bottom > stage.bottom,
          ),
          overlaps: boxes.filter((r, i) => boxes.slice(i + 1).some((other) => overlap(r, other))),
          decorationOverlap: boxes.filter((r) => overlap(r, portrait)),
          invisible: boxes.filter((r) => r.width < 1 || r.height < 1),
        };
      });
      assert.deepEqual(
        geometry,
        { overflow: false, clipped: [], overlaps: [], decorationOverlap: [], invisible: [] },
        `${scene} at ${width}x${height}`,
      );
      await page.locator('#run-button').click();
      await page.clock.runFor(1300);
      await page.locator('#scene-trigger').click();
      await page.clock.runFor(2500);
      assert.equal(await page.locator('#stage').getAttribute('data-run-state'), 'running');
      await page.locator('#run-button').click();
      const progress = await page.locator('#progress-value').textContent();
      await page.clock.runFor(1300);
      assert.equal(await page.locator('#progress-value').textContent(), progress);
      await page.locator('#fail-button').click();
      assert.equal(await page.locator('#stage').getAttribute('data-run-state'), 'error');
      await page.locator('#run-button').click();
      await page.clock.runFor(13000);
      assert.equal(await page.locator('#status-label').textContent(), '已完成');
      checks.push(
        `${scene}: ${width}x${height}, controls and decoration separated; timeout, pause, error, retry, success`,
      );
    }
  }
  for (const scene of ['mascot', 'mecha', 'garden', 'vinyl', 'paper', 'sonar']) {
    await page.setViewportSize({ width: 850, height: 525 });
    await page.goto(`${base}#${scene}`);
    await page.locator('#run-button').click();
    await page.clock.runFor(650);
    await page.locator('#stop-button').click();
    assert.equal(await page.locator('#status-label').textContent(), '已取消');
    checks.push(`${scene}: original controls still work at 850x525`);
  }
  // Use real time for native video; a fake DOM/media mock cannot establish decoding or playback.
  const mediaPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  mediaPage.on('pageerror', (error) => errors.push(error.message));
  await mediaPage.goto(`${base}#naiwa`);
  await mediaPage.locator('#scene-trigger').click();
  await mediaPage.waitForFunction(() => document.querySelector('#naiwa-motion').currentTime > 0.25);
  const video = await mediaPage.locator('#naiwa-motion').evaluate((element) => ({
    muted: element.muted,
    paused: element.paused,
    ready: element.readyState,
  }));
  assert(video.muted && !video.paused && video.ready >= 2);
  if (artifacts)
    await mediaPage.locator('#stage').screenshot({ path: path.join(artifacts, '08-naiwa.png') });
  await mediaPage.locator('#reduce-motion').check();
  assert(await mediaPage.locator('#naiwa-motion').evaluate((element) => element.paused));
  await mediaPage.locator('#reduce-motion').uncheck();
  await mediaPage.locator('#scene-trigger').click();
  await mediaPage.locator('#run-button').click();
  await mediaPage.locator('#fail-button').click();
  await mediaPage.waitForFunction(() => {
    const video = document.querySelector('#naiwa-motion');
    return video.paused && video.currentTime === 0;
  });
  assert(await mediaPage.locator('.naiwa-actor .meme-calm-art').isVisible());
  checks.push(
    'native H.264 video decodes, advances silently, stops under reduced motion and error, and shows calm fallback',
  );
  await mediaPage.emulateMedia({ reducedMotion: 'reduce' });
  await mediaPage.goto(`${base}#naiwa`);
  await mediaPage.reload();
  await mediaPage.locator('#scene-trigger').click();
  assert(await mediaPage.locator('#reduce-motion').isDisabled());
  assert(await mediaPage.locator('#naiwa-motion').evaluate((element) => element.paused));
  assert(await mediaPage.locator('.naiwa-actor .meme-laugh-still').isVisible());
  checks.push('system reduced motion enforces static pose while retaining interaction text');
  await mediaPage.emulateMedia({ reducedMotion: 'no-preference' });
  const offlinePage = await browser.newPage();
  try {
    await offlinePage.goto(pathToFileURL(path.join(root, 'demo/index.html')).href + '#naiwa');
    await offlinePage.locator('#scene-trigger').click();
    await offlinePage.waitForFunction(
      () => document.querySelector('#naiwa-motion').currentTime > 0.25,
    );
    checks.push('offline file:// launch also plays local video');
  } catch (error) {
    if (!error.message.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) throw error;
    skipped.push('file:// navigation blocked by managed Chromium policy; localhost HTTP tested');
  } finally {
    await offlinePage.close();
  }
  if (artifacts) {
    await mediaPage.goto(`${base}#deepseek`);
    await mediaPage.locator('#stage').screenshot({ path: path.join(artifacts, '07-deepseek.png') });
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(
    JSON.stringify(
      {
        checks,
        skipped,
        browser: browser.version(),
        boundary: 'Chromium only; no production isolation or native WebView claim.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
