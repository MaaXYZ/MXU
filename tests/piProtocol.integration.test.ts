import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let pipeline: typeof import('../src/utils/pipelineOverride.ts');
let pretasks: typeof import('../src/types/pretasks.ts');
let helpers: typeof import('../src/stores/helpers.ts');
let store: typeof import('../src/stores/appStore.ts');
let focus: typeof import('../src/stores/focusStore.ts');
let secrets: typeof import('../src/utils/logSecrets.ts');
let maa: typeof import('../src/services/maaService.ts');
let controllers: typeof import('../src/utils/controller.ts');

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
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(tmpdir(), `mxu-pi-tests-${process.pid}`),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    resolve: { alias: { '@': join(root, 'src') } },
  });
  pipeline = await server.ssrLoadModule('/src/utils/pipelineOverride.ts');
  pretasks = await server.ssrLoadModule('/src/types/pretasks.ts');
  helpers = await server.ssrLoadModule('/src/stores/helpers.ts');
  store = await server.ssrLoadModule('/src/stores/appStore.ts');
  focus = await server.ssrLoadModule('/src/stores/focusStore.ts');
  secrets = await server.ssrLoadModule('/src/utils/logSecrets.ts');
  maa = await server.ssrLoadModule('/src/services/maaService.ts');
  controllers = await server.ssrLoadModule('/src/utils/controller.ts');
});
after(async () => {
  await server?.close();
});

const project = () => ({
  interface_version: 2 as const,
  name: 'test',
  controller: [{ name: 'Desktop', type: 'Win32' as const }],
  resource: [{ name: 'Base', path: ['./resource'] }],
  task: [{ name: 'Run', entry: 'Node', option: ['Parent'] }],
  option: {
    Parent: {
      type: 'checkbox' as const,
      default_case: ['A', 'B'],
      cases: [
        { name: 'A', option: ['ChildA'], pipeline_override: { Node: { order: 'A' } } },
        { name: 'B', option: ['ChildB'], pipeline_override: { Node: { order: 'B' } } },
      ],
    },
    ChildA: {
      type: 'input' as const,
      inputs: [{ name: 'count', default: '1', pipeline_type: 'int' as const }],
      pipeline_override: { Node: { count: '{count}' } },
    },
    ChildB: {
      type: 'input' as const,
      controller: ['Other'],
      inputs: [{ name: 'text', default: 'hidden' }],
      pipeline_override: { Node: { hidden: '{text}' } },
    },
  },
  pretask: [
    { name: 'Prepare', exec: 'python', option: ['Parent'] },
    { name: 'Check', exec: 'python' },
  ],
  preset: [
    { name: 'Daily', task: [{ name: 'Run' }] },
    { name: 'Explicit', pretask: [{ name: 'Check', enabled: true }] },
  ],
});

beforeEach(() => {
  store?.useAppStore.setState({
    projectInterface: null,
    instances: [],
    selectedController: {},
    selectedResource: {},
    globalOptionValues: {},
    configPersistenceReady: false,
  });
  focus?.useFocusStore.setState({ dialogs: [], closed: new Set() });
});

test('checkbox 子选项按 case 定义顺序递归生成覆盖，并跳过不适用的子项', () => {
  const pi = project();
  const values = helpers.initializeAllOptionValues(['Parent'], pi.option);
  assert.equal(values.ChildA.type, 'input');
  values.Parent = { type: 'checkbox', caseNames: ['B', 'A'] };
  values.ChildA = { type: 'input', values: { count: '42' } };
  const task = { id: 't', taskName: 'Run', enabled: true, expanded: true, optionValues: values };
  assert.deepEqual(JSON.parse(pipeline.generateTaskPipelineOverride(task, pi, 'Desktop', 'Base')), [
    { Node: { order: 'A' } },
    { Node: { count: 42 } },
    { Node: { order: 'B' } },
  ]);
  assert.deepEqual(
    JSON.parse(pretasks.serializePretaskOptions(pi.pretask[0], values, pi, 'Desktop', 'Base')!),
    { Parent: ['A', 'B'], ChildA: { count: '42' } },
  );
});

