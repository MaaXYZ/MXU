import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPendingUpdateObsolete } from '../src/utils/pendingUpdateVersion.ts';

test('older full or incremental pending versions cannot replace a newer installation', () => {
  assert.equal(isPendingUpdateObsolete('v2.34.0', 'v2.35.0'), true);
  assert.equal(isPendingUpdateObsolete('v2.30.0', 'v2.35.0'), true);
});

test('same-version pending update is obsolete', () => {
  assert.equal(isPendingUpdateObsolete('v2.35.0', '2.35.0'), true);
  assert.equal(isPendingUpdateObsolete('2.35.0', 'v2.35.0'), true);
});

test('newer pending update continues through the existing install flow', () => {
  assert.equal(isPendingUpdateObsolete('v2.36.0', 'v2.35.0'), false);
  assert.equal(isPendingUpdateObsolete('v2.35.1', 'v2.35.0'), false);
});

test('SemVer prerelease precedence is respected', () => {
  assert.equal(isPendingUpdateObsolete('v2.35.0-beta.2', 'v2.35.0'), true);
  assert.equal(isPendingUpdateObsolete('v2.35.0-beta.1', 'v2.35.0-beta.2'), true);
  assert.equal(isPendingUpdateObsolete('v2.35.0-beta.2', 'v2.35.0-beta.1'), false);
  assert.equal(isPendingUpdateObsolete('v2.36.0-beta.1', 'v2.35.0'), false);
  assert.equal(isPendingUpdateObsolete('v2.35.0', 'v2.35.0-beta.3'), false);
});

test('unrecognized versions are not cleared by guesswork', () => {
  assert.equal(isPendingUpdateObsolete('nightly-42', 'v2.35.0'), false);
  assert.equal(isPendingUpdateObsolete('v2.34.0', 'nightly-43'), false);
  assert.equal(isPendingUpdateObsolete('', 'v2.35.0'), false);
  assert.equal(isPendingUpdateObsolete('v2.34.0', ''), false);
  assert.equal(isPendingUpdateObsolete(1, 'v2.35.0'), false);
  assert.equal(isPendingUpdateObsolete('v2.34.0', null), false);
});

test('normalized V prefixes and build metadata do not cause downgrades', () => {
  assert.equal(isPendingUpdateObsolete('V2.34.0', 'v2.35.0'), true);
  assert.equal(isPendingUpdateObsolete('v2.35.0+build.2', 'v2.35.0'), true);
});
