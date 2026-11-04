import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskConfig } from '../src/types/maa.ts';

let server: ViteDevServer;
let bridge: typeof import('../src/services/mcpBridge.ts');
let store: typeof import('../src/stores/appStore.ts');
let control: typeof import('../src/services/taskControlService.ts');
let maa: typeof import('../src/services/maaService.ts');
let pipeline: typeof import('../src/utils/pipelineOverride.ts');
before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'http:', hostname: 'localhost', host: 'localhost' },
    },
  });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(tmpdir(), 'mxu-mcp-tests-' + process.pid),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    resolve: { alias: { '@': join(root, 'src') } },
  });
  store = await server.ssrLoadModule('/src/stores/appStore.ts');
  bridge = await server.ssrLoadModule('/src/services/mcpBridge.ts');
  control = await server.ssrLoadModule('/src/services/taskControlService.ts');
  maa = await server.ssrLoadModule('/src/services/maaService.ts');
  pipeline = await server.ssrLoadModule('/src/utils/pipelineOverride.ts');
});
after(async () => {
  await server?.close();
});
beforeEach(() => {
  store.useAppStore.setState({
    projectInterface: {
      interface_version: 2,
      name: 'Example',
      controller: [{ name: 'Android', type: 'Adb' }],
      resource: [{ name: 'Official', path: ['./resource'] }],
      task: [
        { name: 'Run', entry: 'Node', default_check: true, option: ['Count'] },
        { name: 'Other', entry: 'OtherNode' },
      ],
      option: {
        Count: {
          type: 'input',
          inputs: [{ name: 'n', default: '1', pipeline_type: 'int' }],
          pipeline_override: { Node: { count: '{n}' } },
        },
      },
      pretask: { name: 'Prepare', exec: 'python' },
    },
    instances: [],
    selectedController: {},
    selectedResource: {},
    globalOptionValues: {},
    configPersistenceReady: false,
    mcpEnabled: true,
    mcpExecutionEnabled: true,
    mcpScreenshotEnabled: false,
    instanceConnectionStatus: {},
    instanceResourceLoaded: {},
  });
  store.useAppStore.getState().createInstance();
  control.taskControlService.setHandlers({ start: async () => true, stop: async () => true });
});
function call(op: string, args: Record<string, unknown> = {}) {
  return bridge.callPiMcpTool(op, args) as Record<string, any>;
}
function target() {
  return (call('list_instances').instances as Record<string, any>[])[0];
}
const code = (expected: string) => (reason: unknown) => {
  const detail = (reason as { detail?: { code?: string } })?.detail;
  return detail?.code === expected;
};
async function terminal(instance: string, run: string) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const state = call('get_run_status', { instance_id: instance, run_id: run });
    if (['failed', 'succeeded', 'stopped'].includes(state.state)) return state;
    assert.ok(Date.now() < deadline, 'run did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
test('discovery uses explicit instances and only PI tasks; cursors reject changed contexts', () => {
  const instance = target();
  assert.notEqual(instance.instance_id, store.useAppStore.getState().activeInstanceId);
  assert.throws(() => call('list_tasks'), code('instance_not_found'));
  const page = call('list_tasks', { instance_id: instance.instance_id, limit: 1 });
  assert.equal(page.tasks[0].name, 'Run');
  assert.ok(page.next_cursor);
  const rest = call('list_tasks', { instance_id: instance.instance_id, cursor: page.next_cursor });
  assert.deepEqual(
    rest.tasks.map((item: { name: string }) => item.name),
    ['Other'],
  );
  store.useAppStore.setState({
    globalOptionValues: { changed: { type: 'select', caseName: 'different' } },
  });
  assert.notEqual(target().context_revision, instance.context_revision);
  assert.throws(
    () => call('list_tasks', { instance_id: instance.instance_id, cursor: page.next_cursor }),
    code('stale_context'),
  );
  assert.throws(
    () =>
      call('start_tasks', {
        instance_id: instance.instance_id,
        context_revision: instance.context_revision,
        request_id: 'stale',
        tasks: [{ name: 'Run' }],
      }),
    code('stale_context'),
  );
});
test('PI execution does not reinterpret a project task as an MXU special task', () => {
  const pi = store.useAppStore.getState().projectInterface!;
  const name = '__MXU_SLEEP__';
  const task = { name, entry: 'ProjectNode', pipeline_override: { ProjectNode: { marker: true } } };
  const override = pipeline.generateTaskPipelineOverride(
    {
      id: 'temporary',
      taskName: name,
      enabled: true,
      expanded: false,
      optionValues: {},
    },
    { ...pi, task: [task] },
    'Android',
    'Official',
    {},
    true,
  );
  assert.deepEqual(JSON.parse(override), [{ ProjectNode: { marker: true } }]);
});
test('the real bridge runs an isolated snapshot and deduplicates after local configuration changes', async () => {
  const instance = target();
  const savedTasks = structuredClone(store.useAppStore.getState().instances[0].selectedTasks);
  let release!: () => void;
  const preparation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted: TaskConfig[] = [];
  let starts = 0;
  const originalStatus = maa.maaService.getTaskStatus;
  const originalRunning = maa.maaService.isRunning;
  maa.maaService.getTaskStatus = async () => 'Succeeded';
  maa.maaService.isRunning = async () => false;
  control.taskControlService.setHandlers({
    async start(snapshot, options) {
      starts++;
      await preparation;
      const context = options!.snapshot!;
      const configs = snapshot.selectedTasks
        .filter((task) => context.projectInterface!.task.some((def) => def.name === task.taskName))
        .map((task) => ({
          entry: context.projectInterface!.task.find((def) => def.name === task.taskName)!.entry,
          pipeline_override: pipeline.generateTaskPipelineOverride(
            task,
            context.projectInterface,
            context.controllerName,
            context.resourceName,
            context.globalOptionValues,
          ),
        }));
      await options!.executeTasks!(configs, async (tasks) => {
        submitted.push(...tasks);
        return [42];
      });
      return true;
    },
    stop: async () => true,
  });
  try {
    const request = {
      instance_id: instance.instance_id,
      context_revision: instance.context_revision,
      request_id: 'one-intent',
      tasks: [{ name: 'Run', option: { Count: { n: '42' } } }],
    };
    const accepted = call('start_tasks', request);
    assert.equal(accepted.state, 'starting');
    assert.equal(starts, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pi = store.useAppStore.getState().projectInterface!;
    store.useAppStore.setState({
      projectInterface: { ...pi, task: [{ ...pi.task[0], entry: 'ChangedNode' }, pi.task[1]] },
    });
    assert.equal(call('start_tasks', request).run_id, accepted.run_id);
    release();
    const result = await terminal(instance.instance_id, accepted.run_id);
    assert.equal(result.state, 'succeeded');
    assert.equal(starts, 1);
    assert.equal(submitted[0].entry, 'Node');
    assert.deepEqual(JSON.parse(submitted[0].pipeline_override), [{ Node: { count: 42 } }]);
    assert.deepEqual(store.useAppStore.getState().instances[0].selectedTasks, savedTasks);
    assert.deepEqual(result.tasks[0].option, { Count: { n: '42' } });
    store.useAppStore.setState({ mcpExecutionEnabled: false });
    assert.throws(() => call('start_tasks', request), code('permission_denied'));
  } finally {
    release();
    maa.maaService.getTaskStatus = originalStatus;
    maa.maaService.isRunning = originalRunning;
  }
});
test('failed backend admission never stops or cleans up another client run', async () => {
  const instance = target();
  let foreignStops = 0;
  const stop = maa.maaService.stopTask;
  const stopAgent = maa.maaService.stopAgent;
  maa.maaService.stopTask = async () => {
    foreignStops++;
  };
  maa.maaService.stopAgent = async () => {
    foreignStops++;
  };
  control.taskControlService.setHandlers({
    start: async () => {
      throw new Error('instance_busy');
    },
    stop: async () => true,
  });
  try {
    const run = call('start_tasks', {
      instance_id: instance.instance_id,
      context_revision: instance.context_revision,
      request_id: 'busy',
      tasks: [{ name: 'Run' }],
    });
    const result = await terminal(instance.instance_id, run.run_id);
    assert.equal(result.state, 'failed');
    assert.equal(result.error.code, 'instance_busy');
    assert.equal(foreignStops, 0);
  } finally {
    maa.maaService.stopTask = stop;
    maa.maaService.stopAgent = stopAgent;
  }
});
