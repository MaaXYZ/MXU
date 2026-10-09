import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlayCoverControllerConfig } from '../src/utils/playCoverController.ts';

test('PlayCover controller config keeps the configured UUID', () => {
  assert.deepEqual(buildPlayCoverControllerConfig('127.0.0.1:1717', 'custom.playcover', 720), {
    type: 'PlayCover',
    address: '127.0.0.1:1717',
    uuid: 'custom.playcover',
    display_short_side: 720,
  });
});

test('PlayCover controller config uses the manual-connect UUID fallback', () => {
  assert.deepEqual(buildPlayCoverControllerConfig('127.0.0.1:1717'), {
    type: 'PlayCover',
    address: '127.0.0.1:1717',
    uuid: 'maa.playcover',
    display_short_side: undefined,
  });
  assert.equal(buildPlayCoverControllerConfig('127.0.0.1:1717', '').uuid, 'maa.playcover');
});
