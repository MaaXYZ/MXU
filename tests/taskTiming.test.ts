import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskDuration } from '../src/utils/taskTiming.ts';

test('task duration distinguishes sub-second execution and formats long tasks without wrapping', () => {
  assert.equal(formatTaskDuration(0), '0:00.000');
  assert.equal(formatTaskDuration(12), '0:00.012');
  assert.equal(formatTaskDuration(999), '0:00.999');
  assert.equal(formatTaskDuration(1000), '0:01');
  assert.equal(formatTaskDuration(65_432), '1:05');
  assert.equal(formatTaskDuration(3_723_000), '1:02:03');
  assert.equal(formatTaskDuration(90_000_000), '25:00:00');
});
