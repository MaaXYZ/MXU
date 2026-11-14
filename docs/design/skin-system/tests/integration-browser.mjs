import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Exercise the actual App/settings, with a simulated Maa backend and no device commands.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = process.env.SKIN_INTEGRATION_OUTPUT;
if (output) fs.mkdirSync(output, { recursive: true });
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
const checks = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH ||
      (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/api/ws', () => {});
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/interface') {
      body = {
        interface: {
          interface_version: 2,
          name: 'MXU Skin Preview',
          version: '0.0.0-dev',
          task: [],
          resource: [],
          controller: [],
        },
        translations: {},
        basePath: '',
        dataPath: '',
        backendOS: 'linux',
      };
    } else if (url.pathname === '/api/config/snapshot') {
      body = {
        revision: 'fixture-1',
        config: {
          version: '1.0',
          instances: [],
          settings: {
            theme: 'dark',
            accentColor: 'deepsea',
            language: 'zh-CN',
            skinId: 'deepseek',
            skinReducedMotion: false,
            onboardingCompleted: true,
          },
        },
      };
    } else if (url.pathname === '/api/config' && route.request().method() === 'PUT') {
      body = { revision: 'fixture-2', config: route.request().postDataJSON().config };
    } else if (url.pathname === '/api/maa/state') {
      body = {
        instances: {},
        cached_adb_devices: [],
        cached_win32_windows: [],
        cached_wlroots_sockets: [],
        cached_gamescope_instances: [],
      };
    } else if (url.pathname === '/api/maa/initialized') {
      body = { initialized: true, version: '5.0.0' };
    } else if (url.pathname === '/api/focus/pending') body = [];
    await route.fulfill({ json: body });
  });
  const base = server.resolvedUrls.local[0];
  await page.goto(base);
  await page.locator('[data-builtin-skin="deepseek"]').waitFor();
  assert(await page.locator('html').evaluate((element) => element.classList.contains('dark')));
  checks.push('startup restores skin and theme even when the saved configuration has no instances');
  assert.equal(
    await page.locator('[data-builtin-skin] p').count(),
    0,
    'companions do not invent dialogue',
  );
  await page.getByRole('button', { name: '投喂白饭', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-builtin-skin="deepseek"] video')?.currentTime > 0.2,
  );
  assert(
    await page
      .locator('[data-builtin-skin="deepseek"] video')
      .evaluate((element) => element.muted && !element.paused),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(
    () => document.querySelector('[data-builtin-skin="deepseek"] video').paused,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push(
    'community rice-eating footage plays silently and respects reduced motion without character dialogue',
  );
  await page.getByTitle('设置', { exact: true }).click();
  await page.getByRole('button', { name: '奶蛙', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '奶蛙', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await page.getByRole('button', { name: '播放大笑', exact: true }).click();
  const video = page.locator('[data-builtin-skin] video');
  await page.waitForFunction(
    () => document.querySelector('[data-builtin-skin] video')?.currentTime > 0.2,
  );
  assert(await video.evaluate((element) => element.muted && !element.paused));
  await page.getByRole('checkbox', { name: '减少皮肤动效', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('[data-builtin-skin] video').paused);
  await page.getByRole('checkbox', { name: '减少皮肤动效', exact: true }).uncheck();
  if (output) {
    await page.locator('#settings-skin-label').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'settings-skins.png') });
  }
  checks.push(
    'settings selects each bundled skin and previews real silent video with a motion toggle',
  );
  await page.reload();
  await page.locator('[data-builtin-skin="naiwa"]').waitFor();
  assert(await page.locator('html').evaluate((element) => element.classList.contains('dark')));
  assert.deepEqual(
    await page.evaluate(() => {
      const appearance = JSON.parse(localStorage.getItem('mxu-webui-appearance'));
      return {
        theme: appearance.theme,
        language: appearance.language,
        accent: appearance.accentColor,
      };
    }),
    { theme: 'dark', language: 'zh-CN', accent: 'deepsea' },
  );
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mxu-webui-appearance')).skinId),
    'naiwa',
  );
  checks.push('WebUI selection persists across reload without overwriting the backend appearance');

  const setTaskState = async (mode) =>
    page.evaluate(async (state) => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const store = useAppStore.getState();
      store.updateInstance(store.activeInstanceId, { isRunning: state === 'running' });
      store.setInstanceTaskStatus(
        store.activeInstanceId,
        state === 'success'
          ? 'Succeeded'
          : state === 'error'
            ? 'Failed'
            : state === 'running'
              ? 'Running'
              : null,
      );
    }, mode);
  await setTaskState('running');
  await page.getByTitle('设置', { exact: true }).click();
  const retained = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const before = useAppStore.getState();
    const instances = before.instances,
      statuses = before.instanceTaskStatus;
    before.setSkinId('deepseek');
    const after = useAppStore.getState();
    return (
      instances === after.instances &&
      statuses === after.instanceTaskStatus &&
      before.theme === after.theme &&
      before.accentColor === after.accentColor
    );
  });
  assert(retained);
  assert.equal(
    await page.locator('[data-builtin-skin]').getAttribute('data-task-state'),
    'idle',
    'settings preview must not impersonate the running task',
  );
  await page.getByRole('button', { name: '默认', exact: true }).click();
  assert.equal(await page.locator('[data-builtin-skin]').count(), 0);
  await page.getByRole('button', { name: '奶蛙', exact: true }).click();
  await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore.getState().setCurrentPage('main'),
  );
  assert.equal(
    await page.locator('[data-builtin-skin]').getAttribute('data-task-state'),
    'running',
  );
  checks.push(
    'switching/default removal leaves the running task and existing theme intact; preview remains independent',
  );
  await setTaskState('success');
  await page.waitForFunction(
    () => document.querySelector('[data-builtin-skin] video').currentTime > 0.2,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-builtin-skin] video').paused);
  assert.equal(
    await page.locator('[data-builtin-skin]').getAttribute('data-task-state'),
    'success',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setTaskState('error');
  assert.equal(await page.locator('[data-builtin-skin]').getAttribute('data-task-state'), 'error');
  assert(await page.locator('[data-builtin-skin] video').evaluate((element) => element.paused));
  await setTaskState('idle');
  assert.equal(await page.locator('[data-builtin-skin]').getAttribute('data-task-state'), 'idle');
  checks.push(
    'real host results drive celebration/error; stop stays neutral and system motion reduction pauses video',
  );

  for (const [width, height] of [
    [1280, 900],
    [850, 525],
    [680, 420],
    [566, 350],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const skinId of ['deepseek', 'naiwa']) {
      await page.evaluate(
        async (id) =>
          (await import('/src/stores/appStore.ts')).useAppStore.getState().setSkinId(id),
        skinId,
      );
      const companion = page.locator('[data-builtin-skin]');
      await companion.scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const card = document.querySelector('[data-builtin-skin]').getBoundingClientRect();
        const action = [...document.querySelectorAll('[data-role="start-stop-button"]')]
          .find((element) => element.getBoundingClientRect().height > 0)
          .getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          overlap:
            Math.min(card.right, action.right) > Math.max(card.left, action.left) &&
            Math.min(card.bottom, action.bottom) > Math.max(card.top, action.top),
          clipped: card.left < 0 || card.right > innerWidth + 1,
        };
      });
      assert.deepEqual(
        geometry,
        { overflow: false, overlap: false, clipped: false },
        `${skinId} ${width}x${height}`,
      );
    }
    checks.push(`real task toolbar and companion remain separated at ${width}x${height}`);
  }
  if (output) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTaskState('success');
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(output, 'main-naiwa.png') });
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(
    JSON.stringify(
      {
        checks,
        browser: browser.version(),
        boundary:
          'Actual React App and settings in Chromium with a simulated backend; no native Tauri or real devices.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
