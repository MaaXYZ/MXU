import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LogEntry } from '../src/stores/types.ts';
import {
  flushPendingRuntimeLogs,
  loadPersistedRuntimeLogs,
  persistRuntimeLogs,
} from '../src/utils/runtimeLogPersistence.ts';

const STORAGE_KEY = 'mxu.runtime-logs.v1';
const MAX_PERSISTED_LOGS_CHARS = 2_000_000;

class MemoryStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

function installBrowserStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storage,
    setTimeout,
    clearTimeout,
  };
  return storage;
}

function makeEntry(index: number, message: string, html?: string): LogEntry {
  return {
    id: `log-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    type: 'info',
    message,
    html,
  };
}

function storedPayload(storage: MemoryStorage): string {
  const raw = storage.getItem(STORAGE_KEY);
  assert.ok(raw, '持久化内容应写入 localStorage');
  return raw;
}

test('small runtime logs persist and load unchanged', () => {
  const storage = installBrowserStorage();
  const logs = { instance: [makeEntry(0, 'started'), makeEntry(1, 'done')] };

  persistRuntimeLogs(logs, 500);
  flushPendingRuntimeLogs();

  const loaded = loadPersistedRuntimeLogs(500);
  assert.equal(loaded.instance.length, 2);
  assert.equal(loaded.instance[0].message, 'started');
  storage.clear();
});

test('a single multi-megabyte html payload is dropped while its message survives', () => {
  const storage = installBrowserStorage();
  const logs = {
    instance: [makeEntry(0, '物品图标', `data:image/png;base64,${'x'.repeat(3_000_000)}`)],
  };

  persistRuntimeLogs(logs, 500);
  flushPendingRuntimeLogs();

  const payload = storedPayload(storage);
  assert.ok(payload.length < 100_000, `超大 html 不应进入持久化，实际 ${payload.length}`);

  const loaded = loadPersistedRuntimeLogs(500);
  assert.equal(loaded.instance[0].message, '物品图标');
  assert.equal(loaded.instance[0].html, undefined);
  storage.clear();
});

test('oversized html below the total budget is kept', () => {
  const storage = installBrowserStorage();
  const html = `<p>${'y'.repeat(1000)}</p>`;

  persistRuntimeLogs({ instance: [makeEntry(0, 'ok', html)] }, 500);
  flushPendingRuntimeLogs();

  const loaded = loadPersistedRuntimeLogs(500);
  assert.equal(loaded.instance[0].html, html);
  storage.clear();
});

test('an individually oversized message is truncated instead of bypassing the budget', () => {
  const storage = installBrowserStorage();

  persistRuntimeLogs({ instance: [makeEntry(0, 'm'.repeat(3_000_000))] }, 500);
  flushPendingRuntimeLogs();

  const payload = storedPayload(storage);
  assert.ok(payload.length <= MAX_PERSISTED_LOGS_CHARS, `持久化体积超出预算: ${payload.length}`);

  const loaded = loadPersistedRuntimeLogs(500);
  assert.ok(loaded.instance[0].message.length <= 64 * 1024 + 1);
  storage.clear();
});

test('reserved instance ids cannot break trimming', () => {
  const storage = installBrowserStorage();
  const entries = Array.from({ length: 900 }, (_, index) =>
    makeEntry(index, `${index}`.padEnd(5000, 'z')),
  );
  const logs = Object.fromEntries([
    ['__proto__', entries],
    ['constructor', entries],
  ]);

  assert.doesNotThrow(() => {
    persistRuntimeLogs(logs, 10000);
    flushPendingRuntimeLogs();
  });
  assert.ok(storedPayload(storage).length <= MAX_PERSISTED_LOGS_CHARS);
  storage.clear();
});

test('equal timestamps prefer later entries when trimming', () => {
  const storage = installBrowserStorage();
  const at = new Date(2026, 0, 1).getTime();
  const entries = Array.from({ length: 50 }, (_, index) => ({
    id: `log-${index}`,
    timestamp: new Date(at),
    type: 'info' as const,
    message: `${index}`.padEnd(100_000, 'q'),
  }));

  persistRuntimeLogs({ instance: entries }, 10000);
  flushPendingRuntimeLogs();

  const loaded = loadPersistedRuntimeLogs(10000);
  assert.ok(loaded.instance.length >= 25, `保留条数不足: ${loaded.instance.length}`);
  assert.equal(loaded.instance.at(-1)?.id, 'log-49');
  assert.ok(!loaded.instance.some((entry) => entry.id === 'log-0'));
  storage.clear();
});

test('total persisted size stays within budget while the newest logs win', () => {
  const storage = installBrowserStorage();
  const entries = Array.from({ length: 900 }, (_, index) =>
    makeEntry(index, `${index}`.padEnd(5000, 'z')),
  );

  persistRuntimeLogs({ instance: entries }, 10000);
  flushPendingRuntimeLogs();

  const payload = storedPayload(storage);
  assert.ok(payload.length <= MAX_PERSISTED_LOGS_CHARS, `持久化体积超出预算: ${payload.length}`);

  const loaded = loadPersistedRuntimeLogs(10000);
  const kept = loaded.instance;
  assert.ok(kept.length >= 380, `保留条数不足: ${kept.length}`);
  assert.equal(kept[kept.length - 1].id, 'log-899');
  assert.notEqual(kept[0].id, 'log-0');
  assert.ok(kept.every((entry) => entry.message.length >= 5000));
  storage.clear();
});
