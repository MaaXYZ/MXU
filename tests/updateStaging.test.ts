import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function installer() {
  const calls: string[] = [];
  const storage = new Map<string, string>();
  let cleanupError: unknown;
  const log = { info() {}, warn() {}, error() {} };
  const dependencies: Record<string, unknown> = {
    '@/stores/appStore': {
      useAppStore: {
        getState: () => ({
          resetDownloadState() {
            calls.push('reset-download');
          },
        }),
      },
    },
    '@/utils/logger': { loggers: { app: log } },
    '@/utils/pendingUpdateVersion': {},
    '@/utils/paths': { joinPath: posix.join, getCacheDir: async () => '/fixture/cache' },
    '@tauri-apps/api/core': {
      invoke: async (command: string) => {
        calls.push(command);
        if (command === 'cleanup_extract_dir' && cleanupError) throw cleanupError;
        if (command === 'check_changes_json') return null;
        if (command === 'fallback_update') throw new Error('Unexpected fallback');
      },
    },
    '@tauri-apps/api/path': { dirname: posix.dirname },
    '@tauri-apps/plugin-fs': { exists: async () => true },
    '@tauri-apps/plugin-http': {},
    '@tauri-apps/plugin-opener': {},
    semver: {},
    i18next: {},
    './configService': {
      backupConfigBeforeUpdate: async () => {
        calls.push('backup-config');
      },
    },
    './proxyService': {},
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL('../src/services/updateService.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name);
      return dependencies[name];
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const service = exports as unknown as typeof import('../src/services/updateService.ts');
  const pending = {
    versionName: '2.0.0',
    releaseNote: '',
    downloadSavePath: '/fixture/cache/update.zip',
    timestamp: 100,
  };
  service.savePendingUpdateInfo(pending);
  const options = {
    zipPath: pending.downloadSavePath,
    targetDir: '/fixture/app',
    newVersion: pending.versionName,
  };
  return {
    calls,
    storage,
    service,
    options,
    failCleanup(error?: unknown) {
      cleanupError = error;
    },
  };
}

test('failed staging cleanup preserves the pending package and aborts before extraction or apply', async () => {
  const fixture = installer();
  const pending = fixture.storage.get('mxu-pending-update');
  fixture.failCleanup('The previous changes.json is still in use');
  await assert.rejects(fixture.service.installUpdate(fixture.options), (error: Error) => {
    assert.equal(error.name, 'UpdateInstallError');
    assert.equal((error as Error & { code: string }).code, 'extractFailed');
    assert.match(error.message, /changes.json is still in use/);
    return true;
  });
  assert.deepEqual(fixture.calls, ['validate_update_target', 'cleanup_extract_dir']);
  assert.equal(fixture.storage.get('mxu-pending-update'), pending);
  assert.equal(fixture.service.hasInstallFailedInSession(), true);
});

test('a manual retry after staging is released can extract and install the saved package', async () => {
  const fixture = installer();
  fixture.failCleanup(new Error('File in use'));
  await assert.rejects(fixture.service.installUpdate(fixture.options));

  fixture.failCleanup();
  fixture.calls.length = 0;
  assert.equal(await fixture.service.installUpdate(fixture.options), true);
  assert.deepEqual(fixture.calls, [
    'validate_update_target',
    'cleanup_extract_dir',
    'extract_zip',
    'backup-config',
    'check_changes_json',
    'apply_full_update',
    'cleanup_extract_dir',
    'move_file_to_old',
    'cleanup_update_artifacts',
  ]);
  assert.equal(fixture.storage.has('mxu-pending-update'), false);
});
