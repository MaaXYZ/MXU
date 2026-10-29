import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentWeekday, subscribeCurrentWeekday } from '../src/utils/currentWeekday.ts';
import { isTaskSelectedForRun } from '../src/utils/taskRunFilter.ts';

function setup(t, date) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: date.getTime() });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const unsubscribes = [];
  t.after(() => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  });
  return (listener) => {
    const unsubscribe = subscribeCurrentWeekday(listener);
    unsubscribes.push(unsubscribe);
    return unsubscribe;
  };
}

test('跨午夜通知所有订阅者，启动资格切换到新的一天', (t) => {
  const subscribe = setup(t, new Date(2026, 9, 14, 23, 59, 59));
  const task = { enabled: true, weeklySchedule: [4] };
  let canRun = isTaskSelectedForRun(task, getCurrentWeekday());
  let weekday = getCurrentWeekday();
  subscribe(() => {
    canRun = isTaskSelectedForRun(task, getCurrentWeekday());
  });
  subscribe(() => {
    weekday = getCurrentWeekday();
  });
  assert.equal(canRun, false);
  t.mock.timers.tick(1_000);
  assert.equal(weekday, 4);
  assert.equal(canRun, true);
});

test('休眠跨天后，窗口聚焦或恢复可见会立即刷新日期', (t) => {
  const subscribe = setup(t, new Date(2026, 9, 14, 12));
  const days = [];
  subscribe(() => days.push(getCurrentWeekday()));
  t.mock.timers.setTime(new Date(2026, 9, 15, 12).getTime());
  window.dispatchEvent(new Event('focus'));
  assert.deepEqual(days, [4]);
  t.mock.timers.setTime(new Date(2026, 9, 16, 12).getTime());
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(days, [4, 5]);
});

test('取消最后一个订阅后清理时钟和窗口监听，可以重新订阅', (t) => {
  const subscribe = setup(t, new Date(2026, 9, 14, 23, 59, 59));
  let calls = 0;
  const unsubscribe = subscribe(() => calls++);
  unsubscribe();
  t.mock.timers.tick(1_000);
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 0);
  subscribe(() => calls++);
  window.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1);
});
