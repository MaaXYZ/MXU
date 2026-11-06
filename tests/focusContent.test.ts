import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let focus: typeof import('../src/utils/useMaaCallbackLogger.ts');
let store: typeof import('../src/stores/appStore.ts');
let maa: typeof import('../src/services/maaService.ts');
let secrets: typeof import('../src/utils/logSecrets.ts');

before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', hostname: 'localhost', host: 'localhost' } },
  });
  const rendererId = '\0focus-content-renderer';
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(tmpdir(), `mxu-focus-tests-${process.pid}`),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    resolve: {
      alias: [
        { find: /^@\/services\/contentResolver$/, replacement: rendererId },
        { find: '@', replacement: join(root, 'src') },
      ],
    },
    plugins: [
      {
        name: 'focus-test-renderer',
        resolveId: (id) => (id === rendererId ? rendererId : undefined),
        load: (id) =>
          id === rendererId
            ? `export * from '/src/services/contentResolver.ts';
               export async function markdownToHtmlWithLocalImages(markdown) {
                 return 'rendered:' + markdown;
               }`
            : undefined,
      },
    ],
  });
  // Keep content loading real and stub only the DOM-dependent rendering boundary.
  focus = await server.ssrLoadModule('/src/utils/useMaaCallbackLogger.ts');
  store = await server.ssrLoadModule('/src/stores/appStore.ts');
  maa = await server.ssrLoadModule('/src/services/maaService.ts');
  secrets = await server.ssrLoadModule('/src/utils/logSecrets.ts');
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  store.useAppStore.setState({
    language: 'en-US',
    basePath: '.',
    interfaceTranslations: {
      en_us: {
        localFocus: 'focus/{task_id}.md',
        inlineFocus: '{name} completed task {task_id}',
      },
    },
  });
  secrets.setLogSecretProvider(() => []);
});

test('focus resolves i18n before substituting inline placeholders', async () => {
  const resolved = await focus.resolveFocusContent('$inlineFocus', { name: 'Run', task_id: 42 });
  assert.deepEqual(resolved, { message: 'Run completed task 42' });
});

test('focus resolves translated file paths and placeholders inside loaded content', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response('{name} completed task {task_id}');
  });
  const resolved = await focus.resolveFocusContent('$localFocus', { name: 'Run', task_id: 42 });
  assert.deepEqual(requests, ['/api/local-file?path=focus%2F42.md']);
  assert.deepEqual(resolved, { message: 'Run completed task 42' });
});

test('focus redacts loaded content and callback values before rendering', async (t) => {
  const secret = 'focus-private-token';
  secrets.setLogSecretProvider(() => [secret]);
  t.mock.method(globalThis, 'fetch', async () => new Response(`File ${secret}; callback {token}`));
  const resolved = await focus.resolveFocusContent('$localFocus', { task_id: 42, token: secret });
  assert.equal(resolved.message, 'File ******; callback ******');
  assert.equal(resolved.html, `rendered:${resolved.message}`);
  assert.doesNotMatch(JSON.stringify(resolved), /focus-private-token/);
});

test('focus treats image as an ordinary callback placeholder without taking screenshots', async (t) => {
  const screenshot = t.mock.method(
    maa.maaService,
    'getCachedImage',
    async () => 'private-screenshot',
  );
  const literal = await focus.resolveFocusContent('Result {image}', {});
  assert.deepEqual(literal, { message: 'Result {image}' });
  const supplied = await focus.resolveFocusContent('Result {image}', { image: 'callback-image' });
  assert.deepEqual(supplied, { message: 'Result callback-image' });
  assert.equal(screenshot.mock.callCount(), 0);
});
