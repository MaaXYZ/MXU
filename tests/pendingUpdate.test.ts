import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { createServer, type ViteDevServer } from 'vite';
import type { UpdateInfo } from '../src/stores/types.ts';
import type { PendingUpdateInfo } from '../src/services/updateService.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const storage = new Map<string, string>();
const pendingKey = 'mxu-pending-update';
const actualSavePath = '/fixture/cache/redirected-package.zip';
const origin = { resourceId: 'Alpha', baseVersion: '1.0.0' };
const update: UpdateInfo = {
  origin,
  hasUpdate: true,
  versionName: '3.0.0',
  releaseNote: 'Release notes',
  downloadUrl: 'https://example.invalid/package.zip',
  downloadSource: 'mirrorchyan',
  updateType: 'incremental',
  fileSize: 42,
};
let server: ViteDevServer;
let service: typeof import('../src/services/updateService.ts');
let store: typeof import('../src/stores/appStore.ts');
let packageExists = true;
let checkedPaths: string[] = [];

before(async () => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window: Object.assign(new EventTarget(), {
      location: new URL('http://localhost/'),
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { path: string }) => {
          if (command === 'plugin:fs|exists') {
            checkedPaths.push(args.path);
            return packageExists;
          }
          if (command === 'get_github_release_by_version') {
            return {
              assets: [
                {
                  name: 'Alpha-win-x64-v3.0.0.zip',
                  browser_download_url: 'https://example.invalid/full.zip',
                  size: 100,
                },
              ],
            };
          }
          throw new Error(`Unexpected native operation: ${command}`);
        },
      },
    }),
  });
  const httpId = '\0pending-update-http';
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.cache', 'pending-update-tests'),
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        { find: '@tauri-apps/plugin-http', replacement: httpId },
        { find: '@', replacement: join(root, 'src') },
      ],
    },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [
      {
        name: 'pending-update-http-fixture',
        resolveId: (id) => (id === httpId ? httpId : undefined),
        load: (id) =>
          id === httpId
            ? `export async function fetch() {
                 return Response.json({ code: 0, data: {
                   version_name: '3.0.0', url: 'https://example.invalid/package.zip',
                   update_type: 'incremental', release_note: 'Release notes'
                 }});
               }`
            : undefined,
      },
    ],
  });
  service = await server.ssrLoadModule('/src/services/updateService.ts');
  store = await server.ssrLoadModule('/src/stores/appStore.ts');
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  storage.clear();
  packageExists = true;
  checkedPaths = [];
  store.useAppStore.setState({
    backendOS: 'windows',
    backendArch: 'x86_64',
    downloadStatus: 'idle',
    downloadSavePath: null,
    mirrorChyanSettings: { cdk: '', channel: 'stable' },
  });
});

test('both download sources retain the RID and exact version used to request the update', async () => {
  for (const cdk of ['test-cdk', undefined]) {
    const result = await service.checkAndPrepareDownload({
      resourceId: origin.resourceId,
      currentVersion: origin.baseVersion,
      cdk,
      githubUrl: 'https://github.com/example/Alpha',
    });
    assert.deepEqual(result?.origin, origin);
    assert.equal(result.downloadSource, cdk ? 'mirrorchyan' : 'github');
  }
});

test('startup restores the same project and base while rejecting unrelated or legacy packages', async () => {
  const pending: PendingUpdateInfo = {
    origin,
    versionName: '3.0.0',
    releaseNote: '',
    downloadSavePath: actualSavePath,
    timestamp: 1,
  };
  for (const [name, record, version, resourceId] of [
    ['legacy', { ...pending, origin: undefined }, '1.0.0', 'Alpha'],
    ['changed base', pending, '2.0.0', 'Alpha'],
    ['changed RID', pending, '1.0.0', 'Beta'],
    ['missing RID', pending, '1.0.0', undefined],
    ['missing version', pending, undefined, 'Alpha'],
  ] as const) {
    storage.set(pendingKey, JSON.stringify(record));
    assert.equal(await service.getPendingUpdateInfo(version, resourceId), null, name);
    assert.equal(storage.has(pendingKey), false, name);
    assert.deepEqual(checkedPaths, [], 'invalid origins are rejected before accessing the package');
  }

  service.savePendingUpdateInfo(pending);
  assert.deepEqual(await service.getPendingUpdateInfo('1.0.0', 'Alpha'), pending);
  assert.equal(storage.has(pendingKey), true, 'a valid package remains available for installation');
  assert.deepEqual(checkedPaths, [actualSavePath]);
});

