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
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});
let browser;
const checks = [];
const screenshotFrame = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
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
  // The mock owns the latest saved config and active runtime facts.
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
    } else if (/^\/api\/maa\/instances\/[^/]+\/screenshot$/.test(url.pathname)) {
      body = { dataUrl: screenshotFrame };
    } else if (url.pathname === '/api/focus/pending') body = [];
    await route.fulfill({ json: body });
  });
  const base = server.resolvedUrls.local[0];
  const slot = (name) => page.locator(`[data-skin-slot="${name}"]`);
  const shell = page.locator('.skin-shell');
  const preview = page.locator('[data-companion-view="preview"]');
  const video = preview.locator('video');
  const reducedMotion = page.getByRole('checkbox', { name: '减少皮肤动效', exact: true });
  const skins = [
    { id: 'deepseek', name: '蓝色大肥鱼', action: '投喂白饭' },
    { id: 'naiwa', name: '奶蛙', action: '播放大笑' },
    { id: 'gugugaga', name: '咕咕嘎嘎' },
  ];
  const waitForSkin = (id) =>
    page.waitForFunction((skin) => document.body.dataset.mxuSkin === skin, id);
  const waitForTaskState = (state) =>
    page.waitForFunction(
      (expected) => document.querySelector('.skin-shell')?.dataset.taskState === expected,
      state,
    );
  const openSettings = () => page.getByTitle('设置', { exact: true }).click();
  const showMain = () =>
    page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore.getState().setCurrentPage('main'),
    );

  await page.goto(base);
  await slot('workspace').waitFor();
  await waitForSkin('deepseek');
  assert(await page.locator('html').evaluate((element) => element.classList.contains('dark')));
  assert.equal(await preview.count(), 0);
  checks.push('startup restores skin and theme on the standard task page with no saved instances');

  await openSettings();
  for (const { id, name, action } of skins) {
    const choice = page.getByRole('button', { name, exact: true });
    await choice.click();
    await preview.locator('img').first().waitFor();
    assert.equal(await choice.getAttribute('aria-pressed'), 'true');
    assert.equal(await preview.getAttribute('data-builtin-skin'), id);
    if (!action) continue;

    await page.getByRole('button', { name: action, exact: true }).click();
    await page
      .waitForFunction(
        () => document.querySelector('[data-builtin-skin] video')?.currentTime > 0.2,
        undefined,
        { timeout: 5_000 },
      )
      .catch(async (error) => {
        const playback = await video.evaluate((element) => ({
          currentTime: element.currentTime,
          readyState: element.readyState,
          paused: element.paused,
          error: element.error?.message,
        }));
        throw new Error(`${id}: preview video did not play (${JSON.stringify(playback)})`, {
          cause: error,
        });
      });
    assert(await video.evaluate((element) => element.muted && !element.paused));
    if (id === 'deepseek') {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => document.querySelector('[data-builtin-skin] video').paused);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    } else {
      await reducedMotion.check();
      await page.waitForFunction(() => document.querySelector('[data-builtin-skin] video').paused);
      await reducedMotion.uncheck();
    }
  }
  await page.getByRole('button', { name: '默认', exact: true }).click();
  await preview.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '奶蛙', exact: true }).click();
  await waitForSkin('naiwa');
  if (output) {
    await page.locator('#settings-skin-label').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'settings-skins.png') });
  }
  checks.push('the appearance picker preserves the silent skin previews and motion controls');

  await page.reload();
  await slot('workspace').waitFor();
  await waitForSkin('naiwa');
  assert(await page.locator('html').evaluate((element) => element.classList.contains('dark')));
  assert.deepEqual(
    await page.evaluate(() => {
      const { theme, language, accentColor, skinId } = JSON.parse(
        localStorage.getItem('mxu-webui-appearance'),
      );
      return { theme, language, accentColor, skinId };
    }),
    { theme: 'dark', language: 'zh-CN', accentColor: 'deepsea', skinId: 'naiwa' },
  );
  checks.push('WebUI selection persists after reload along with the theme, accent and language');

  const setTaskState = async (mode) => {
    const statuses = { idle: null, running: 'Running', success: 'Succeeded', error: 'Failed' };
    await page.evaluate(
      async ({ state, status }) => {
        const { useAppStore } = await import('/src/stores/appStore.ts');
        const store = useAppStore.getState();
        store.updateInstance(store.activeInstanceId, { isRunning: state === 'running' });
        store.setInstanceTaskStatus(store.activeInstanceId, status);
      },
      { state: mode, status: statuses[mode] },
    );
    await waitForTaskState(mode);
  };
  await setTaskState('running');
  await openSettings();
  assert.equal(await preview.getAttribute('data-task-state'), 'idle');
  await showMain();
  for (const state of ['success', 'error', 'idle']) await setTaskState(state);
  checks.push('task feedback follows host state while the settings preview stays independent');

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
  const toolbarLabels = slot('toolbar-label').filter({ visible: true });
  const companionTrigger = slot('companion-trigger');
  const companionPanel = slot('companion-panel');
  const desktopSlots = [
    'tabs',
    'workspace',
    'task-panel',
    'task-list',
    'toolbar',
    'sidebar',
    'connection',
    'screenshot',
    'logs',
  ];
  const layout = (names) =>
    page.evaluate(
      (slots) =>
        Object.fromEntries(
          slots.map((name) => {
            const element = document.querySelector(`[data-skin-slot="${name}"]`);
            const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
            return [name, { x, y, width, height, right, bottom }];
          }),
        ),
      names,
    );
  const assertDesktopLayout = async (baseline, skinId) => {
    const current = await layout(desktopSlots);
    const { tabs, workspace, toolbar, sidebar, connection, screenshot, logs } = current;
    assert(tabs.bottom <= workspace.y + 1, `${skinId}: tabs are above the workspace`);
    assert(toolbar.right <= sidebar.x + 1, `${skinId}: toolbar is in the left task column`);
    assert(
      connection.bottom <= screenshot.y + 1 && screenshot.bottom <= logs.y + 1,
      `${skinId}: connection, screenshot and logs are stacked in the sidebar`,
    );
    assert.equal(
      await slot('tabs-list').evaluate((element) => getComputedStyle(element).flexDirection),
      'row',
    );
    for (const name of desktopSlots) {
      assert(current[name].width > 0 && current[name].height > 0, `${skinId}: ${name} is visible`);
      for (const edge of ['x', 'y', 'right', 'bottom']) {
        assert(
          Math.abs(current[name][edge] - baseline[name][edge]) <= 32,
          `${skinId}: ${name} ${edge} stays near its default layout position`,
        );
      }
    }
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await setAppearance('default', 'light');
  const liveNodes = await page.evaluateHandle(
    (names) => names.map((name) => document.querySelector(`[data-skin-slot="${name}"]`)),
    desktopSlots,
  );
  if (output) {
    await page
      .getByRole('link', { name: '提交 Issue', exact: true })
      .locator('xpath=../..')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  }
  for (const theme of ['light', 'dark']) {
    await setAppearance('default', theme);
    const standard = await bodyTokens();
    const baseline = await layout(desktopSlots);
    const backgrounds = new Set();
    for (const { id } of skins) {
      await setAppearance(id, theme);
      const tokens = await bodyTokens();
      backgrounds.add(tokens['--color-bg-primary']);
      assert.notEqual(tokens['--color-bg-primary'], standard['--color-bg-primary']);
      assert.notEqual(tokens['--color-border'], standard['--color-border']);
      assert.equal(tokens['--color-accent'], standard['--color-accent']);
      await assertDesktopLayout(baseline, id);
      const hasWorkspaceCompanion = id === 'deepseek' || id === 'naiwa';
      assert.equal(await companionTrigger.count(), hasWorkspaceCompanion ? 1 : 0);
      if (hasWorkspaceCompanion) {
        assert.equal(await toolbarLabels.count(), 3, `${id}: wide toolbar shows action labels`);
      }
      assert(
        await liveNodes.evaluate(
          (nodes, names) =>
            nodes.every(
              (node, index) =>
                node === document.querySelector(`[data-skin-slot="${names[index]}"]`),
            ),
          desktopSlots,
        ),
        `${id}: switching skins preserves the mounted workspace and its controls`,
      );
      const ambient = page.locator('[data-skin-ambient]');
      assert.equal(await ambient.getAttribute('aria-hidden'), 'true');
      assert.equal(
        await ambient.evaluate((element) => getComputedStyle(element).pointerEvents),
        'none',
      );

      // Portals outside the app shell inherit the skin palette.
      await slot('task-item').first().click({ button: 'right' });
      const menu = page.locator('body > div[class*="min-w-[180px]"]');
      await menu.waitFor();
      assert.equal(
        await menu.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--color-bg-secondary').trim(),
        ),
        tokens['--color-bg-secondary'],
      );
      await page.mouse.click(2, 2);
      await menu.waitFor({ state: 'detached' });
      if (output) {
        await page.screenshot({
          path: path.join(output, `main-${id}-${theme}.png`),
          animations: 'disabled',
        });
      }
    }
    assert.equal(backgrounds.size, skins.length);
    await setAppearance('default', theme);
    assert.deepEqual(await bodyTokens(), standard, 'default restores the host palette');
    assert.equal(await page.locator('[data-skin-ambient]').count(), 0);
    assert.equal(await companionTrigger.count(), 0);
  }
  await liveNodes.dispose();
  checks.push(
    'all skins preserve desktop component placement and identity, style portals and retain the user accent in light and dark modes',
  );

  for (const { id, action } of skins.slice(0, 2)) {
    await setAppearance(id, id === 'deepseek' ? 'dark' : 'light');
    const baseline = await layout(desktopSlots);
    await companionTrigger.press('Enter');
    await companionPanel.waitFor();
    assert.equal(await companionTrigger.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(
      await layout(desktopSlots),
      baseline,
      'opening a companion keeps panel bounds',
    );
    const scene = companionPanel.locator('[data-companion-view="workspace"]');
    await setTaskState('running');
    assert.equal(await scene.getAttribute('data-task-state'), 'running');
    await setTaskState('idle');
    const interact = scene.getByRole('button', { name: action, exact: true });
    await interact.press('Enter');
    await page.waitForFunction(() => {
      const clip = document.querySelector('[data-skin-slot="companion-panel"] video');
      return clip?.muted && !clip.paused && clip.currentTime > 0.2;
    });
    assert.equal(await interact.getAttribute('aria-pressed'), 'true');
    if (output) {
      await page.screenshot({ path: path.join(output, `main-${id}-companion.png`) });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(
      () => document.querySelector('[data-skin-slot="companion-panel"] video')?.paused,
    );
    await page.keyboard.press('Escape');
    await companionPanel.waitFor({ state: 'detached' });
    assert(await companionTrigger.evaluate((element) => document.activeElement === element));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  await setAppearance('default', 'light');
  assert.equal(await companionTrigger.count(), 0);
  checks.push(
    'the toolbar companion plays silently, respects motion reduction and closes without reflow',
  );

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
  checks.push('horizontal instance navigation retains drag reordering with a skin applied');

  // Native task controls work through the same interface in both refreshed skins.
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
    'both refreshed skins retain task enable, option expansion and context-menu reordering',
  );

  // Pointer and keyboard sorting use the native adjacent task hit regions.
  await page.setViewportSize({ width: 1280, height: 900 });
  await setAppearance('naiwa', 'light');
  await setTaskState('idle');
  const beforePointerDrag = await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore
      .getState()
      .getActiveInstance()
      .selectedTasks.map((task) => task.id),
  );
  const taskItems = slot('task-item');
  const taskLabels = new Map(
    sampleTasks.map(({ label }, index) => [`skin-fixture-task-${index}`, label]),
  );
  const assertVisibleTaskOrder = async (order) => {
    for (const [index, id] of order.entries()) {
      const row = taskItems.nth(index);
      await row.getByText(taskLabels.get(id), { exact: true }).waitFor();
    }
  };
  const taskHandle = await taskItems
    .first()
    .locator('[aria-roledescription="sortable"]')
    .boundingBox();
  const nextTask = await taskItems
    .nth(1)
    .locator('[data-skin-slot="task-item-head"]')
    .boundingBox();
  assert(taskHandle && nextTask, 'sortable handles and the next task must be visible');
  await page.mouse.move(taskHandle.x + taskHandle.width / 2, taskHandle.y + taskHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(nextTask.x + nextTask.width / 2, nextTask.y + nextTask.height / 2, {
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
  await assertVisibleTaskOrder(afterPointerDrag);
  await setAppearance('deepseek', 'light');
  await assertVisibleTaskOrder(afterPointerDrag);
  await setAppearance('naiwa', 'light');
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
    'pointer dragging swaps adjacent tasks and both skins preserve the new visible order',
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
  checks.push('keyboard Space/ArrowDown/Space swaps adjacent tasks');

  // Collapsing panels changes only their native local layout.
  const panelHeight = (name) =>
    slot(name).evaluate((element) => element.getBoundingClientRect().height);
  for (const { id } of skins.slice(0, 2)) {
    await setAppearance(id, 'light');
    const screenshotHeader = slot('screenshot').locator(':scope > [role="button"]');
    const expandedHeight = await panelHeight('screenshot');
    await screenshotHeader.press('Enter');
    await page.waitForFunction(
      (height) =>
        document.querySelector('[data-skin-slot="screenshot"]').clientHeight < height - 20,
      expandedHeight,
    );
    await screenshotHeader.click();
    await page.waitForFunction(
      (height) =>
        document.querySelector('[data-skin-slot="screenshot"]').clientHeight >= height - 1,
      expandedHeight,
    );

    const logHeader = slot('logs').locator(':scope > [role="button"]');
    await logHeader.press('Enter');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-skin-slot="connection"]').parentElement.clientHeight === 0,
    );
    await logHeader.click({ position: { x: 20, y: 15 } });
    await page.waitForFunction(
      () => document.querySelector('[data-skin-slot="connection"]').parentElement.clientHeight > 0,
    );
  }
  checks.push('screenshot and sidebar collapse controls work with keyboard and pointer');

  await setAppearance('deepseek', 'light');
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    store.setInstanceConnectionStatus(store.activeInstanceId, 'Connected');
  });
  const screen = slot('screenshot-screen');
  const image = screen.getByRole('img', { name: 'Screenshot' });
  await image.waitFor();
  const screenshotImage = await image.elementHandle();
  assert(await image.evaluate((element) => element.decode().then(() => element.naturalWidth > 0)));
  await slot('screenshot').getByTitle('停止实时流', { exact: true }).click();
  await slot('screenshot').getByTitle('全屏显示', { exact: true }).click();
  const exitFullscreen = page.getByTitle('退出全屏', { exact: true });
  await exitFullscreen.waitFor();
  for (const { id } of skins.slice(0, 2)) {
    await setAppearance(id, 'light');
    assert.equal(await image.getAttribute('src'), screenshotFrame);
    assert(await image.evaluate((element, original) => element === original, screenshotImage));
    assert.equal(
      await screen.evaluate((element) => getComputedStyle(element).backgroundImage),
      'none',
    );
    assert(await exitFullscreen.isVisible());
    assert(await slot('screenshot').getByTitle('开始实时流', { exact: true }).isEnabled());
  }
  await page.keyboard.press('Escape');
  await exitFullscreen.waitFor({ state: 'detached' });
  await screenshotImage.dispose();
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    store.setInstanceConnectionStatus(store.activeInstanceId, 'Disconnected');
  });
  await image.waitFor({ state: 'detached' });
  checks.push('skin switching retains the decoded screenshot, fullscreen view and paused stream');

  // Provide real host statuses and preserve them through a foreground refresh.
  await setTaskState('running');
  backendTaskInstances = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const instance = store.getActiveInstance();
    const statuses = {
      [instance.selectedTasks[0].id]: 'succeeded',
      [instance.selectedTasks[1].id]: 'running',
    };
    useAppStore.setState({
      instanceTaskRunStatus: { ...store.instanceTaskRunStatus, [instance.id]: statuses },
    });
    return {
      [instance.id]: {
        connected: store.instanceConnectionStatus[instance.id] === 'Connected',
        resource_loaded: !!store.instanceResourceLoaded[instance.id],
        tasker_inited: false,
        is_running: true,
        task_run_state: {
          statuses,
          mappings: store.maaTaskIdMapping[instance.id] ?? {},
          pending_task_ids: store.instancePendingTaskIds[instance.id] ?? [],
          current_task_index: store.instanceCurrentTaskIndex[instance.id] ?? 0,
          overall_status: 'Running',
        },
      },
    };
  });
  const taskStatuses = () =>
    slot('task-item').evaluateAll((items) =>
      items.slice(0, 2).map((item) => item.dataset.taskStatus),
    );
  const waitForMotion = (motion) =>
    page.waitForFunction((mode) => document.body.dataset.skinMotion === mode, motion);
  const ambientIsMoving = () =>
    page
      .locator('[data-skin-ambient]')
      .evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.playState === 'running'),
      );
  for (const { id } of skins.slice(0, 2)) {
    await setAppearance(id, 'dark');
    await waitForMotion('full');
    assert.equal(await shell.getAttribute('data-task-state'), 'running');
    assert.deepEqual(await taskStatuses(), ['succeeded', 'running']);
    assert(await ambientIsMoving(), `${id}: themed ambience responds to a running task`);
    if (output) {
      await page.screenshot({ path: path.join(output, `main-${id}-running.png`) });
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await waitForMotion('reduced');
    assert.equal(await ambientIsMoving(), false);
    assert.deepEqual(await taskStatuses(), ['succeeded', 'running']);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await waitForMotion('full');

    await openSettings();
    await reducedMotion.check();
    await showMain();
    await waitForMotion('reduced');
    assert.equal(await ambientIsMoving(), false);
    assert.deepEqual(await taskStatuses(), ['succeeded', 'running']);
    await openSettings();
    await reducedMotion.uncheck();
    await showMain();
    await waitForMotion('full');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForMotion('paused');
    assert.equal(await ambientIsMoving(), false);
    await page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForMotion('full');
    assert.deepEqual(await taskStatuses(), ['succeeded', 'running']);
  }
  backendTaskInstances = {};
  await setTaskState('idle');
  checks.push(
    'system and app motion settings and hidden pages pause ambience without altering task statuses',
  );

  for (const [width, height] of [
    [850, 525],
    [768, 900],
    [680, 420],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const mobile = width < 768;
    if (mobile) await slot('mobile-scroll').waitFor();
    else await slot('sidebar').waitFor();

    for (const { id } of skins.slice(0, 2)) {
      await setAppearance(id, 'dark');
      if (width === 850) {
        assert.equal(await toolbarLabels.count(), 0, `${id}: narrow toolbar hides action labels`);
      }
      if (mobile) {
        const {
          connection,
          screenshot,
          toolbar,
          logs,
          'task-list': tasks,
        } = await layout(['connection', 'screenshot', 'task-list', 'toolbar', 'logs']);
        assert(
          connection.bottom <= screenshot.y + 1 &&
            screenshot.bottom <= tasks.y + 1 &&
            tasks.bottom <= toolbar.y + 1 &&
            toolbar.bottom <= logs.y + 1,
          `${id}: narrow workspace keeps the standard single-column panel order`,
        );
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${id} ${width}x${height}: the page has no horizontal overflow`,
      );
      const controls = [
        page.locator('[data-role="start-stop-button"]').filter({ visible: true }),
        companionTrigger,
        slot('screenshot').locator(':scope > [role="button"]'),
        slot('connection').locator(':scope > button').first(),
      ];
      for (const control of controls) {
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
          `${id} ${width}x${height}: native control stays clear of decoration`,
        );
        await control.focus();
        assert(await control.evaluate((element) => document.activeElement === element));
      }
      if (output && (width === 850 || width === 390)) {
        if (mobile)
          await slot('mobile-scroll').evaluate((element) => {
            element.scrollTop = 0;
          });
        await page.screenshot({
          path: path.join(output, `main-${id}-${width}x${height}.png`),
          animations: 'disabled',
        });
      }
    }
    checks.push(
      `standard workspace and controls remain usable on both refreshed skins at ${width}x${height}`,
    );
  }
  // Native anchored popovers fit the desktop and mobile tab bars.
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
    'update and recently-closed popovers open, fit and dismiss on both refreshed skins at 850x525 and 390x844',
  );

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
    'all five languages keep task actions inside the viewport on both refreshed skins at 768px and 390px',
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
