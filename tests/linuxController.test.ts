import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUinputDimension, hasValidUinputDimensions } from '../src/utils/linuxUinput.ts';

test('empty or malformed UInput sizes cannot reach the controller', () => {
  for (const input of ['', ' ', '0', '-1', '1.5', '1920px', 'Infinity', '2147483648']) {
    assert.equal(parseUinputDimension(input), undefined, input);
  }
});

test('UInput sizes are parsed without truncation', () => {
  assert.equal(parseUinputDimension(' 2560 '), 2560);
  assert.equal(parseUinputDimension('1440'), 1440);
  assert.equal(parseUinputDimension('2147483647'), 2147483647);
});

test('both UInput sizes must be positive signed 32-bit integers', () => {
  for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.equal(hasValidUinputDimensions(value, 1440), false);
    assert.equal(hasValidUinputDimensions(2560, value), false);
  }
  assert.equal(hasValidUinputDimensions(2560, 1440), true);
});

test('clearing one previously valid size invalidates the saved dimensions', () => {
  const saved = { width: parseUinputDimension('2560'), height: parseUinputDimension('1440') };
  assert.equal(hasValidUinputDimensions(saved.width, saved.height), true);
  saved.width = parseUinputDimension('');
  assert.equal(hasValidUinputDimensions(saved.width, saved.height), false);
});
