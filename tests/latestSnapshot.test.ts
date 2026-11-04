import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshotLoader } from '../src/utils/latestSnapshot.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('older running and empty snapshots cannot replace a completed task timing', async () => {
  const load = createSnapshotLoader();
  const empty = deferred<{ startedAt: number | null; durationMs: number | null }>();
  const running = deferred<{ startedAt: number | null; durationMs: number | null }>();
  const completed = deferred<{ startedAt: number | null; durationMs: number | null }>();
  const first = load(() => empty.promise);
  const second = load(() => running.promise);
  const third = load(() => completed.promise);
  completed.resolve({ startedAt: 1000, durationMs: 500 });
  assert.deepEqual(await third, { startedAt: 1000, durationMs: 500 });
  running.resolve({ startedAt: 1000, durationMs: null });
  empty.resolve({ startedAt: null, durationMs: null });
  assert.equal(await second, null);
  assert.equal(await first, null);
});

test('a failed newer refresh does not discard the last usable earlier response', async () => {
  const load = createSnapshotLoader();
  const older = deferred<number>();
  const newer = deferred<number>();
  const first = load(() => older.promise);
  const second = load(() => newer.promise);
  newer.reject(new Error('offline'));
  await assert.rejects(second, /offline/);
  older.resolve(1);
  assert.equal(await first, 1);
});

test('fresh snapshots may clear times for a new run or a restarted backend', async () => {
  const load = createSnapshotLoader();
  assert.deepEqual(await load(async () => ({ timings: { task: 500 } })), {
    timings: { task: 500 },
  });
  assert.deepEqual(await load(async () => ({ timings: {} })), { timings: {} });
  assert.deepEqual(await load(async () => ({ timings: { task: 20 } })), {
    timings: { task: 20 },
  });
});
