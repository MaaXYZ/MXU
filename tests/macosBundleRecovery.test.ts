import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planBundleLayout } from '../scripts/macos-bundle-layout.mjs';
import { beginBundleRepair, recoverBundleRepair } from '../scripts/macos-bundle-state.mjs';

function writeBundle(bundle: string, contents = 'original') {
  fs.mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(join(bundle, 'Contents', '_CodeSignature'), { recursive: true });
  fs.writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist>host identity</plist>');
  fs.writeFileSync(join(bundle, 'Contents', 'MacOS', 'Host'), `${contents} executable`);
  fs.writeFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), `${contents} seal`);
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mxu-recovery-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'Host.app');
  writeBundle(bundle);
  const executable = join(bundle, 'Contents', 'MacOS', 'Host');
  const plan = planBundleLayout(bundle, 'Host', () => false);
  const transaction = beginBundleRepair(bundle, executable, true, plan);
  return { root, bundle, executable, transaction };
}

function assertBundleContents(bundle: string, contents: string) {
  assert.equal(
    fs.readFileSync(join(bundle, 'Contents', 'MacOS', 'Host'), 'utf8'),
    `${contents} executable`,
  );
  assert.equal(
    fs.readFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), 'utf8'),
    `${contents} seal`,
  );
}

test('interrupted signing can restore the same host even when codesign replaced its executable', (t) => {
  const { root, bundle, executable, transaction } = fixture(t);
  transaction.markSigning();
  fs.renameSync(executable, join(root, 'unsigned-executable'));
  fs.writeFileSync(executable, 'partially signed executable');
  fs.writeFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), 'partial seal');

  recoverBundleRepair(bundle);

  assertBundleContents(bundle, 'original');
  assert.equal(fs.existsSync(transaction.directory), false);
});

for (const phase of ['prepared', 'signing'] as const) {
  test(`a stale ${phase} journal never restores over a replacement app at the same path`, (t) => {
    const { root, bundle, transaction } = fixture(t);
    if (phase === 'signing') transaction.markSigning();
    // Keep the old inode alive and install a fresh app with the same bundle metadata.
    fs.renameSync(bundle, join(root, 'previous.app'));
    writeBundle(bundle, 'replacement');
    let restorationStarted = false;

    assert.throws(
      () => recoverBundleRepair(bundle, fs, () => (restorationStarted = true)),
      /Refusing to restore a different app/,
    );

    assert.equal(restorationStarted, false);
    assertBundleContents(bundle, 'replacement');
    assert.equal(fs.existsSync(transaction.directory), true);
    assert.equal(
      fs.readFileSync(join(transaction.directory, 'executable'), 'utf8'),
      'original executable',
    );
  });
}

for (const directory of ['Contents', join('Contents', 'MacOS')]) {
  test(`replacing ${directory} inside the existing app also prevents stale recovery`, (t) => {
    const { root, bundle, transaction } = fixture(t);
    transaction.markSigning();
    fs.renameSync(join(bundle, directory), join(root, 'previous-directory'));
    writeBundle(bundle, 'replacement');

    assert.throws(() => recoverBundleRepair(bundle), /Refusing to restore a different app/);

    assertBundleContents(bundle, 'replacement');
    assert.equal(fs.existsSync(transaction.directory), true);
  });
}

test('changed host metadata prevents recovery before any executable or signature is restored', (t) => {
  const { bundle, executable, transaction } = fixture(t);
  transaction.markSigning();
  const plist = join(bundle, 'Contents', 'Info.plist');
  fs.writeFileSync(plist, '<plist>replacement host identity</plist>');
  fs.writeFileSync(executable, 'replacement executable');
  fs.writeFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), 'replacement seal');

  assert.throws(() => recoverBundleRepair(bundle), /Refusing to restore a different app/);

  assertBundleContents(bundle, 'replacement');
  assert.equal(fs.readFileSync(plist, 'utf8'), '<plist>replacement host identity</plist>');
  assert.equal(fs.existsSync(transaction.directory), true);
});

test('replacing Info.plist with identical contents still prevents stale recovery', (t) => {
  const { root, bundle, executable, transaction } = fixture(t);
  transaction.markSigning();
  const plist = join(bundle, 'Contents', 'Info.plist');
  const originalContents = fs.readFileSync(plist);
  fs.renameSync(plist, join(root, 'previous-Info.plist'));
  fs.writeFileSync(plist, originalContents);
  fs.writeFileSync(executable, 'replacement executable');
  fs.writeFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), 'replacement seal');

  assert.throws(() => recoverBundleRepair(bundle), /Refusing to restore a different app/);

  assertBundleContents(bundle, 'replacement');
  assert.deepEqual(fs.readFileSync(plist), originalContents);
  assert.equal(fs.existsSync(transaction.directory), true);
});

test('legacy journals without a persisted host identity require manual recovery', (t) => {
  const { bundle, executable, transaction } = fixture(t);
  transaction.markSigning();
  const journal = join(transaction.directory, 'transaction.json');
  const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
  state.version = 1;
  delete state.identity;
  fs.writeFileSync(journal, JSON.stringify(state));
  fs.writeFileSync(executable, 'replacement executable');
  fs.writeFileSync(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'), 'replacement seal');

  assert.throws(() => recoverBundleRepair(bundle), /Invalid recovery journal/);

  assertBundleContents(bundle, 'replacement');
  assert.equal(fs.existsSync(transaction.directory), true);
});
