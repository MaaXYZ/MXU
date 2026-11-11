import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { createServer, type ViteDevServer } from 'vite';
import type { TFunction } from 'i18next';

const root = fileURLToPath(new URL('..', import.meta.url));
const storage = new Map<string, string>();
const pendingKey = 'mxu-pending-update';
const zipPath = '/fixture/cache/update.tgz';
const rawDiagnostic = 'RAW_GZIP_DIAGNOSTIC: checksum mismatch';
const operations: { command: string; args: Record<string, unknown> }[] = [];
let extractionFailure: unknown;
let server: ViteDevServer;
let service: typeof import('../src/services/updateService.ts');
let store: typeof import('../src/stores/appStore.ts');
let localization: typeof import('../src/i18n/index.ts');
let logging: typeof import('../src/utils/logger.ts');
let formatInstallError: (error: unknown, t: TFunction) => string;

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
        invoke: async (command: string, args: Record<string, unknown>) => {
          operations.push({ command, args });
          switch (command) {
            case 'validate_update_target':
            case 'cleanup_extract_dir':
            case 'move_file_to_old':
              return;
            case 'plugin:fs|exists':
              assert.equal(args.path, zipPath);
              return true;
            case 'plugin:path|dirname':
              assert.equal(args.path, zipPath);
              return '/fixture/cache';
            case 'extract_zip':
              throw extractionFailure;
            default:
              throw new Error(`Unexpected native operation: ${command}`);
          }
        },
      },
    }),
  });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.cache', 'gzip-install-error-tests'),
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': join(root, 'src') } },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  service = await server.ssrLoadModule('/src/services/updateService.ts');
  store = await server.ssrLoadModule('/src/stores/appStore.ts');
  localization = await server.ssrLoadModule('/src/i18n/index.ts');
  logging = await server.ssrLoadModule('/src/utils/logger.ts');

  // Execute the production formatter without mounting the desktop modal. The actual
  // install service, error class, store and locale resources remain loaded above.
  const file = 'src/components/InstallConfirmModal.tsx';
  const source = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const formatter = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'formatInstallError',
  );
  assert.ok(formatter, 'Missing production install-error formatter');
  const code = ts.transpileModule(`${formatter.getText(source)}; return formatInstallError;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  formatInstallError = new Function('UpdateInstallError', code)(service.UpdateInstallError);
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  storage.clear();
  storage.set(pendingKey, 'pending update');
  operations.length = 0;
  store.useAppStore.setState({ downloadStatus: 'completed', downloadSavePath: zipPath });
});

async function failedInstall() {
  let failure: unknown;
  await assert.rejects(
    service.installUpdate({ zipPath, targetDir: '/fixture/app', newVersion: '2.0.0' }),
    (error) => {
      failure = error;
      return error instanceof service.UpdateInstallError;
    },
  );
  assert.ok(failure instanceof service.UpdateInstallError);
  return failure;
}

for (const corrupt of [true, false]) {
  test(`gzip validation localizes the actual install failure in every locale (corrupt=${corrupt})`, async (context) => {
    extractionFailure = { code: 'gzipValidationFailed', message: rawDiagnostic, corrupt };
    const logged: unknown[][] = [];
    context.mock.method(logging.loggers.app, 'error', (...args: unknown[]) => logged.push(args));
    const error = await failedInstall();
    assert.equal(error.code, corrupt ? 'packageCorrupt' : 'extractFailed');
    assert.equal(error.detailCode, 'gzipValidationFailed');
    assert.equal(error.detail, rawDiagnostic, 'original diagnostics remain available to logging');
    assert.ok(logged.some((args) => args.includes(extractionFailure)));

    for (const [language, expectedDetail] of [
      ['en-US', 'Failed to validate the gzip archive'],
      ['zh-CN', 'gzip 压缩包校验失败'],
      ['zh-TW', 'gzip 壓縮檔驗證失敗'],
      ['ja-JP', 'gzip アーカイブの検証に失敗しました'],
      ['ko-KR', 'gzip 압축 파일 검증에 실패했습니다'],
    ]) {
      await localization.default.changeLanguage(language);
      const message = formatInstallError(error, localization.default.t);
      assert.ok(message.includes(expectedDetail), `${language}: ${message}`);
      assert.notEqual(
        message,
        expectedDetail,
        'the existing outer installation message is retained',
      );
      assert.ok(
        !message.includes(rawDiagnostic),
        'raw backend diagnostics stay out of localized UI',
      );
      assert.ok(!message.includes('gzipValidationFailed'), 'translation keys must resolve');
    }

    const expectedCommands = [
      'validate_update_target',
      'plugin:fs|exists',
      'plugin:path|dirname',
      'cleanup_extract_dir',
      'extract_zip',
      'cleanup_extract_dir',
      ...(corrupt ? ['move_file_to_old'] : []),
    ];
    assert.deepEqual(
      operations.map(({ command }) => command),
      expectedCommands,
    );
    if (corrupt) {
      assert.deepEqual(operations.at(-1)?.args, { filePath: zipPath });
      assert.equal(storage.has(pendingKey), false);
      assert.equal(store.useAppStore.getState().downloadStatus, 'idle');
      assert.equal(store.useAppStore.getState().downloadSavePath, null);
    } else {
      assert.equal(storage.get(pendingKey), 'pending update');
      assert.equal(store.useAppStore.getState().downloadStatus, 'completed');
      assert.equal(store.useAppStore.getState().downloadSavePath, zipPath);
      await failedInstall();
      assert.equal(operations.filter(({ command }) => command === 'extract_zip').length, 2);
      assert.ok(!operations.some(({ command }) => command === 'move_file_to_old'));
    }
  });
}

test('legacy payloads, plain errors and unrecognized codes retain their original detail', async () => {
  await localization.default.changeLanguage('en-US');
  for (const failure of [
    { message: 'legacy diagnostic', corrupt: false },
    { message: 'legacy diagnostic', corrupt: false, code: 'futureValidationFailed' },
    'legacy diagnostic',
    new Error('legacy diagnostic'),
  ]) {
    extractionFailure = failure;
    const error = await failedInstall();
    assert.equal(error.code, 'extractFailed');
    assert.equal(error.detailCode, undefined);
    assert.equal(error.detail, 'legacy diagnostic');
    assert.equal(
      formatInstallError(error, localization.default.t),
      'Failed to extract the update package. It may have been blocked by security software. (legacy diagnostic)',
    );
  }
  assert.equal(
    formatInstallError(new Error('ordinary failure'), localization.default.t),
    'ordinary failure',
  );
  assert.equal(formatInstallError('plain failure', localization.default.t), 'plain failure');
});
