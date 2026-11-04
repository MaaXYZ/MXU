import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('preview persistence, fallback recovery, legacy migration and storage-denied unload use actual config services', async () => {
  const data = new Map<string, string>();
  let denied = false;
  const storage = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (denied) throw new Error('quota exceeded');
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const events = new EventTarget();
  Object.assign(globalThis, {
    window: Object.assign(events, {
      location: {
        href: 'http://localhost/',
        host: 'localhost',
        protocol: 'http:',
        hostname: 'localhost',
      },
    }),
    localStorage: storage,
  });
  const originalFetch = globalThis.fetch;
  let host = false;
  let writes = 0;
  const local = { version: '1.0', instances: [], settings: { confirmBeforeDelete: false } };
  const authoritative = { ...local, settings: { confirmBeforeDelete: true } };
  data.set('mxu-config-project', JSON.stringify(local));
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      return Response.json({ config: JSON.parse(init.body as string).config, revision: 'r3' });
    }
    return host
      ? Response.json({ config: authoritative, revision: 'r1' })
      : new Response('offline', { status: 503 });
  };
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const service: typeof import('../src/services/configService.ts') = await server.ssrLoadModule(
      '/src/services/configService.ts',
    );
    assert.deepEqual(await service.loadConfig('/preview', 'project'), local);
    assert.equal(service.hasBackendConfig(), false);
    service.markFallbackConfigReady(local);
    assert.equal(service.preserveUnsavedConfig(local, 'project'), null);
    const edited = { ...local, settings: { confirmBeforeDelete: false, maxLogsPerInstance: 123 } };
    assert.equal(await service.saveConfig('/preview', edited, 'project'), true);
    assert.deepEqual(JSON.parse(data.get('mxu-config-project')!), edited);
    assert.deepEqual(service.preserveUnsavedConfig(edited, 'project')?.config, edited);
    assert.equal(writes, 0, 'fallback edits must never be uploaded without a host revision');

    host = true;
    assert.deepEqual(
      await service.loadConfig('/preview', 'project'),
      authoritative,
      'an empty authoritative host config must take priority over the old local cache',
    );
    assert.equal(service.loadConfigFromStorage('project'), null);
    const recovered = service.getUnsavedConfigDrafts('project');
    assert.ok(recovered.some((draft) => draft.key.endsWith('-legacy')));
    assert.ok(recovered.every((draft) => JSON.stringify(draft.config) === JSON.stringify(edited)));
    assert.equal(
      data.has('mxu-config-project'),
      false,
      'legacy cache is removed only after durable draft migration',
    );
    assert.equal(writes, 0);

    const conflictedEdit = {
      ...authoritative,
      settings: { confirmBeforeDelete: false, maxLogsPerInstance: 456 },
    };
    const oldDraft = service.preserveUnsavedConfig(conflictedEdit, 'project')!;
    service.acceptConfigSnapshot({ config: authoritative, revision: 'r2' });
    assert.equal(
      await service.saveConfig(
        '/preview',
        { ...authoritative, settings: { confirmBeforeDelete: true, maxLogsPerInstance: 789 } },
        'project',
      ),
      true,
    );
    assert.ok(
      service
        .getUnsavedConfigDrafts('project')
        .some(
          (draft) => draft.key === oldDraft.key && draft.config.settings.maxLogsPerInstance === 456,
        ),
      'editing and saving after accepting a new host revision must not erase the conflict recovery draft',
    );

    denied = true;
    let notices = 0;
    events.addEventListener('config-draft-unavailable', () => {
      notices++;
    });
    assert.equal(service.saveConfigForUnload(edited, 'project'), false);
    assert.equal(service.hasVolatileConfigDrafts(), true);
    assert.equal(notices, 1);
    assert.ok(
      service
        .getUnsavedConfigDrafts('project')
        .some((draft) => draft.config.settings.maxLogsPerInstance === 123),
    );
    denied = false;
    assert.equal(
      await service.saveConfig('/preview', edited, 'project'),
      true,
      'canceling an unload with unavailable draft storage must leave later saves enabled',
    );
    assert.equal(service.hasVolatileConfigDrafts(), false);
  } finally {
    await server.close();
    globalThis.fetch = originalFetch;
  }
});

test('a failed initial WS handshake reloads a fresh snapshot on its first successful recovery', async () => {
  let reloads = 0;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    static sockets: FakeSocket[] = [];
    readyState = FakeSocket.CONNECTING;
    constructor(_url: string) {
      super();
      FakeSocket.sockets.push(this);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
    }
    open() {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    }
  }
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), {
      location: {
        href: 'http://localhost/',
        host: 'localhost',
        protocol: 'http:',
        hostname: 'localhost',
        reload: () => {
          reloads++;
        },
      },
    }),
    WebSocket: FakeSocket,
  });
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  const ws: typeof import('../src/services/wsService.ts') = await server.ssrLoadModule(
    '/src/services/wsService.ts',
  );
  try {
    const connections: boolean[] = [];
    const unlisten = ws.onConnectionStatus((connected) => {
      connections.push(connected);
    });
    ws.connect();
    FakeSocket.sockets[0].close();
    assert.equal(ws.hasConnectedBefore(), false);
    ws.connect();
    FakeSocket.sockets[1].open();
    assert.equal(reloads, 1, 'recovery must reload even though no prior handshake succeeded');
    assert.equal(ws.isConnected(), true);
    assert.deepEqual(
      connections,
      [false, true],
      'a canceled reload must still dismiss the disconnect overlay and start snapshot refresh',
    );
    unlisten();
  } finally {
    ws.disconnect();
    await server.close();
  }
});
