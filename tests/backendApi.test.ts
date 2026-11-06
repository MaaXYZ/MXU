import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, getApiBase, getWebSocketUrl, setBackendPort } from '../src/utils/backendApi.ts';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

after(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  setBackendPort(0);
});

function openPage(href: string, tauri = false) {
  globalThis.window = {
    location: new URL(href),
    ...(tauri ? { __TAURI__: {} } : {}),
  } as unknown as Window & typeof globalThis;
  setBackendPort(0);
}

test('browser HTTP and WebSocket stay on the public origin for direct, proxy and Vite access', async () => {
  for (const [page, websocket] of [
    ['http://localhost:12701/', 'ws://localhost:12701/api/ws'],
    ['http://localhost:1420/', 'ws://localhost:1420/api/ws'],
    ['http://example.com/', 'ws://example.com/api/ws'],
    ['https://example.com/', 'wss://example.com/api/ws'],
    ['https://example.com:8443/settings', 'wss://example.com:8443/api/ws'],
    ['https://[::1]:8443/', 'wss://[::1]:8443/api/ws'],
  ]) {
    openPage(page);
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      // The server may listen on a completely different, private port.
      return new Response(JSON.stringify({ webServerPort: 12702 }));
    };
    assert.equal(getApiBase(), '/api');
    await apiGet('/interface');
    await apiGet('/config');
    assert.deepEqual(requests, ['/api/interface', '/api/config']);
    assert.equal(getWebSocketUrl(), websocket);
  }
});

test('a successfully probed HTTP backend supplies both HTTP and WebSocket addresses', () => {
  openPage('http://192.0.2.10:1420/');
  setBackendPort(12703);
  assert.equal(getApiBase(), 'http://192.0.2.10:12703/api');
  assert.equal(getWebSocketUrl(), 'ws://192.0.2.10:12703/api/ws');

  // A fresh interface load first retries the public origin.
  setBackendPort(0);
  assert.equal(getApiBase(), '/api');
  assert.equal(getWebSocketUrl(), 'ws://192.0.2.10:1420/api/ws');
});

test('Tauri development and production origins use the local plain HTTP backend', () => {
  for (const page of [
    'http://localhost:1420/',
    'tauri://localhost/',
    'http://tauri.localhost/',
    'https://tauri.localhost/',
  ]) {
    openPage(page, true);
    assert.equal(getApiBase(), 'http://127.0.0.1:12701/api');
    setBackendPort(12705);
    assert.equal(getApiBase(), 'http://127.0.0.1:12705/api');
    assert.equal(getWebSocketUrl(), 'ws://127.0.0.1:12705/api/ws');
  }
});

test('pages without a host keep the default local backend fallback', () => {
  openPage('file:///tmp/index.html');
  assert.equal(getApiBase(), 'http://127.0.0.1:12701/api');
  assert.equal(getWebSocketUrl(), 'ws://127.0.0.1:12701/api/ws');
});
