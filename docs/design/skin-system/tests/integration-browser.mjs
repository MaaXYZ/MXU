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
  server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false },
});
let browser;
const checks = [];
const skins = ['deepseek', 'naiwa'];
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
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
          name: 'MXU',
          label: '日常助手',
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
            skinId: 'naiwa',
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
    } else if (url.pathname.endsWith('/screenshot')) {
      body = {
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=',
      };
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

  const slot = (name) => page.locator(`[data-skin-slot="${name}"]:visible`);
  const companion = slot('companion');
  const preview = page.locator('.builtin-skin--preview');
  const settings = page.getByTitle('设置', { exact: true });
  const reducedMotion = page.getByRole('checkbox', { name: '减少皮肤动效', exact: true });
  const toMain = () =>
    page.evaluate(async () =>
      (await import('/src/stores/appStore.ts')).useAppStore.getState().setCurrentPage('main'),
    );
  const waitForMotion = (motion) =>
    page.waitForFunction((value) => document.body.dataset.skinMotion === value, motion);
  const takeScreenshot = async (name) => {
    if (!output) return;
    await page.mouse.move(0, 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    });
    await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
  };
  await page.goto(base);
  await companion.waitFor();
  assert.equal(await companion.getAttribute('data-builtin-skin'), 'naiwa');
  assert(await page.locator('html').evaluate((element) => element.classList.contains('dark')));
  checks.push('startup restores the saved frog skin and dark theme even without saved instances');
  await settings.click();
  await page.getByRole('button', { name: '蓝色大肥鱼', exact: true }).click();
  await preview.getByRole('button', { name: '投喂白饭', exact: true }).click();
  const clipPlaying = (region) =>
    page.waitForFunction((selector) => {
      const clip = document.querySelector(`${selector} video`);
      return clip && clip.muted && !clip.paused && clip.currentTime > 0.1;
    }, region);
  await clipPlaying('.builtin-skin--preview');
  await reducedMotion.check();
  await page.waitForFunction(() => document.querySelector('.builtin-skin--preview video').paused);
  await reducedMotion.uncheck();
  const chooseFrog = page.getByRole('button', { name: '奶蛙', exact: true });
  await chooseFrog.click();
  assert.equal(await chooseFrog.getAttribute('aria-pressed'), 'true');
  await preview.getByRole('button', { name: '播放大笑', exact: true }).click();
  await clipPlaying('.builtin-skin--preview');
  assert.equal(await preview.getAttribute('data-interacting'), 'true');
  await page.locator('#settings-skin-label').scrollIntoViewIfNeeded();
  await takeScreenshot('settings-skins.png');
  checks.push(
    'settings previews both characters, including silent rice footage and the motion setting',
  );
  await page.reload();
  await companion.waitFor();
  assert.equal(await companion.getAttribute('data-builtin-skin'), 'naiwa');
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
  await settings.click();
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

  assert.equal(await preview.getAttribute('data-task-state'), 'idle');
  await page.getByRole('button', { name: '默认', exact: true }).click();
  assert.equal(await preview.count(), 0);
  await chooseFrog.click();
  await toMain();
  for (const state of ['running', 'success', 'error', 'idle']) {
    await setTaskState(state);
    assert.equal(await companion.getAttribute('data-task-state'), state);
    if (state === 'success') await clipPlaying('[data-skin-slot="companion"]');
    else assert(await companion.locator('video').evaluate((clip) => clip.paused));
    assert.equal(await companion.isDisabled(), state === 'error' || state === 'success');
  }
  checks.push('the live companion follows host results while the settings preview stays idle');
  await page
    .getByText('如需更稳定的体验，建议使用桌面客户端', { exact: false })
    .locator('..')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  // Populate the real TaskItem, tabs and log components, rather than screenshotting an empty shell.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const store = useAppStore.getState();
    const instanceId = store.activeInstanceId;
    store.renameInstance(instanceId, '日常任务');
    store.clearLogs(instanceId);
    store.setShowAddTaskPanel(false);
    store.updateInstance(instanceId, {
      selectedTasks: store.projectInterface.task.map((task, index) => ({
        id: `skin-fixture-task-${index}`,
        taskName: task.name,
        enabled: index !== 3,
        expanded: false,
        optionValues: {},
      })),
    });
    store.addLog(instanceId, { type: 'info', message: '配置已加载，等待开始任务。' });
    store.addLog(instanceId, { type: 'success', message: '日常任务列表已就绪。' });
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

  const layout = async () =>
    page.evaluate(async () => {
      const scroll = document.querySelector('[data-skin-slot="mobile-scroll"]');
      if (scroll) scroll.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const selectors = [
        'tabs',
        'tab',
        'tabs-tools',
        'workspace',
        'task-panel',
        'task-list',
        'task-item',
        'toolbar',
        'start-button',
        'sidebar',
        'connection',
        'screenshot',
        'logs',
      ];
      return Object.fromEntries(
        selectors.flatMap((name) => {
          const element = document.querySelector(`[data-skin-slot="${name}"]`);
          if (!element) return [];
          const { left, top, right, bottom } = element.getBoundingClientRect();
          return [[name, { left, top, right, bottom }]];
        }),
      );
    });
  const assertSameLayout = (standard, actual, context) => {
    assert.deepEqual(Object.keys(actual), Object.keys(standard), context);
    for (const [name, box] of Object.entries(standard)) {
      for (const edge of ['left', 'top', 'right', 'bottom']) {
        const difference = Math.abs(actual[name][edge] - box[edge]);
        // Allow one host panel gutter for the stickers' borders and insets.
        assert(difference <= 16, `${context}: ${name}.${edge} moved ${difference}px from default`);
      }
    }
  };
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const theme of ['light', 'dark']) {
    await setAppearance('default', theme);
    const standard = await bodyTokens();
    const standardLayout = await layout();
    assert(standardLayout['task-panel'] && standardLayout.sidebar);
    const palettes = [];
    for (const skinId of skins) {
      await setAppearance(skinId, theme);
      const palette = await bodyTokens();
      palettes.push(palette['--color-bg-primary']);
      assert.notEqual(palette['--color-bg-primary'], standard['--color-bg-primary']);
      assert.notEqual(palette['--color-border'], standard['--color-border']);
      assert.equal(palette['--color-accent'], standard['--color-accent']);
      assertSameLayout(standardLayout, await layout(), `${skinId} ${theme}`);
      const decor = page.locator('.skin-decor--tasks, .skin-decor--screenshot, .skin-decor--logs');
      assert.equal(await decor.count(), 3);
      assert(
        await decor.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element.getAttribute('aria-hidden') === 'true' &&
              getComputedStyle(element).pointerEvents === 'none',
          ),
        ),
      );
      const sticker = page.locator('.skin-decor--tasks');
      const lastTask = await slot('task-item').last().boundingBox();
      const blankArea = await sticker.boundingBox();
      assert(
        blankArea && lastTask && blankArea.y >= lastTask.y + lastTask.height - 1,
        'the workspace illustration only occupies space below the task list',
      );
      assert(
        await sticker.locator('img, image').evaluateAll(async (images) => {
          if (!images.length) return false;
          const decoded = await Promise.all(
            images.map(async (element) => {
              const image = new Image();
              image.src = element instanceof SVGImageElement ? element.href.baseVal : element.src;
              await image.decode();
              return image.naturalWidth;
            }),
          );
          return decoded.every((width) => width > 0);
        }),
        'the bundled character must decode',
      );
      await slot('task-item').first().click({ button: 'right' });
      const menu = page.locator('body > div[class*="min-w-[180px]"]');
      await menu.waitFor();
      assert.equal(
        await menu.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--color-bg-secondary').trim(),
        ),
        palette['--color-bg-secondary'],
      );
      await slot('tabs-project').click();
      await menu.waitFor({ state: 'detached' });
      await takeScreenshot(`workspace-${skinId}-${theme}.png`);
    }
    assert.notEqual(palettes[0], palettes[1]);
    await setAppearance('default', theme);
    assert.deepEqual(await bodyTokens(), standard);
    assert.equal(await companion.count(), 0);
    assert.equal(
      await page.locator('.skin-decor--tasks, .skin-decor--screenshot, .skin-decor--logs').count(),
      0,
    );
  }
  checks.push(
    'both palettes reach body portals, preserve the host accent and retain the default controls in light and dark',
  );

  // Skin switching also retains focus and the component instance holding the captured frame.
  await slot('task-item').first().getByRole('checkbox').first().focus();
  const handle = await slot('screenshot').elementHandle();
  for (const skinId of [...skins, 'gugugaga', 'default']) {
    await setAppearance(skinId, 'dark');
    if (skinId === 'gugugaga' || skinId === 'default') {
      assert.equal(await companion.count(), 0);
      assert.equal(await page.locator('.skin-decor--tasks').count(), 0);
    }
    assert(
      await handle.evaluate(
        (element) => element === document.querySelector('[data-skin-slot="screenshot"]'),
      ),
    );
    assert(
      await slot('task-item')
        .first()
        .evaluate((element) => element.contains(document.activeElement)),
    );
  }
  await handle.dispose();
  checks.push(
    'changing skins and returning to default retain native control focus and the screenshot panel',
  );

  // An empty task list centers its import actions even when a pre-action appears above it.
  await slot('tab').filter({ hasText: '活动安排' }).click();
  const importButton = slot('empty-tasks').getByRole('button', {
    name: '从剪贴板导入配置',
    exact: true,
  });
  for (const preAction of [false, true]) {
    if (preAction) {
      await page.evaluate(async () => {
        const store = (await import('/src/stores/appStore.ts')).useAppStore.getState();
        store.addPreAction(store.activeInstanceId, {
          id: 'before-tasks',
          enabled: false,
          customName: '前置程序',
          program: '',
          args: '',
          waitForExit: true,
          skipIfRunning: true,
          useCmd: false,
        });
      });
      await slot('task-stack').getByText('前置程序', { exact: true }).waitFor();
    }
    await setAppearance('default', 'light');
    await importButton.waitFor();
    const normal = await importButton.boundingBox();
    for (const skinId of skins) {
      await setAppearance(skinId, 'light');
      await importButton.click({ trial: true });
      const decorated = await importButton.boundingBox();
      assert(
        Math.abs(decorated.x - normal.x) <= 16 && Math.abs(decorated.y - normal.y) <= 16,
        `${skinId}: empty import control moved with preAction=${preAction}`,
      );
    }
  }
  await slot('tab').filter({ hasText: '日常任务' }).click();
  checks.push('empty and pre-action-only lists keep the import control centered and clickable');

  // Feed an image through the WebUI screenshot API and verify empty-state art goes away.
  const setConnected = (connected) =>
    page.evaluate(async (value) => {
      const store = (await import('/src/stores/appStore.ts')).useAppStore.getState();
      store.setInstanceConnectionStatus(
        store.activeInstanceId,
        value ? 'Connected' : 'Disconnected',
      );
    }, connected);
  await setAppearance('deepseek', 'light');
  await setConnected(true);
  const frame = slot('screenshot-screen').getByAltText('Screenshot', { exact: true });
  await frame.waitFor();
  for (const skinId of skins) {
    await setAppearance(skinId, 'light');
    assert.equal(await page.locator('.skin-decor--screenshot').count(), 0);
    assert(
      await frame.evaluate(async (image) => {
        await image.decode();
        return image.naturalWidth > 0;
      }),
    );
  }
  await setConnected(false);
  await page.locator('.skin-decor--screenshot').waitFor();
  checks.push(
    'a frame from the WebUI screenshot endpoint replaces the empty-state artwork on both skins',
  );

  // Exercise the horizontal tab hit-testing, not just its CSS orientation.
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
  checks.push('horizontal instance navigation reorders tabs using their actual hit regions');

  // Native task controls keep operating in both decorated layouts.
  for (const skinId of skins) {
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
  checks.push('both skins retain task enable, option expansion and context-menu reordering');

  // Reorder adjacent tasks with the native pointer and keyboard handles.
  await page.setViewportSize({ width: 1280, height: 900 });
  await setAppearance('naiwa', 'light');
  await setTaskState('idle');
  const beforePointerDrag = await page.evaluate(async () =>
    (await import('/src/stores/appStore.ts')).useAppStore
      .getState()
      .getActiveInstance()
      .selectedTasks.map((task) => task.id),
  );
  const taskRows = page.locator('[data-skin-slot="task-item"]');
  const dragHandle = await taskRows
    .first()
    .locator('[aria-roledescription="sortable"]')
    .boundingBox();
  const nextTaskHeader = await taskRows
    .nth(1)
    .locator('[data-skin-slot="task-item-head"]')
    .boundingBox();
  assert(dragHandle && nextTaskHeader, 'native sortable handles and the next task must be visible');
  await page.mouse.move(dragHandle.x + dragHandle.width / 2, dragHandle.y + dragHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nextTaskHeader.x + nextTaskHeader.width / 2,
    nextTaskHeader.y + nextTaskHeader.height / 2,
    {
      steps: 12,
    },
  );
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
    'native pointer drag from the first task to the second swaps adjacent tasks without skipping an entry',
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
  checks.push('keyboard Space/ArrowDown/Space moves the adjacent task');

  for (const skinId of skins) {
    await setAppearance(skinId, 'light');
    const logHeader = slot('logs').locator('> [role="button"]');
    const before = await slot('logs').boundingBox();
    await logHeader.click({ position: { x: 15, y: 12 } });
    await page.waitForFunction(
      (top) =>
        document.querySelector('[data-skin-slot="logs"]').getBoundingClientRect().top < top - 40,
      before.y,
    );
    await logHeader.click({ position: { x: 15, y: 12 } });
    await page.waitForFunction(
      (top) =>
        Math.abs(
          document.querySelector('[data-skin-slot="logs"]').getBoundingClientRect().top - top,
        ) <= 1,
      before.y,
    );
  }
  checks.push(
    'the log header collapses and restores connection and screenshot panels in both skins',
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

  const decorationAnimations = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-skin-ambient], .skin-decor--tasks, .skin-decor--screenshot, .skin-decor--logs, [data-builtin-skin]',
        ),
      ]
        .flatMap((element) => element.getAnimations({ subtree: true }))
        .filter((animation) => animation.playState === 'running')
        .map((animation) => animation.animationName),
    );
  const assertStopped = async () => {
    assert.deepEqual(await decorationAnimations(), []);
    assert(
      await companion.locator('video').evaluateAll((clips) => clips.every((clip) => clip.paused)),
    );
  };
  const assertTaskFacts = async () => {
    assert.equal(await slot('task-item').nth(0).getAttribute('data-task-status'), 'succeeded');
    assert.equal(await slot('task-item').nth(1).getAttribute('data-task-status'), 'running');
    assert.equal(
      await page.evaluate(async () =>
        JSON.stringify(
          (await import('/src/stores/appStore.ts')).useAppStore.getState().instanceTaskRunStatus,
        ),
      ),
      taskFacts,
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

  for (const skinId of skins) {
    await setAppearance(skinId, 'dark');
    await waitForMotion('full');
    await companion.click({ trial: true });
    await companion.press('Enter');
    await page.locator('[data-skin-slot="companion"][data-interacting="true"]').waitFor();
    await clipPlaying('[data-skin-slot="companion"]');
    await assertTaskFacts();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await waitForMotion('reduced');
    await assertStopped();
    await assertTaskFacts();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await waitForMotion('full');
    await settings.click();
    await reducedMotion.check();
    await toMain();
    await waitForMotion('reduced');
    await assertStopped();
    await assertTaskFacts();
    await settings.click();
    await reducedMotion.uncheck();
    await toMain();
    await waitForMotion('full');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.body.dataset.skinMotion === 'paused');
    await assertStopped();
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

  await setTaskState('idle');
  checks.push(
    'interactions, OS/app motion reduction and backgrounding preserve the host task statuses and pause decoration',
  );

  const assertHitTarget = async (control, context) => {
    await control.scrollIntoViewIfNeeded();
    assert(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return element.contains(target);
      }),
      context,
    );
    await control.focus();
    assert(await control.evaluate((element) => document.activeElement === element), context);
  };
  for (const [width, height] of [
    [1280, 900],
    [850, 525],
    [800, 900],
    [775, 900],
    [768, 900],
    [680, 420],
    [566, 350],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await setAppearance('default', 'dark');
    const normal = await layout();
    for (const skinId of skins) {
      await setAppearance(skinId, 'dark');
      const actual = await layout();
      assertSameLayout(normal, actual, `${skinId} ${width}x${height}`);
      if (width >= 768) {
        assert(actual.sidebar.right <= width + 1, `${skinId} ${width}: sidebar clips`);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await slot('mobile-scroll').count(), width < 768 ? 1 : 0);
      for (const control of [
        slot('start-button'),
        companion,
        slot('screenshot').locator('> [role="button"]'),
        slot('connection').locator('> button').first(),
        page.locator('#add-task-button'),
      ]) {
        await assertHitTarget(control, `${skinId} ${width}x${height}: blocked control`);
      }
      await page.locator('#add-task-button').click();
      const addPanelOpen = () =>
        page.evaluate(
          async () =>
            (await import('/src/stores/appStore.ts')).useAppStore.getState().showAddTaskPanel,
        );
      assert(await addPanelOpen());
      await page.locator('#add-task-button').click();
      assert.equal(await addPanelOpen(), false);
      if (output && width === 390) {
        await slot('connection').scrollIntoViewIfNeeded();
        await takeScreenshot(`main-${skinId}-mobile.png`);
      }
    }
    checks.push(
      `native controls and slots match the default layout and accept input at ${width}x${height}`,
    );
  }
  // Native anchored popovers must fit both desktop and mobile tab bars.
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
    for (const skinId of skins) {
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
    'native update and recently-closed popovers open, fit and dismiss from both skins at 850x525 and 390x844 without downloading or reopening',
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
      for (const skinId of skins) {
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
    'all five languages keep task actions inside the viewport in both skins at 768px and 390px',
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
