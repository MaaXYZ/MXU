import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigDrafts } from '../src/utils/configDrafts.ts';
import { ConfigSync } from '../src/utils/configSync.ts';

type Config = { instances: string[] };
const valid = (value: unknown): value is Config =>
  !!value && Array.isArray((value as Config).instances);
function storage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test('closing during an in-flight save preserves the newest edit across a fresh page session', async () => {
  const local = storage();
  const drafts = new ConfigDrafts(() => local, valid);
  let finish!: (snapshot: { config: Config; revision: string }) => void;
  const client = new ConfigSync<Config>(
    'browser',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => {},
  );
  client.adopt({ config: { instances: ['host'] }, revision: 'r0' });
  const saving = client.save({ instances: ['first edit'] });
  await Promise.resolve();
  const latest = { instances: ['latest edit before close'] };
  drafts.save(latest, 'project', client.clientId);
  assert.equal(client.unloadRequest(latest), null);
  finish({ config: { instances: ['first edit'] }, revision: 'r1' });
  await saving;
  const restored = new ConfigDrafts(() => local, valid).list('project', (config) =>
    client.hasChanges(config),
  );
  assert.deepEqual(
    restored.map((draft) => draft.config),
    [latest],
  );
});

test('external updates keep each client draft independent and never automatically rebase it', () => {
  const local = storage();
  const drafts = new ConfigDrafts(() => local, valid);
  drafts.save({ instances: ['a edit'] }, 'project', 'a');
  drafts.save({ instances: ['b edit'] }, 'project', 'b');
  drafts.save({ instances: ['other project edit'] }, 'other-project', 'a');
  const client = new ConfigSync<Config>(
    'a',
    async () => assert.fail('draft must not upload'),
    () => {},
  );
  client.adopt({ config: { instances: ['new host tab'] }, revision: 'r2' });
  const recovered = drafts.list('project', (config) => client.hasChanges(config));
  assert.deepEqual(
    recovered.map((draft) => draft.config.instances),
    [['a edit'], ['b edit']],
  );
});

test('an earlier save response cannot erase a newer pending draft; accepted drafts are cleaned up', () => {
  const local = storage();
  const drafts = new ConfigDrafts(() => local, valid);
  const client = new ConfigSync<Config>(
    'a',
    async () => assert.fail(),
    () => {},
  );
  const old = drafts.save({ instances: ['first'] }, 'project', 'a');
  drafts.save({ instances: ['newest'] }, 'project', 'a');
  client.adopt({ config: old.config, revision: 'r1' });
  drafts.removeIfSaved(old.key, (config) => client.hasChanges(config));
  assert.equal(drafts.list('project', (config) => client.hasChanges(config)).length, 1);
  client.adopt({ config: { instances: ['newest'] }, revision: 'r2' });
  assert.equal(drafts.list('project', (config) => client.hasChanges(config)).length, 0);
});

test('draft recovery keeps the persisted password and CDK representation without plaintext copies', async () => {
  const { encryptPasswordOptionValues } = await import('../src/utils/passwordOptionValues.ts');
  const { encryptCdk } = await import('../src/utils/cdkCrypto.ts');
  const local = storage();
  const password = 'private-input-token';
  const cdk = 'private-update-cdk';
  const persisted = {
    instances: ['a'],
    optionValues: encryptPasswordOptionValues(
      { credentials: { type: 'input', values: { token: password } } },
      { credentials: { type: 'input', inputs: [{ name: 'token', password: true }] } },
      'project',
    ),
    settings: { mirrorChyan: { cdk: '', cdkEncrypted: encryptCdk(cdk, 'project') } },
  };
  const drafts = new ConfigDrafts(() => local, valid);
  const draft = drafts.save(persisted, 'project', 'a');
  const stored = local.getItem(draft.key)!;
  assert.equal(stored.includes(password), false);
  assert.equal(stored.includes(cdk), false);
  assert.deepEqual(drafts.list('project', () => true)[0].config, persisted);
});
