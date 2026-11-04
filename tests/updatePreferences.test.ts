import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { MxuConfig } from '../src/types/config.ts';

// Vite loads the real service/component with the same aliases and import.meta.env as the app.
// Only hooks, presentation helpers and external update I/O are replaced; button handlers run intact.
test('update preferences and explicit settings downloads survive restart boundaries', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = {
    state: {} as Record<string, any>,
    pending: [] as Record<string, unknown>[],
    result: { success: true, actualSavePath: '/cache/redirected-update.zip' },
  };
  const global = globalThis as typeof globalThis & { __updateFixture?: typeof fixture };
  global.__updateFixture = fixture;
  const modules: Record<string, string> = {
    hooks: `export const useState = value => [value, () => {}];
      export const useEffect = () => {};
      export const useCallback = callback => callback;
      export const useMemo = callback => callback();
      export const useRef = current => ({ current });`,
    translation: `export const useTranslation = () => ({ t: key => key });`,
    store: `export const useAppStore = () => globalThis.__updateFixture.state;
      useAppStore.getState = useAppStore;`,
    updates: `export const checkAndPrepareDownload = async () => null;
      export const openMirrorChyanWebsite = () => {};
      export const downloadUpdate = async () => globalThis.__updateFixture.result;
      export const getUpdateSavePath = async () => '/cache/requested-update.zip';
      export const cancelDownload = async () => {};
      export const savePendingUpdateInfo = info => globalThis.__updateFixture.pending.push(info);
      export const MIRRORCHYAN_ERROR_CODES = {};
      export const isDebugVersion = () => false;`,
    proxy: `export const createProxySettings = () => undefined;
      export const proxySettingsForUpdateDownload = () => undefined;`,
    content: `export const resolveI18nText = value => value;`,
    i18n: `export const getInterfaceLangKey = () => 'zh-CN';`,
    logger: `const logger = {debug() {}, info() {}, warn() {}, error() {}};
      export const loggers = {config: logger, ui: logger};`,
    ui: `export const SwitchButton = 'switch'; export const TimeInput = 'time';
      export const ReleaseNotes = 'notes'; export const DownloadProgressBar = 'progress';`,
  };
  const replacements = {
    react: 'hooks',
    'react-i18next': 'translation',
    '@/stores/appStore': 'store',
    '@/services/updateService': 'updates',
    '@/services/proxyService': 'proxy',
    '@/services/contentResolver': 'content',
    '@/i18n': 'i18n',
    '@/utils/logger': 'logger',
    '../FormControls': 'ui',
    '../UpdateInfoCard': 'ui',
  };
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': `${root}src` } },
    server: { middlewareMode: true, watch: null },
    plugins: [
      {
        name: 'update-test-fixtures',
        enforce: 'pre',
        resolveId(id) {
          if (id.startsWith('virtual:update-test:')) return `\0${id}`;
        },
        load(id) {
          if (id.startsWith('\0virtual:update-test:')) return modules[id.split(':').at(-1)!];
        },
        transform(code, id) {
          if (!id.endsWith('/components/settings/UpdateSection.tsx')) return;
          for (const [source, name] of Object.entries(replacements)) {
            code = code.replaceAll(`'${source}'`, `'virtual:update-test:${name}'`);
          }
          return code.replaceAll('import.meta.env.DEV', 'false');
        },
      },
    ],
  });
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    const { defaultConfig } = await server.ssrLoadModule('/src/types/config.ts');
    let client = 0;
    async function readFreshConfig(): Promise<MxuConfig> {
      // Each assertion models a new client startup; a connected client's reconnect
      // policy must not be confused with an independent offline preview.
      const { loadConfig } = await server.ssrLoadModule(
        `/src/services/configService.ts?update-test-client=${client++}`,
      );
      return loadConfig('', 'Example');
    }
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host: 'localhost' } },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
        key: (index: number) => [...stored.keys()][index] ?? null,
        get length() {
          return stored.size;
        },
      },
    });
    let hostConfig: MxuConfig | null = null;
    let staticConfig: MxuConfig | null = null;
    t.mock.method(globalThis, 'fetch', async (path: string) => {
      const pathname = new URL(path, 'http://localhost').pathname;
      // The same user behavior must hold with either the raw config API or its
      // revisioned snapshot API; static preview files are a separate source.
      const config =
        pathname === '/api/config' || pathname === '/api/config/snapshot'
          ? hostConfig
          : pathname === '/config/mxu-Example.json'
            ? staticConfig
            : null;
      const body =
        pathname === '/api/config/snapshot' ? { revision: 'test-revision', config } : config;
      return new Response(config ? JSON.stringify(body) : null, {
        status: config ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const preference: MxuConfig = {
      ...defaultConfig,
      instances: [],
      settings: { ...defaultConfig.settings, autoDownloadUpdates: false },
    };
    stored.set('mxu-config-Example', JSON.stringify(preference));

    await t.test('offline preview restores false with no instances', async () => {
      assert.deepEqual(await readFreshConfig(), preference);
    });
    await t.test(
      'valid host and static empty configurations take priority over browser cache',
      async () => {
        hostConfig = defaultConfig;
        assert.deepEqual(await readFreshConfig(), defaultConfig);
        hostConfig = null;
        staticConfig = defaultConfig;
        assert.deepEqual(await readFreshConfig(), defaultConfig);
        staticConfig = null;
      },
    );
    await t.test('invalid local configuration falls back to enabled defaults', async () => {
      stored.set('mxu-config-Example', '{"settings":{"autoDownloadUpdates":false}}');
      assert.equal((await readFreshConfig()).settings.autoDownloadUpdates, true);
      stored.set('mxu-config-Example', '{');
      assert.equal((await readFreshConfig()).settings.autoDownloadUpdates, true);
    });

    const { UpdateSection } = await server.ssrLoadModule(
      '/src/components/settings/UpdateSection.tsx',
    );
    const updateInfo = {
      hasUpdate: true,
      versionName: 'v2.0.0',
      releaseNote: 'New release',
      channel: 'stable',
      downloadUrl: 'https://example.com/update.zip',
      fileSize: 42,
      updateType: 'full',
      downloadSource: 'github',
    };
    function renderDownloadButton(): () => Promise<void> {
      fixture.state = {
        projectInterface: { name: 'Example', mirrorchyan_rid: 'example', version: 'v1.0.0' },
        interfaceTranslations: {},
        language: 'zh-CN',
        mirrorChyanSettings: { cdk: '', channel: 'stable' },
        autoDownloadUpdates: false,
        updateInfo,
        downloadStatus: 'idle',
        installStatus: 'idle',
        setDownloadStatus: (value: string) => (fixture.state.downloadStatus = value),
        setDownloadSavePath: (value: string) => (fixture.state.downloadSavePath = value),
        setDownloadProgress: () => {},
      };
      function findButton(node: any): any {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.map(findButton).find(Boolean);
        if (
          node.type === 'button' &&
          (Array.isArray(node.props.children)
            ? node.props.children
            : [node.props.children]
          ).includes('mirrorChyan.downloadNow')
        ) {
          return node;
        }
        return findButton(node.props?.children);
      }
      const button = findButton(UpdateSection());
      assert.ok(
        button,
        'explicit download button must be rendered while automatic downloading is off',
      );
      return button.props.onClick;
    }
    await t.test(
      'settings success saves actual package path and pending installation metadata',
      async () => {
        await renderDownloadButton()();
        assert.equal(fixture.state.downloadStatus, 'completed');
        assert.equal(fixture.state.downloadSavePath, '/cache/redirected-update.zip');
        assert.equal(fixture.pending.length, 1);
        const [pending] = fixture.pending;
        assert.equal(typeof pending.timestamp, 'number');
        assert.deepEqual(
          { ...pending, timestamp: 0 },
          {
            versionName: updateInfo.versionName,
            releaseNote: updateInfo.releaseNote,
            channel: updateInfo.channel,
            downloadSavePath: '/cache/redirected-update.zip',
            fileSize: updateInfo.fileSize,
            updateType: updateInfo.updateType,
            downloadSource: updateInfo.downloadSource,
            timestamp: 0,
          },
        );
      },
    );
    await t.test('settings failure leaves no pending installation record', async () => {
      fixture.pending.length = 0;
      fixture.result = { success: false, actualSavePath: '' };
      await renderDownloadButton()();
      assert.equal(fixture.state.downloadStatus, 'failed');
      assert.deepEqual(fixture.pending, []);
    });
  } finally {
    await server.close();
    delete global.__updateFixture;
    for (const [key, descriptor] of [
      ['window', savedWindow],
      ['localStorage', savedStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