test('a matching origin still checks target version and package existence', async () => {
  const pending: PendingUpdateInfo = {
    origin,
    versionName: '1.0.0',
    releaseNote: '',
    downloadSavePath: actualSavePath,
    timestamp: 1,
  };
  service.savePendingUpdateInfo(pending);
  assert.equal(await service.getPendingUpdateInfo('1.0.0', 'Alpha'), null);
  assert.equal(storage.has(pendingKey), false);

  service.savePendingUpdateInfo({ ...pending, versionName: '3.0.0' });
  packageExists = false;
  assert.equal(await service.getPendingUpdateInfo('1.0.0', 'Alpha'), null);
  assert.equal(storage.has(pendingKey), false);

  service.savePendingUpdateInfo({ ...pending, versionName: 'nightly-42' });
  packageExists = true;
  assert.equal((await service.getPendingUpdateInfo('1.0.0', 'Alpha'))?.versionName, 'nightly-42');
});

// Execute the production callbacks without mounting the full desktop UI. Only their native
// download dependency is replaced; persistence and Zustand subscriptions remain real.
function downloadCallback(file: string, name: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let callback: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `Missing download callback ${name}`);
  const code = ts.transpileModule(
    `const callback = ${callback.getText(source)}; return callback;`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)) as (
    info: UpdateInfo,
  ) => Promise<void>;
}

for (const [file, callback] of [
  ['src/App.tsx', 'startAutoDownload'],
  ['src/components/UpdatePanel.tsx', 'startDownload'],
  ['src/components/settings/UpdateSection.tsx', 'startDownload'],
]) {
  test(`${file} persists the actual package and origin before announcing completion`, async () => {
    const announced: PendingUpdateInfo[] = [];
    const unsubscribe = store.useAppStore.subscribe((state, previous) => {
      if (state.downloadStatus === 'completed' && previous.downloadStatus !== 'completed') {
        assert.equal(state.downloadSavePath, actualSavePath);
        announced.push(JSON.parse(storage.get(pendingKey)!));
      }
    });
    const logger = { info() {}, warn() {}, error() {} };
    const run = downloadCallback(file, callback, {
      ...store.useAppStore.getState(),
      useAppStore: store.useAppStore,
      updateInfo: update,
      downloadStartedRef: { current: false },
      getUpdateSavePath: async () => '/fixture/cache/requested.zip',
      proxySettingsForUpdateDownload: () => undefined,
      downloadUpdate: async () => ({ success: true, actualSavePath }),
      completeUpdateDownload: service.completeUpdateDownload,
      tryAutoInstallUpdate() {},
      log: logger,
      loggers: { ui: logger },
    });
    try {
      await run(update);
      assert.equal(announced.length, 1);
      assert.deepEqual(announced[0], {
        origin,
        versionName: update.versionName,
        releaseNote: update.releaseNote,
        downloadSavePath: actualSavePath,
        fileSize: update.fileSize,
        updateType: update.updateType,
        downloadSource: update.downloadSource,
        timestamp: announced[0].timestamp,
      });
      assert.ok(announced[0].timestamp > 0);
      assert.deepEqual(await service.getPendingUpdateInfo('1.0.0', 'Alpha'), announced[0]);
    } finally {
      unsubscribe();
    }
  });
}
