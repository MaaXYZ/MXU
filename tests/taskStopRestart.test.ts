import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const instanceId = 'stop-restart-fixture';
const stopPath = `/api/maa/instances/${instanceId}/tasks/stop`;
const statePath = '/api/maa/state';
const originalWindow = globalThis.window;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let server: ViteDevServer;
let stop: typeof import('../src/services/taskStopService').stopInstanceTasks;
let store: typeof import('../src/stores/appStore').useAppStore;

before(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  globalThis.window = { location: new URL('http://fixture.invalid/') } as typeof window;
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true, ws: false, watch: null },
    appType: 'custom',
  });
  ({ useAppStore: store } = await server.ssrLoadModule('/src/stores/appStore.ts'));
  ({ stopInstanceTasks: stop } = await server.ssrLoadModule('/src/services/taskStopService.ts'));
});

after(async () => {
  await server?.close();
  globalThis.window = originalWindow;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function markRunning() {
  store.setState({
    instances: [{ id: instanceId, name: 'Fixture', isRunning: true, selectedTasks: [] }],
    instanceTaskStatus: { [instanceId]: 'Running' },
  });
}

function stateResponse(isRunning: boolean) {
  return Response.json({
    instances: { [instanceId]: { connected: true, resource_loaded: true, is_running: isRunning } },
  });
}

test(
  'overlapping Stop calls send one request, wait for idle, then allow another Stop',
  { timeout: 4000 },
  async (t) => {
    markRunning();
    let posts = 0;
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (url === stopPath && init?.method === 'POST') {
        posts++;
        return new Response(null, { status: 204 });
      }
      assert.equal(url, statePath);
      return stateResponse(++reads === 1);
    });
    assert.deepEqual(await Promise.all([stop(instanceId), stop(instanceId)]), [true, true]);
    assert.equal(posts, 1);
    assert.equal(reads, 2);
    assert.equal(store.getState().instances[0].isRunning, false);

    markRunning();
    assert.equal(await stop(instanceId), true);
    assert.equal(posts, 2);
  },
);

test(
  "an acknowledged Stop cannot stop a second client's new queue between polls",
  { timeout: 4000 },
  async (t) => {
    markRunning();
    let run = 'A';
    const stopped: string[] = [];
    let clock = 0;
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      if (url === stopPath && init?.method === 'POST') {
        stopped.push(run);
        // A is now idle. A second client starts B before the first state query.
        run = run === 'A' ? 'B' : 'idle';
        return new Response(null, { status: 204 });
      }
      assert.equal(url, statePath);
      clock += 4000;
      return stateResponse(run !== 'idle');
    });
    const result = await stop(instanceId);
    assert.deepEqual(stopped, ['A']);
    assert.equal(run, 'B');
    assert.equal(result, false, 'the instance never confirmed idle to this client');
    assert.equal(store.getState().instances[0].isRunning, true);
  },
);

test(
  'an unreachable Web backend cannot confirm that Stop succeeded',
  { timeout: 4000 },
  async (t) => {
    markRunning();
    t.mock.method(globalThis, 'fetch', async () => new Response('offline', { status: 503 }));
    await assert.rejects(stop(instanceId), /503/);
    assert.equal(store.getState().instances[0].isRunning, true);
    assert.equal(store.getState().instanceTaskStatus[instanceId], 'Running');
  },
);

test(
  'an acknowledged Stop waits past an unreadable snapshot until idle is confirmed',
  { timeout: 4000 },
  async (t) => {
    markRunning();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url === stopPath) return new Response(null, { status: 204 });
      assert.equal(url, statePath);
      reads++;
      return reads === 1 ? new Response('offline', { status: 503 }) : stateResponse(false);
    });
    assert.equal(await stop(instanceId), true);
    assert.equal(reads, 2);
  },
);