test('共享桌面和 Linux 控制器构建保留 PI 缩放，Gamepad 保留型号与截图方法', () => {
  for (const type of ['Win32', 'MacOS', 'Gamepad'] as const) {
    const config = controllers.buildDesktopWindowControllerConfig(
      {
        name: type,
        type,
        display_expand: [1920, 1080],
        gamepad: { gamepad_type: 'DualShock4', screencap: 'FramePool' },
      },
      42,
    );
    assert.deepEqual(config?.display_expand, [1920, 1080]);
    if (config?.type === 'Gamepad') {
      assert.equal(config.gamepad_type, 'DualShock4');
      assert.equal(config.screencap_method, 2);
    }
  }
  const defaultGamepad = controllers.buildDesktopWindowControllerConfig(
    { name: 'Gamepad', type: 'Gamepad' },
    42,
  );
  assert.equal(
    defaultGamepad?.type === 'Gamepad' ? defaultGamepad.screencap_method : null,
    undefined,
  );
  const linux = controllers.buildLinuxControllerConfig(
    { name: 'Linux', type: 'Linux', display_raw: true, linux: { screencap: 'Wlr', input: 'Wlr' } },
    { wlrSocketPath: '/run/wayland-0' },
  );
  assert.equal(linux.display_raw, true);
});

test('预设未指定 pretask 时保留已有 ID、勾选和参数；显式列表按声明顺序禁用未列出项', () => {
  const pi = project();
  store.useAppStore.getState().setProjectInterface(pi);
  const id = store.useAppStore.getState().createInstance();
  const original = store.useAppStore.getState().instances[0].selectedTasks;
  assert.equal(original.length, 2);
  assert.ok(original.every((task) => task.enabled));
  store.useAppStore.getState().applyPreset(id, 'Daily');
  assert.deepEqual(store.useAppStore.getState().instances[0].selectedTasks.slice(0, 2), original);
  store.useAppStore.getState().applyPreset(id, 'Explicit');
  const result = store.useAppStore.getState().instances[0].selectedTasks;
  assert.equal(result[0].taskName, pretasks.pretaskName(pi.pretask[0]));
  assert.equal(result[0].enabled, false);
  assert.equal(result[1].enabled, true);
});

test('focus 确认请求去重，确认先于异步内容加载完成时不会重新打开', () => {
  const dialog = {
    id: 'focus-session-1',
    instanceId: 'instance',
    message: 'Confirm',
    blocking: true,
  };
  focus.useFocusStore.getState().enqueue(dialog);
  focus.useFocusStore.getState().enqueue(dialog);
  assert.equal(focus.useFocusStore.getState().dialogs.length, 1);
  focus.useFocusStore.getState().close(dialog.id);
  focus.useFocusStore.getState().enqueue(dialog);
  assert.equal(focus.useFocusStore.getState().dialogs.length, 0);
});

test('密码在日志和 JSON 转义文本中脱敏，预任务调用仍收到原文且通过 HTTP 执行', async () => {
  const pi = project();
  pi.option = {
    ...pi.option,
    Login: { type: 'input', inputs: [{ name: 'token', password: true }] },
  } as typeof pi.option;
  const marker = 'unique-test-password\\"123';
  store.useAppStore.setState({
    projectInterface: pi,
    globalOptionValues: { Login: { type: 'input', values: { token: marker } } },
  });
  assert.equal(secrets.redactLogText(marker), '******');
  assert.equal(secrets.redactLogText(JSON.stringify(marker)), '"******"');
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ exitCode: 7 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const args = ['script.py', JSON.stringify({ token: marker })];
    assert.equal(await maa.maaService.runPretask('instance', 'python', args, '/project'), 7);
    assert.ok(requests[0].url.endsWith('/log-secrets'));
    assert.deepEqual(requests[1].body.args, args);
    assert.ok(requests[1].url.endsWith('/instance/pretask'));
    store.useAppStore.getState().addLog('instance', { type: 'info', message: marker });
    assert.equal(store.useAppStore.getState().instanceLogs.instance.at(-1)?.message, '******');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
