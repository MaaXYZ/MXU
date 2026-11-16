import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import type { AppSettings, MxuConfig } from '../src/types/config.ts';

const appearanceKey = 'mxu-webui-appearance';
const project = {
  interface_version: 2 as const,
  name: 'skin-test',
  controller: [],
  resource: [],
  task: [{ name: 'Run', entry: 'Entry' }],
};

const config = (settings: Partial<AppSettings> = {}): MxuConfig => ({
  version: '1.0',
  instances: [{ id: 'one', name: 'One', tasks: [] }],
  settings: {
    theme: 'light',
    accentColor: 'deepsea',
    language: 'en-US',
    ...settings,
  },
});

async function harness(desktop: boolean) {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  };
  const window = Object.assign(new EventTarget(), {
    location: { protocol: 'http:', hostname: 'localhost', host: 'localhost' },
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
  });
  const document = {
    documentElement: {
      classList: { toggle() {} },
      style: { setProperty() {} },
    },
  };
  for (const [key, value] of Object.entries({ window, document, localStorage: storage })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(tmpdir(), `mxu-skin-tests-${process.pid}-${desktop ? 'desktop' : 'web'}`),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    resolve: { alias: { '@': join(root, 'src') } },
  });
  // Avoid starting the unrelated native file logger in this transport-independent store test.
  await server.ssrLoadModule('/src/utils/logger.ts');
  if (desktop) Object.assign(window, { __TAURI__: {} });
  const store: typeof import('../src/stores/appStore.ts') =
    await server.ssrLoadModule('/src/stores/appStore.ts');
  const appearance: typeof import('../src/services/appearanceStorage.ts') =
    await server.ssrLoadModule('/src/services/appearanceStorage.ts');
  store.useAppStore.setState({ projectInterface: project, dataPath: '.' });
  return {
    data,
    store,
    appearance,
    async close() {
      store.useAppStore.getState().setConfigPersistenceReady(false);
      store.flushSaveConfig();
      await server.close();
    },
  };
}

test('desktop skin preferences survive config round trips and old configurations use defaults', async () => {
  const h = await harness(true);
  try {
    h.data.set(appearanceKey, JSON.stringify({ skinId: 'deepseek', skinReducedMotion: false }));
    const untouchedBrowserPreferences = h.data.get(appearanceKey);
    h.store.useAppStore
      .getState()
      .importConfig(config({ skinId: 'naiwa', skinReducedMotion: true }));
    assert.equal(h.store.useAppStore.getState().skinId, 'naiwa');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, true);
    h.store.useAppStore.getState().setConfigPersistenceReady(true);
    const saved = h.store.flushConfig();
    assert.ok(saved);
    assert.equal(saved.settings.skinId, 'naiwa');
    assert.equal(saved.settings.skinReducedMotion, true);
    h.store.useAppStore.getState().setSkinId('default');
    h.store.useAppStore.getState().setSkinReducedMotion(false);
    h.store.useAppStore.getState().importConfig(saved);
    assert.equal(h.store.useAppStore.getState().skinId, 'naiwa');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, true);
    assert.equal(h.data.get(appearanceKey), untouchedBrowserPreferences);

    h.store.useAppStore.getState().importConfig(config());
    assert.equal(h.store.useAppStore.getState().skinId, 'default');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, false);
    const invalid = config();
    Object.assign(invalid.settings, { skinId: 'external-skin', skinReducedMotion: 'true' });
    h.store.useAppStore.getState().importConfig(invalid);
    assert.equal(h.store.useAppStore.getState().skinId, 'default');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, false);
  } finally {
    await h.close();
  }
});

