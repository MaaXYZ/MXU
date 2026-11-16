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
const sampleTasks = [
  { name: 'StartUp', label: '开始唤醒', description: '启动应用并进入主界面。' },
  { name: 'Award', label: '领取奖励', description: '收取每日登录与邮件奖励。' },
  { name: 'Fight', label: '日常行动', description: '按已保存的计划完成日常任务。' },
  { name: 'Recruit', label: '公开招募', description: '处理招募标签与已完成的招募。' },
  { name: 'Infrastructure', label: '基建换班', description: '安排生产与休息中的干员。' },
  { name: 'Mission', label: '领取任务奖励', description: '收取已完成任务的奖励。' },
].map((task) => ({ ...task, entry: task.name }));
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
          task: sampleTasks,
          resource: [{ name: 'daily', label: '日常资源', path: ['resource'] }],
          controller: [{ name: 'adb', label: 'Android', type: 'Adb' }],
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
  await page.waitForFunction(() => document.body.dataset.mxuSkin === 'deepseek');
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

  // Populate the real TaskItem, tabs and log components, rather than screenshotting an empty shell.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const instanceId = store.activeInstanceId;
    store.renameInstance(instanceId, '日常任务');
    store.setShowAddTaskPanel(false);
    store.updateInstance(instanceId, {
      selectedTasks: store.projectInterface.task.map((task, index) => ({
        id: `skin-fixture-task-${index}`,
        taskName: task.name,
        enabled: true,
        expanded: false,
        optionValues: {},
      })),
    });
    store.addLog(instanceId, { type: 'info', message: '配置已加载，等待开始任务。' });
    store.addLog(instanceId, { type: 'success', message: '资源加载完成。' });
    store.addLog(instanceId, { type: 'info', message: '任务将在当前配置中按顺序执行。' });
    const secondId = store.createInstance('活动安排', true);
    store.setActiveInstance(instanceId);
    store.updateInstance(secondId, { selectedTasks: [] });
    store.setShowAddTaskPanel(false);
  });
  await page.locator('[data-skin-slot="task-item"]').first().waitFor();
  assert.equal(await page.locator('[data-skin-slot="task-item"]').count(), sampleTasks.length);
  checks.push('visual fixtures render real task cards, multiple tabs and logs');

  const setAppearance = async (skinId, theme) => {
    await page.evaluate(
      async ({ id, mode }) => {
        const { useAppStore } = await import('/src/stores/appStore.ts');
        const store = useAppStore.getState();
        if (mode) store.setTheme(mode);
        store.setSkinId(id);
      },
      { id: skinId, mode: theme },
    );
    await page.waitForFunction((id) => document.body.dataset.mxuSkin === id, skinId);
  };
  const bodyTokens = () =>
    page.locator('body').evaluate((element) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(
        [
          '--color-bg-primary',
          '--color-bg-secondary',
          '--color-text-primary',
          '--color-border',
          '--color-accent',
        ].map((name) => [name, style.getPropertyValue(name).trim()]),
      );
    });
  const styles = {};
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const theme of ['light', 'dark']) {
    await setAppearance('default', theme);
    const standard = await bodyTokens();
    for (const skinId of ['deepseek', 'naiwa']) {
      await setAppearance(skinId, theme);
      styles[`${skinId}-${theme}`] = await bodyTokens();
      assert.notEqual(
        styles[`${skinId}-${theme}`]['--color-bg-primary'],
        standard['--color-bg-primary'],
      );
      assert.notEqual(styles[`${skinId}-${theme}`]['--color-border'], standard['--color-border']);
      assert.equal(
        styles[`${skinId}-${theme}`]['--color-accent'],
        standard['--color-accent'],
        'skin preserves the explicit accent',
      );
      for (const slot of [
        'tabs',
        'workspace',
        'task-panel',
        'task-list',
        'toolbar',
        'sidebar',
        'connection',
        'screenshot',
        'logs',
      ]) {
        assert(await page.locator(`[data-skin-slot="${slot}"]`).count(), `missing ${slot} anchor`);
      }
      const ambient = page.locator('[data-skin-ambient]');
      assert(await ambient.count(), 'the complete shell includes a decorative scene');
      assert(
        await ambient.evaluateAll((elements) =>
          elements.every((element) => getComputedStyle(element).pointerEvents === 'none'),
        ),
      );
      // The real context menu is rendered into document.body, outside the app shell.
      await page.locator('[data-skin-slot="task-item"]').first().click({ button: 'right' });
      const menu = page.locator('body > div[class*="min-w-[180px]"]');
      await menu.waitFor();
      assert.equal(
        await menu.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--color-bg-secondary').trim(),
        ),
        styles[`${skinId}-${theme}`]['--color-bg-secondary'],
      );
      await page.locator('[data-builtin-skin] h2').click();
      await menu.waitFor({ state: 'detached' });
      if (output) {
        await page.screenshot({
          path: path.join(output, `main-${skinId}-${theme}.png`),
          animations: 'disabled',
        });
      }
    }
    assert.notEqual(
      styles[`deepseek-${theme}`]['--color-bg-primary'],
      styles[`naiwa-${theme}`]['--color-bg-primary'],
    );
    await setAppearance('default', theme);
    assert.deepEqual(await bodyTokens(), standard, 'default skin completely restores host palette');
    assert.equal(await page.locator('[data-builtin-skin]').count(), 0);
  }
  checks.push(
    'both skins transform the whole app in light/dark, include scene layers, preserve accent and style body portals; default restores every sampled token',
  );

  const assertAmbientStopped = async () => {
    assert(
      await page
        .locator('[data-skin-ambient]')
        .evaluateAll((elements) =>
          elements.every((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState !== 'running'),
          ),
        ),
      'ambient animation must stop with motion reduction or a hidden page',
    );
  };
  await setTaskState('running');
  for (const skinId of ['deepseek', 'naiwa']) {
    await setAppearance(skinId, 'dark');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'reduced');
    await assertAmbientStopped();
    assert(await page.locator('[data-builtin-skin] video').evaluate((element) => element.paused));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');
    assert(
      await page
        .locator('[data-skin-ambient]')
        .evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === 'running'),
        ),
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'paused');
    await assertAmbientStopped();
    assert(await page.locator('[data-builtin-skin] video').evaluate((element) => element.paused));
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');
  }
  checks.push(
    'system motion reduction and hidden pages stop both scene animation and character video in both skins',
  );

  for (const [width, height] of [
    [1280, 900],
    [850, 525],
    [800, 900],
    [768, 900],
    [680, 420],
    [566, 350],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const skinId of ['deepseek', 'naiwa']) {
      await setAppearance(skinId, 'dark');
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
          panelsClipped: [
            ...document.querySelectorAll('[data-skin-slot=sidebar], [data-skin-slot=screenshot]'),
          ].some((element) => {
            const box = element.getBoundingClientRect();
            return box.left < 0 || box.right > innerWidth + 1;
          }),
        };
      });
      assert.deepEqual(
        geometry,
        { overflow: false, overlap: false, clipped: false, panelsClipped: false },
        `${skinId} ${width}x${height}`,
      );
      for (const control of [
        page.locator('[data-role="start-stop-button"]').filter({ visible: true }),
        page.locator('.builtin-skin__interact'),
      ]) {
        await control.scrollIntoViewIfNeeded();
        assert(
          await control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const target = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return element === target || element.contains(target);
          }),
          `${skinId} ${width}x${height}: protected control is covered`,
        );
        await control.focus();
        assert(
          await control.evaluate((element) => document.activeElement === element),
          'real controls remain keyboard focusable',
        );
      }
      if (width >= 768) {
        await page.evaluate(async () =>
          (await import('/src/stores/appStore.ts')).useAppStore
            .getState()
            .setShowAddTaskPanel(true),
        );
        await page.waitForFunction(() => {
          const panel = document.querySelector('[data-skin-slot="task-panel"]');
          const hero = document.querySelector('[data-builtin-skin]').getBoundingClientRect();
          const action = panel
            .querySelector('[data-role="start-stop-button"]')
            .getBoundingClientRect();
          const list = panel.querySelector('[data-skin-slot="task-list"]').getBoundingClientRect();
          const tabs = document.querySelector('[data-skin-slot="tabs"]').getBoundingClientRect();
          return hero.top >= tabs.bottom && action.bottom <= innerHeight && list.height >= 44;
        });
        await page.evaluate(async () =>
          (await import('/src/stores/appStore.ts')).useAppStore
            .getState()
            .setShowAddTaskPanel(false),
        );
      }
      if (output && (width === 850 || width === 390)) {
        await page.screenshot({
          path: path.join(output, `main-${skinId}-${width}x${height}.png`),
          animations: 'disabled',
        });
      }
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
