import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTaskClock,
  getTaskDurationParts,
  updateTaskTiming,
} from '../src/utils/taskTiming.ts';

test('entering running starts the timer and repeated running keeps it', () => {
  const started = updateTaskTiming(undefined, 'idle', 'running', 1000);
  assert.deepEqual(started, { startedAt: 1000 });

  const stillRunning = updateTaskTiming(started, 'running', 'running', 5000);
  assert.deepEqual(stillRunning, { startedAt: 1000 });
});

test('finishing a running task records the end time once', () => {
  const started = { startedAt: 1000 };
  const succeeded = updateTaskTiming(started, 'running', 'succeeded', 9000);
  assert.deepEqual(succeeded, { startedAt: 1000, finishedAt: 9000 });

  const repeated = updateTaskTiming(succeeded, 'succeeded', 'succeeded', 12000);
  assert.deepEqual(repeated, succeeded);
});

test('a task that finishes between snapshots gets a zero-duration record', () => {
  assert.deepEqual(updateTaskTiming(undefined, 'idle', 'succeeded', 1000), {
    startedAt: 1000,
    finishedAt: 1000,
  });
  assert.deepEqual(updateTaskTiming(undefined, 'pending', 'failed', 2000), {
    startedAt: 2000,
    finishedAt: 2000,
  });
});

test('stopping an instance closes a still-running timer', () => {
  const started = { startedAt: 1000 };
  assert.deepEqual(updateTaskTiming(started, 'running', 'running', 8000, { runningEnded: true }), {
    startedAt: 1000,
    finishedAt: 8000,
  });
});

test('idle and pending clear the previous timing', () => {
  const finished = { startedAt: 1000, finishedAt: 2000 };
  assert.equal(updateTaskTiming(finished, 'succeeded', 'idle', 3000), undefined);
  assert.equal(updateTaskTiming(finished, 'succeeded', 'pending', 3000), undefined);
});

test('duration parts keep hours, minutes and seconds', () => {
  assert.deepEqual(getTaskDurationParts(0), { hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(getTaskDurationParts(45_400), { hours: 0, minutes: 0, seconds: 45 });
  assert.deepEqual(getTaskDurationParts(187_000), { hours: 0, minutes: 3, seconds: 7 });
  assert.deepEqual(getTaskDurationParts(3_720_000), { hours: 1, minutes: 2, seconds: 0 });
  assert.deepEqual(getTaskDurationParts(-5000), { hours: 0, minutes: 0, seconds: 0 });
});

test('clock formatting uses local HH:mm:ss', () => {
  const local = new Date(2026, 0, 1, 9, 5, 7).getTime();
  assert.equal(formatTaskClock(local), '09:05:07');
});