test('switching a built-in skin leaves running tasks, runtime state and theme preferences intact', async () => {
  const h = await harness(false);
  try {
    const selectedTasks = [
      { id: 'task', taskName: 'Run', enabled: true, expanded: true, optionValues: {} },
    ];
    const instances = [{ id: 'one', name: 'One', isRunning: true, selectedTasks }];
    const statuses = { one: 'Running' as const };
    const currentTasks = { one: 'task' };
    const runStatuses = { one: { task: 'running' as const } };
    h.store.useAppStore.setState({
      instances,
      activeInstanceId: 'one',
      instanceTaskStatus: statuses,
      instanceCurrentTaskId: currentTasks,
      instanceTaskRunStatus: runStatuses,
      theme: 'dark',
      accentColor: 'emerald',
    });
    for (const skinId of ['deepseek', 'naiwa', 'default'] as const) {
      h.store.useAppStore.getState().setSkinId(skinId);
      h.store.useAppStore.getState().setSkinReducedMotion(true);
      const state = h.store.useAppStore.getState();
      assert.equal(state.skinId, skinId);
      assert.equal(state.skinReducedMotion, true);
      assert.equal(state.instances, instances);
      assert.equal(state.instances[0].selectedTasks, selectedTasks);
      assert.equal(state.instances[0].isRunning, true);
      assert.equal(state.instanceTaskStatus, statuses);
      assert.equal(state.instanceCurrentTaskId, currentTasks);
      assert.equal(state.instanceTaskRunStatus, runStatuses);
      assert.equal(state.activeInstanceId, 'one');
      assert.equal(state.theme, 'dark');
      assert.equal(state.accentColor, 'emerald');
      assert.equal(h.appearance.loadWebUIAppearance()?.skinId, skinId);
      assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, true);
    }
    h.store.useAppStore.getState().setSkinReducedMotion(false);
    assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, false);
  } finally {
    await h.close();
  }
});

test('WebUI skin preferences remain local when saving unrelated backend configuration', async () => {
  const h = await harness(false);
  try {
    h.appearance.patchWebUIAppearance({
      theme: 'dark',
      skinId: 'naiwa',
      skinReducedMotion: true,
    });
    h.store.useAppStore
      .getState()
      .importConfig(config({ skinId: 'deepseek', skinReducedMotion: false }));
    assert.equal(h.store.useAppStore.getState().skinId, 'naiwa');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, true);
    assert.equal(h.store.useAppStore.getState().theme, 'dark');
    h.store.useAppStore.getState().setSkinId('default');
    h.store.useAppStore.getState().setConfirmBeforeDelete(true);
    const saved = h.store.captureConfigForDraft();
    assert.ok(saved);
    assert.equal(saved.settings.skinId, 'deepseek');
    assert.equal(saved.settings.skinReducedMotion, false);
    assert.equal(saved.settings.theme, 'light');
    assert.equal(saved.settings.confirmBeforeDelete, true);
    assert.equal(h.appearance.loadWebUIAppearance()?.skinId, 'default');
    assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, true);

    h.appearance.patchWebUIAppearance({ skinId: 'naiwa', skinReducedMotion: true });
    h.store.useAppStore.getState().importConfig(config());
    assert.equal(h.store.useAppStore.getState().skinId, 'naiwa');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, true);
    const legacySaved = h.store.captureConfigForDraft();
    assert.ok(legacySaved);
    assert.equal(legacySaved.settings.skinId, 'default');
    assert.equal(legacySaved.settings.skinReducedMotion, false);
    assert.equal(h.appearance.getBackendAppearance().skinId, 'default');
    assert.equal(h.appearance.getBackendAppearance().skinReducedMotion, false);
  } finally {
    await h.close();
  }
});

test('WebUI appearance storage restores skin choices and normalizes old or invalid local records', async () => {
  const h = await harness(false);
  try {
    h.appearance.patchWebUIAppearance({ skinId: 'deepseek', skinReducedMotion: true });
    const saved = h.appearance.loadWebUIAppearance();
    assert.equal(saved?.skinId, 'deepseek');
    assert.equal(saved?.skinReducedMotion, true);
    h.appearance.patchWebUIAppearance({ skinId: 'naiwa' });
    assert.equal(h.appearance.loadWebUIAppearance()?.skinId, 'naiwa');
    assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, true);

    h.data.set(appearanceKey, JSON.stringify({ theme: 'dark' }));
    assert.equal(h.appearance.loadWebUIAppearance()?.skinId, 'default');
    assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, false);
    h.store.useAppStore
      .getState()
      .importConfig(config({ skinId: 'deepseek', skinReducedMotion: true }));
    assert.equal(h.store.useAppStore.getState().skinId, 'default');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, false);

    h.data.set(
      appearanceKey,
      JSON.stringify({ skinId: 'https://example.invalid', skinReducedMotion: 1 }),
    );
    assert.equal(h.appearance.loadWebUIAppearance()?.skinId, 'default');
    assert.equal(h.appearance.loadWebUIAppearance()?.skinReducedMotion, false);
    h.data.delete(appearanceKey);
    h.store.useAppStore
      .getState()
      .importConfig(config({ skinId: 'deepseek', skinReducedMotion: true }));
    assert.equal(h.store.useAppStore.getState().skinId, 'deepseek');
    assert.equal(h.store.useAppStore.getState().skinReducedMotion, true);
  } finally {
    await h.close();
  }
});

