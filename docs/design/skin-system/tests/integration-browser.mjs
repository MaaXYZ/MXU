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
  // The mock owns the latest saved config and the runtime facts used by the motion fixture.
  let backendConfigSnapshot = null;
  let backendTaskInstances = {};
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
      body = backendConfigSnapshot ?? {
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
      backendConfigSnapshot = {
        revision: 'fixture-2',
        config: route.request().postDataJSON().config,
      };
      body = backendConfigSnapshot;
    } else if (url.pathname === '/api/maa/state') {
      body = {
        instances: backendTaskInstances,
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
  assert.equal(await page.locator('.scene-status').getAttribute('data-task-state'), 'running');
  checks.push(
    'switching/default removal leaves the running task and existing theme intact; preview remains independent',
  );
  await setTaskState('success');
  await page.waitForFunction(
    () => document.querySelector('[data-builtin-skin] video').currentTime > 0.2,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-builtin-skin] video').paused);
  assert.equal(await page.locator('.scene-status').getAttribute('data-task-state'), 'success');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setTaskState('error');
  assert.equal(await page.locator('.scene-status').getAttribute('data-task-state'), 'error');
  assert(await page.locator('[data-builtin-skin] video').evaluate((element) => element.paused));
  await setTaskState('idle');
  assert.equal(await page.locator('.scene-status').getAttribute('data-task-state'), 'idle');
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
  const layoutRects = {};
  const sceneRectangles = () =>
    page.evaluate(() => {
      const selectors = {
        navigation: '.scene-navigation',
        companion: '.scene-companion',
        instruments: '.scene-instruments',
        logbook: '.scene-logbook',
      };
      return Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return [name, { x, y, width, height }];
        }),
      );
    });
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
      await page.locator('.scene-heading h1').click();
      await menu.waitFor({ state: 'detached' });
      assert.equal(
        await page.locator('.scene-workspace').getAttribute('data-scene-layout'),
        skinId,
      );
      assert.equal(
        await page
          .locator('.scene-workspace .builtin-skin__copy, .scene-workspace .builtin-skin__scenery')
          .count(),
        0,
        'the extra hero card has been removed',
      );
      const direction = await page
        .locator('[data-skin-slot="tabs-list"]')
        .evaluate((element) => getComputedStyle(element).flexDirection);
      assert.equal(
        direction,
        skinId === 'deepseek' ? 'column' : 'row',
        'instance navigation changes orientation with the scene',
      );
      layoutRects[`${skinId}-${theme}`] = await sceneRectangles();
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
    const movedRegions = Object.keys(layoutRects[`deepseek-${theme}`]).filter((name) => {
      const ocean = layoutRects[`deepseek-${theme}`][name];
      const pond = layoutRects[`naiwa-${theme}`][name];
      const dx = Math.abs(ocean.x + ocean.width / 2 - pond.x - pond.width / 2);
      const dy = Math.abs(ocean.y + ocean.height / 2 - pond.y - pond.height / 2);
      return Math.max(dx, dy) >= 40;
    });
    assert(
      movedRegions.length >= 3,
      `scenes must change composition, not only colour/radius: moved ${movedRegions.join(', ')}`,
    );
    await setAppearance('default', theme);
    assert.equal(
      await page.locator('.scene-workspace').count(),
      0,
      'default restores the standard layout',
    );
    assert.equal(
      await page
        .locator('[data-skin-slot="tabs-list"]')
        .evaluate((element) => getComputedStyle(element).flexDirection),
      'row',
    );
    assert.deepEqual(await bodyTokens(), standard, 'default skin completely restores host palette');
    assert.equal(await page.locator('[data-builtin-skin]').count(), 0);
  }
  checks.push(
    'both skins transform the whole app in light/dark, include scene layers, preserve accent and style body portals; default restores every sampled token',
  );

  // Changing a scene rearranges the same live business components.
  await setAppearance('deepseek', 'dark');
  await page.evaluate(() => {
    window.__skinBusinessNodes = Object.fromEntries(
      ['task-list', 'toolbar', 'screenshot'].map((slot) => [
        slot,
        document.querySelector(`[data-skin-slot="${slot}"]`),
      ]),
    );
  });
  await setAppearance('naiwa', 'dark');
  assert(
    await page.evaluate(() =>
      Object.entries(window.__skinBusinessNodes).every(
        ([slot, element]) => element === document.querySelector(`[data-skin-slot="${slot}"]`),
      ),
    ),
    'scene switching must preserve task, toolbar and screenshot component identity',
  );
  await page.evaluate(() => {
    delete window.__skinBusinessNodes;
  });
  checks.push(
    'scene switching preserves the live task list, task toolbar and screenshot DOM nodes',
  );

  // Exercise the vertical tab hit-testing, not just its CSS orientation.
  await setAppearance('deepseek', 'light');
  const instanceOrder = await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore
      .getState()
      .instances.map((instance) => instance.id),
  );
  const activeBeforeReorder = await page.evaluate(
    async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().activeInstanceId,
  );
  const tabs = page.locator('[data-skin-slot="tab"]');
  const drag = await tabs.first().locator('.drag-handle').boundingBox();
  const targetTab = await tabs.nth(1).boundingBox();
  assert(drag && targetTab);
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetTab.x + targetTab.width / 2, targetTab.y + targetTab.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const reorderedIds = [instanceOrder[1], instanceOrder[0], ...instanceOrder.slice(2)];
  await page.waitForFunction(async (expected) => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    return (
      JSON.stringify(useAppStore.getState().instances.map((instance) => instance.id)) ===
      JSON.stringify(expected)
    );
  }, reorderedIds);
  await page.evaluate(
    async ({ id }) => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      useAppStore.getState().reorderInstances(1, 0);
      useAppStore.getState().setActiveInstance(id);
    },
    { id: activeBeforeReorder },
  );
  checks.push('vertical instance navigation reorders tabs using their actual vertical hit regions');

  // Native task controls keep operating through the radically different presentation.
  for (const skinId of ['deepseek', 'naiwa']) {
    await setAppearance(skinId, 'light');
    await setTaskState('idle');
    const firstTask = page.locator('[data-skin-slot="task-item"]').first();
    await firstTask.getByTitle('单击选中/取消', { exact: true }).click();
    assert.equal(
      await page.evaluate(
        async () =>
          (await import('/src/stores/appStore.ts')).useAppStore.getState().getActiveInstance()
            .selectedTasks[0].enabled,
      ),
      false,
    );
    await firstTask.getByTitle('单击选中/取消', { exact: true }).click();
    await firstTask.getByTitle('展开选项', { exact: true }).click();
    assert.equal(await firstTask.getAttribute('data-expanded'), 'true');
    await firstTask.getByTitle('折叠选项', { exact: true }).click();
    assert.equal(await firstTask.getAttribute('data-expanded'), 'false');
    const beforeMove = await page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore
        .getState()
        .getActiveInstance()
        .selectedTasks.map((task) => task.id),
    );
    await firstTask.click({ button: 'right' });
    await page.getByRole('button', { name: '下移', exact: true }).click();
    assert.deepEqual(
      await page.evaluate(async () =>
        (await import('/src/stores/appStore.ts')).useAppStore
          .getState()
          .getActiveInstance()
          .selectedTasks.map((task) => task.id),
      ),
      [beforeMove[1], beforeMove[0], ...beforeMove.slice(2)],
    );
    await page.locator('[data-skin-slot="task-item"]').nth(1).click({ button: 'right' });
    await page.getByRole('button', { name: '上移', exact: true }).click();
    assert.deepEqual(
      await page.evaluate(async () =>
        (await import('/src/stores/appStore.ts')).useAppStore
          .getState()
          .getActiveInstance()
          .selectedTasks.map((task) => task.id),
      ),
      beforeMove,
    );
  }
  checks.push(
    'both scene layouts retain task enable, option expansion and context-menu reordering',
  );

  // A zigzag route is still a sequential list: moving to the next pad must not skip it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await setAppearance('naiwa', 'light');
  await setTaskState('idle');
  const beforePointerDrag = await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore
      .getState()
      .getActiveInstance()
      .selectedTasks.map((task) => task.id),
  );
  const routeItems = page.locator('[data-skin-slot="task-item"]');
  const routeHandle = await routeItems
    .first()
    .locator('[aria-roledescription="sortable"]')
    .boundingBox();
  const nextPad = await routeItems
    .nth(1)
    .locator('[data-skin-slot="task-item-head"]')
    .boundingBox();
  assert(routeHandle && nextPad, 'native sortable handles and the next lily pad must be visible');
  await page.mouse.move(
    routeHandle.x + routeHandle.width / 2,
    routeHandle.y + routeHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(nextPad.x + nextPad.width / 2, nextPad.y + nextPad.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  const afterPointerDrag = [
    beforePointerDrag[1],
    beforePointerDrag[0],
    ...beforePointerDrag.slice(2),
  ];
  await page.waitForFunction(async (expected) => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    return (
      JSON.stringify(
        useAppStore
          .getState()
          .getActiveInstance()
          .selectedTasks.map((task) => task.id),
      ) === JSON.stringify(expected)
    );
  }, afterPointerDrag);
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    store.reorderTasks(store.activeInstanceId, 1, 0);
  });
  assert.deepEqual(
    await page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore
        .getState()
        .getActiveInstance()
        .selectedTasks.map((task) => task.id),
    ),
    beforePointerDrag,
  );
  checks.push(
    'native pointer drag from the first zigzag lily pad to the second swaps adjacent tasks without skipping a pad',
  );

  const keyboardHandle = page
    .locator('[data-skin-slot="task-item"]')
    .first()
    .locator('[aria-roledescription="sortable"]');
  await keyboardHandle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.waitForFunction(async (expected) => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    return (
      JSON.stringify(
        useAppStore
          .getState()
          .getActiveInstance()
          .selectedTasks.map((task) => task.id),
      ) === JSON.stringify(expected)
    );
  }, afterPointerDrag);
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    store.reorderTasks(store.activeInstanceId, 1, 0);
  });
  checks.push(
    'keyboard Space/ArrowDown/Space moves the adjacent winding-route task without a horizontal jump',
  );

  // The log header owns the real instrument-collapse state in both scenes.
  for (const skinId of ['deepseek', 'naiwa']) {
    await setAppearance(skinId, 'light');
    const logHeader = page.locator('.scene-logbook [data-skin-slot="logs"] > [role="button"]');
    if (
      (await page.locator('.scene-workspace').getAttribute('data-instruments-expanded')) === 'false'
    ) {
      await logHeader.click({ position: { x: 20, y: 15 } });
    }
    const beforeWidth = await page
      .locator('.scene-tasks')
      .evaluate((element) => element.getBoundingClientRect().width);
    await logHeader.click({ position: { x: 20, y: 15 } });
    await page.waitForFunction(() => {
      const scene = document.querySelector('.scene-workspace');
      const instruments = scene.querySelector('.scene-instruments');
      const style = getComputedStyle(instruments);
      return (
        scene.dataset.instrumentsExpanded === 'false' &&
        style.visibility === 'hidden' &&
        style.pointerEvents === 'none'
      );
    });
    if (skinId === 'deepseek') {
      assert(
        await page
          .locator('.scene-tasks')
          .evaluate(
            (element, width) => element.getBoundingClientRect().width > width + 10,
            beforeWidth,
          ),
        'collapsing the ocean instruments gives the live task route more room',
      );
    }
    await logHeader.click({ position: { x: 20, y: 15 } });
    await page.waitForFunction(() => {
      const scene = document.querySelector('.scene-workspace');
      const instruments = scene.querySelector('.scene-instruments');
      return (
        scene.dataset.instrumentsExpanded === 'true' &&
        getComputedStyle(instruments).visibility === 'visible' &&
        instruments.getBoundingClientRect().width > 0
      );
    });
  }
  checks.push(
    'native log header hides and restores instruments in both scenes; the ocean route expands into the released space',
  );

  // Controlled backend cache fixture: these are host facts, never inferred from decoration.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const instance = store.getActiveInstance();
    useAppStore.setState({
      instanceTaskRunStatus: {
        ...store.instanceTaskRunStatus,
        [instance.id]: {
          [instance.selectedTasks[0].id]: 'succeeded',
          [instance.selectedTasks[1].id]: 'running',
        },
      },
    });
  });
  const taskFacts = await page.evaluate(async () =>
    JSON.stringify(
      (await import('/src/stores/appStore.ts')).useAppStore.getState().instanceTaskRunStatus,
    ),
  );
  const sceneAnimations = () =>
    page.locator('.scene-workspace').evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => /^(bridge-|pond-|scene-)/.test(animation.animationName ?? ''))
        .map((animation) => ({ name: animation.animationName, state: animation.playState })),
    );
  const assertSceneStopped = async () => {
    assert(
      (await sceneAnimations()).every((animation) => animation.state !== 'running'),
      'visible scene animations must stop with motion reduction or a hidden page',
    );
    assert(
      await page.locator('[data-builtin-skin] video').evaluate((element) => element.paused),
      'character video also pauses',
    );
  };
  const assertTaskFacts = async () => {
    assert.equal(
      await page.locator('[data-skin-slot="task-item"]').nth(0).getAttribute('data-task-status'),
      'succeeded',
    );
    assert.equal(
      await page.locator('[data-skin-slot="task-item"]').nth(1).getAttribute('data-task-status'),
      'running',
    );
    assert.equal(
      await page
        .locator('[data-skin-slot="task-item"]')
        .nth(0)
        .locator('.skin-task-marker')
        .textContent(),
      '01',
    );
    assert.equal(
      await page
        .locator('[data-skin-slot="task-item"]')
        .nth(1)
        .locator('.skin-task-marker')
        .textContent(),
      '02',
    );
    assert.equal(
      await page.evaluate(async () =>
        JSON.stringify(
          (await import('/src/stores/appStore.ts')).useAppStore.getState().instanceTaskRunStatus,
        ),
      ),
      taskFacts,
      'motion policy and interaction do not rewrite task facts',
    );
  };
  await setTaskState('running');
  // App legitimately refreshes host runtime facts on foreground recovery. Return the
  // same controlled backend facts through the real snake_case HTTP contract, rather
  // than erasing them with the startup-only empty /maa/state response.
  backendTaskInstances = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const instance = store.getActiveInstance();
    return {
      [instance.id]: {
        connected: store.instanceConnectionStatus[instance.id] === 'Connected',
        resource_loaded: !!store.instanceResourceLoaded[instance.id],
        tasker_inited: false,
        is_running: instance.isRunning,
        task_run_state: {
          statuses: store.instanceTaskRunStatus[instance.id],
          mappings: store.maaTaskIdMapping[instance.id] ?? {},
          pending_task_ids: store.instancePendingTaskIds[instance.id] ?? [],
          current_task_index: store.instanceCurrentTaskIndex[instance.id] ?? 0,
          overall_status: store.instanceTaskStatus[instance.id] ?? null,
        },
      },
    };
  });
  for (const skinId of ['deepseek', 'naiwa']) {
    await setAppearance(skinId, 'dark');
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');
    await assertTaskFacts();
    const activeAnimations = await sceneAnimations();
    const expectedNames =
      skinId === 'deepseek'
        ? ['bridge-sonar-rotation', 'bridge-route-ping', 'scene-life-swim']
        : ['pond-status-pulse', 'scene-water-breathe'];
    for (const name of expectedNames) {
      assert(
        activeAnimations.some(
          (animation) => animation.name === name && animation.state === 'running',
        ),
        `${skinId}: actual scene must run ${name}`,
      );
    }
    const markerAnimation = await page
      .locator('[data-task-status="running"] .skin-task-marker')
      .evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some(
            (animation) =>
              animation.animationName === 'bridge-route-ping' && animation.playState === 'running',
          ),
      );
    assert.equal(
      markerAnimation,
      skinId === 'deepseek',
      'only the running ocean route marker receives its sonar pulse',
    );
    await page.locator('.builtin-skin__interact').click();
    await page.waitForFunction(() =>
      document
        .querySelector('.scene-workspace')
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation.animationName === 'scene-wide-echo' && animation.playState === 'running',
        ),
    );
    if (skinId === 'naiwa') {
      assert(
        (await sceneAnimations()).some(
          (animation) => animation.name === 'pond-water-response' && animation.state === 'running',
        ),
      );
    }
    await assertTaskFacts();
    if (output) {
      await page.waitForFunction(() => {
        const clip = document.querySelector('[data-builtin-skin] video');
        return clip && !clip.paused && clip.currentTime > 0.2;
      });
      await page.screenshot({ path: path.join(output, `scene-${skinId}-running.png`) });
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'reduced');
    await assertSceneStopped();
    await assertTaskFacts();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');

    // The actual application setting must suppress scene animation after returning to tasks.
    await page.getByTitle('设置', { exact: true }).click();
    await page.getByRole('checkbox', { name: '减少皮肤动效', exact: true }).check();
    await page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore.getState().setCurrentPage('main'),
    );
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'reduced');
    await assertSceneStopped();
    await assertTaskFacts();
    assert.equal(await page.locator('.scene-status').getAttribute('data-task-state'), 'running');
    await page.getByTitle('设置', { exact: true }).click();
    await page.getByRole('checkbox', { name: '减少皮肤动效', exact: true }).uncheck();
    await page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore.getState().setCurrentPage('main'),
    );
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');
    assert(
      (await sceneAnimations()).some((animation) => animation.state === 'running'),
      'turning application reduction off restores scene motion',
    );

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'paused');
    await assertSceneStopped();
    await assertTaskFacts();
    await page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'full');
    await assertTaskFacts();
  }
  backendTaskInstances = {};
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const statuses = { ...store.instanceTaskRunStatus };
    delete statuses[store.activeInstanceId];
    useAppStore.setState({ instanceTaskRunStatus: statuses });
  });
  checks.push(
    'host per-task facts drive route markers and real scene animations; interaction, system/app motion reduction and hidden pages preserve facts while stopping scene and video motion',
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
        const actor = document.querySelector('[data-builtin-skin]').getBoundingClientRect();
        const action = [...document.querySelectorAll('[data-role="start-stop-button"]')]
          .find((element) => element.getBoundingClientRect().height > 0)
          .getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          overlap:
            Math.min(actor.right, action.right) > Math.max(actor.left, action.left) &&
            Math.min(actor.bottom, action.bottom) > Math.max(actor.top, action.top),
          clipped: actor.left < 0 || actor.right > innerWidth + 1,
          panelsClipped: [
            ...document.querySelectorAll(
              '.scene-navigation, .scene-tasks, .scene-instruments, .scene-logbook, [data-skin-slot="screenshot"]',
            ),
          ].some((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < 0 || box.right > innerWidth + 1);
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
        page.locator('.scene-monitor [data-skin-slot="screenshot"] > [role="button"]'),
        page.locator('.scene-devices [data-skin-slot="connection"] > button').first(),
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
          const action = [...document.querySelectorAll('[data-role="start-stop-button"]')]
            .find((element) => element.getBoundingClientRect().height > 0)
            .getBoundingClientRect();
          const list = document.querySelector('[data-skin-slot="task-list"]');
          const listBox = list.getBoundingClientRect();
          const style = getComputedStyle(list);
          return (
            action.top >= 0 &&
            action.bottom <= innerHeight &&
            listBox.height >= 44 &&
            ['auto', 'scroll'].includes(style.overflowY)
          );
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
    checks.push(
      `scene controls, character and panel boundaries remain usable at ${width}x${height}`,
    );
  }
  // Native anchored popovers must fit both the ocean rail and the narrow mobile bar.
  await page.setViewportSize({ width: 850, height: 525 });
  const priorPopoverState = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const previous = {
      updateInfo: store.updateInfo,
      recentlyClosed: store.recentlyClosed,
      showUpdateDialog: store.showUpdateDialog,
    };
    useAppStore.setState({
      recentlyClosed: [
        { id: 'skin-closed-fixture', name: '已关闭的示例', closedAt: Date.now(), tasks: [] },
      ],
    });
    store.setUpdateInfo({
      hasUpdate: true,
      versionName: '0.0.1-preview',
      releaseNote: '受控界面预览，无可下载文件。',
    });
    return previous;
  });
  // The host announces an update automatically. Close that first announcement,
  // then open each popup through its real button below without downloading anything.
  const updatePopover = page.locator('[data-skin-slot="update-popover"]');
  await updatePopover.waitFor();
  await page.mouse.click(2, 2);
  await updatePopover.waitFor({ state: 'detached' });
  for (const [width, height] of [
    [850, 525],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const skinId of ['deepseek', 'naiwa']) {
      await setAppearance(skinId, 'light');
      for (const [title, slot] of [
        ['发现新版本', 'update-popover'],
        ['最近关闭', 'recently-closed-popover'],
      ]) {
        const popup = page.locator(`[data-skin-slot="${slot}"]`);
        await page.getByTitle(title, { exact: true }).click();
        await popup.waitFor();
        assert(
          await popup.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.height > 0 &&
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth + 1 &&
              box.bottom <= innerHeight + 1
            );
          }),
          `${skinId} ${width}x${height}: ${slot} must remain entirely inside the viewport`,
        );
        await page.mouse.click(2, 2);
        await popup.waitFor({ state: 'detached' });
      }
    }
  }
  await page.evaluate(async (previous) => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.setState(previous);
  }, priorPopoverState);
  checks.push(
    'native update and recently-closed popovers open, fit and dismiss from both scene navigations at 850x525 and 390x844 without downloading or reopening',
  );

  if (output) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTaskState('success');
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(output, 'main-naiwa.png') });
  }
  for (const language of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    await page.evaluate(
      async (language) =>
        (await import('/src/stores/appStore.ts')).useAppStore.getState().setLanguage(language),
      language,
    );
    for (const [width, height] of [
      [768, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      for (const skinId of ['deepseek', 'naiwa']) {
        await setAppearance(skinId, 'light');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const action = page.locator('[data-role="start-stop-button"]').filter({ visible: true });
        await action.scrollIntoViewIfNeeded();
        assert(
          await action.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth + 1;
          }),
          `${skinId} ${language} ${width}: action clips`,
        );
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${skinId} ${language} ${width}: horizontal overflow`,
        );
      }
    }
  }
  await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore.getState().setLanguage('zh-CN'),
  );
  checks.push(
    'all five languages keep task actions inside the viewport in both scenes at 768px and 390px',
  );
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
