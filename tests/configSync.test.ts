import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSync, type ConfigSaveRequest } from '../src/utils/configSync.ts';

type Config = { instances: string[] };
const initial = { config: { instances: ['desktop'] }, revision: 'r0' };

function server() {
  let snapshot = structuredClone(initial);
  const requests: ConfigSaveRequest<Config>[] = [];
  return {
    read: () => structuredClone(snapshot),
    requests,
    async write(request: ConfigSaveRequest<Config>) {
      requests.push(request);
      if (request.revision !== snapshot.revision) throw { code: 'conflict' };
      snapshot = { config: request.config, revision: `r${requests.length}` };
      return structuredClone(snapshot);
    },
  };
}

test('a suspended browser cannot overwrite changes made by the desktop on reconnect/unload', async () => {
  const backend = server();
  const browser = new ConfigSync('browser', backend.write, () => {});
  browser.adopt(backend.read());
  browser.suspend();
  await backend.write({
    config: { instances: ['desktop', 'new'] },
    revision: 'r0',
    client_id: 'desktop',
  });
  assert.equal(browser.unloadRequest(initial.config), null);
  assert.equal(await browser.save({ instances: ['old browser edit'] }), false);
  assert.deepEqual(backend.read().config.instances, ['desktop', 'new']);
  browser.adopt(backend.read());
  assert.equal(browser.unloadRequest(backend.read().config), null);
});

test('concurrent browsers reject a stale whole-config save and do not retry it against the new revision', async () => {
  const backend = server();
  let conflicts = 0;
  const a = new ConfigSync('a', backend.write, () => conflicts++);
  const b = new ConfigSync('b', backend.write, () => conflicts++);
  a.adopt(backend.read());
  b.adopt(backend.read());
  assert.equal(await a.save({ instances: ['a'] }), true);
  assert.equal(await b.save({ instances: ['b'] }), false);
  assert.equal(await b.save({ instances: ['b retry'] }), false);
  assert.equal(conflicts, 1);
  assert.deepEqual(backend.read().config.instances, ['a']);
  b.adopt(backend.read());
  assert.equal(await b.save({ instances: ['a', 'new b edit'] }), true);
});

test('rapid edits from one client are serialized using each accepted revision', async () => {
  const backend = server();
  const client = new ConfigSync('a', backend.write, () => assert.fail('unexpected conflict'));
  client.adopt(backend.read());
  assert.deepEqual(
    await Promise.all([client.save({ instances: ['one'] }), client.save({ instances: ['two'] })]),
    [true, true],
  );
  assert.deepEqual(
    backend.requests.map((request) => request.revision),
    ['r0', 'r1'],
  );
  assert.deepEqual(backend.read().config.instances, ['two']);
});

test('adopting an external snapshot cancels queued stale edits and ignores an older save response', async () => {
  let finish!: (value: typeof initial) => void;
  const writes: ConfigSaveRequest<Config>[] = [];
  const client = new ConfigSync<Config>(
    'a',
    (request) => {
      writes.push(request);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => {},
  );
  client.adopt(initial);
  const first = client.save({ instances: ['first'] });
  const second = client.save({ instances: ['stale queued'] });
  await Promise.resolve();
  await Promise.resolve();
  client.adopt({ config: { instances: ['external'] }, revision: 'r2' });
  finish({ config: { instances: ['first'] }, revision: 'r1' });
  await first;
  assert.equal(await second, false);
  assert.equal(writes.length, 1);
  assert.equal(client.unloadRequest({ instances: ['external'] }), null);
});

test('unchanged pages never send an unload write, while new edits carry their base revision', () => {
  const client = new ConfigSync<Config>(
    'a',
    async () => initial,
    () => {},
  );
  client.adopt(initial);
  assert.equal(client.unloadRequest({ instances: ['desktop'] }), null);
  client.adopt(initial);
  assert.deepEqual(client.unloadRequest({ instances: ['edited'] }), {
    config: { instances: ['edited'] },
    revision: 'r0',
    client_id: 'a',
  });
  assert.equal(client.unloadRequest({ instances: ['edited again'] }), null);
});

test('a public sender ID alone cannot hide an external change; own responses confirm the revision', async () => {
  const client = new ConfigSync(
    'a',
    async () => initial,
    () => {},
  );
  assert.equal(await client.isOwnChange({ client_id: 'b', revision: 'r1' }), false);
  assert.equal(await client.isOwnChange({ client_id: 'a', revision: 'r2' }), false);
  client.adopt(initial);
  await client.save({ instances: ['edited'] });
  assert.equal(await client.isOwnChange({ client_id: 'a', revision: 'r0' }), true);
  assert.equal(await client.isOwnChange({ client_id: 'a', revision: 'forged' }), false);
  client.adopt({ config: { instances: ['external B'] }, revision: 'rB' });
  assert.equal(
    await client.isOwnChange({ client_id: 'a', revision: 'r0' }),
    false,
    'returning to a previously acknowledged content hash must refresh the newer UI',
  );
});

test('an old in-flight acknowledgement cannot suppress an update after adopting another snapshot', async () => {
  let finish!: (snapshot: typeof initial) => void;
  const client = new ConfigSync<Config>(
    'a',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {},
  );
  client.adopt(initial);
  const save = client.save({ instances: ['A'] });
  await Promise.resolve();
  const notification = client.isOwnChange({ client_id: 'a', revision: 'rA' });
  await Promise.resolve();
  client.adopt({ config: { instances: ['B'] }, revision: 'rB' });
  finish({ config: { instances: ['A'] }, revision: 'rA' });
  await save;
  assert.equal(await notification, false);
});

test('an own broadcast arriving before the save response waits for the actual acknowledgement', async () => {
  let finish!: (snapshot: typeof initial) => void;
  const client = new ConfigSync<Config>(
    'a',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {},
  );
  client.adopt(initial);
  const save = client.save({ instances: ['edited'] });
  await Promise.resolve();
  const own = client.isOwnChange({ client_id: 'a', revision: 'r1' });
  const forged = client.isOwnChange({ client_id: 'a', revision: 'r2' });
  await Promise.resolve();
  finish({ config: { instances: ['edited'] }, revision: 'r1' });
  assert.equal(await own, true);
  assert.equal(await forged, false);
  assert.equal(await save, true);
});

test('persistent disk failures remain paused through snapshot/visibility refreshes until explicit retry', async () => {
  let writes = 0;
  let failures = 0;
  let full = true;
  const client = new ConfigSync<Config>(
    'a',
    async (request) => {
      writes++;
      if (full) throw { code: 'save_failed' };
      return { config: request.config, revision: 'r1' };
    },
    () => {
      failures++;
    },
  );
  client.adopt(initial);
  const edited = { instances: ['unsaved'] };
  assert.equal(await client.save(edited), false);
  for (let refresh = 0; refresh < 3; refresh++) {
    client.adopt(initial);
    assert.equal(await client.save(edited), false);
    assert.equal(client.unloadRequest(edited), null);
  }
  assert.equal(writes, 1);
  assert.equal(failures, 1);
  full = false;
  client.adopt(initial);
  client.retry();
  assert.equal(await client.save(edited), true);
  assert.equal(writes, 2);
});