test('the first local skin edit preserves inherited appearance on reload, including an empty instance configuration', async () => {
  const h = await harness(false);
  try {
    const backend = config({
      theme: 'dark',
      language: 'zh-CN',
      accentColor: 'deepsea',
      skinId: 'default',
      skinReducedMotion: false,
      backgroundImage: 'wallpaper.png',
      backgroundOpacity: 35,
    });
    backend.instances = [];
    backend.customAccents = [
      {
        id: 'custom',
        name: 'custom-color',
        label: { 'zh-CN': '自定义', 'en-US': 'Custom' },
        colors: {
          default: '#123456',
          hover: '#234567',
          light: '#ddeeff',
          lightDark: '#112233',
        },
      },
    ];
    for (const setting of ['skinId', 'skinReducedMotion'] as const) {
      h.data.delete(appearanceKey);
      h.store.useAppStore.getState().importConfig(backend);
      assert.equal(h.appearance.loadWebUIAppearance(), null);
      if (setting === 'skinId') h.store.useAppStore.getState().setSkinId('naiwa');
      else h.store.useAppStore.getState().setSkinReducedMotion(true);

      const savedLocal = h.appearance.loadWebUIAppearance();
      assert.ok(savedLocal);
      assert.equal(savedLocal.theme, 'dark');
      assert.equal(savedLocal.language, 'zh-CN');
      assert.equal(savedLocal.accentColor, 'deepsea');
      assert.equal(savedLocal.backgroundImage, 'wallpaper.png');
      assert.equal(savedLocal.backgroundOpacity, 35);
      assert.deepEqual(savedLocal.customAccents, backend.customAccents);
      assert.equal(savedLocal.skinId, setting === 'skinId' ? 'naiwa' : 'default');
      assert.equal(savedLocal.skinReducedMotion, setting === 'skinReducedMotion');

      // A fresh configuration import reads the local record just as a browser reload would.
      h.store.useAppStore.getState().importConfig(backend);
      const restored = h.store.useAppStore.getState();
      assert.equal(restored.instances.length, 0);
      assert.equal(restored.activeInstanceId, null);
      assert.equal(restored.theme, 'dark');
      assert.equal(restored.language, 'zh-CN');
      assert.equal(restored.accentColor, 'deepsea');
      assert.equal(restored.backgroundImage, 'wallpaper.png');
      assert.equal(restored.backgroundOpacity, 35);
      assert.deepEqual(restored.customAccents, backend.customAccents);
      assert.equal(restored.skinId, savedLocal.skinId);
      assert.equal(restored.skinReducedMotion, savedLocal.skinReducedMotion);

      const savedBackend = h.store.captureConfigForDraft();
      assert.ok(savedBackend);
      assert.equal(savedBackend.settings.skinId, 'default');
      assert.equal(savedBackend.settings.skinReducedMotion, false);
      assert.equal(savedBackend.settings.theme, 'dark');
      assert.equal(savedBackend.settings.language, 'zh-CN');
      assert.equal(savedBackend.settings.accentColor, 'deepsea');
    }

    h.data.delete(appearanceKey);
    h.appearance.cacheBackendAppearance({ theme: undefined, accentColor: undefined });
    h.appearance.patchWebUIAppearance({ skinId: 'naiwa' });
    const oldBackendDefaults = h.appearance.loadWebUIAppearance();
    assert.ok(oldBackendDefaults);
    assert.equal(oldBackendDefaults.theme, 'system');
    assert.equal(oldBackendDefaults.language, 'system');
    assert.equal(oldBackendDefaults.accentColor, 'emerald');
    assert.equal(oldBackendDefaults.backgroundOpacity, 50);
    assert.equal(oldBackendDefaults.skinId, 'naiwa');
    assert.equal(oldBackendDefaults.skinReducedMotion, false);
  } finally {
    await h.close();
  }
});
