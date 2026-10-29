/**
 * 任务周计划（weeklySchedule）过滤逻辑的单测。
 *
 * 与 richText.test.ts 同样的理由：仓库没有前端测试框架，这里用 Node 内置
 * test runner，零依赖、可直接跑 `pnpm test`。
 * 被测模块 src/utils/taskRunFilter.ts 只 import type，因此无需 DOM / Tauri 环境。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterTasksForRun,
  getWeekdayOf,
  isTaskAllowedByWeeklySchedule,
  isTaskBlockedByWeeklySchedule,
  isTaskChecked,
  isTaskSelectedForRun,
  normalizeWeeklySchedule,
  createTaskRunSelection,
} from '../src/utils/taskRunFilter.ts';

const SUN = 0;
const MON = 1;
const WED = 3;

/** 构造最小可用的 SelectedTask（只填过滤逻辑关心的字段） */
function mk(id, opts = {}) {
  return {
    id,
    taskName: id,
    enabled: false,
    runOnce: false,
    optionValues: {},
    expanded: false,
    ...opts,
  };
}

const ids = (tasks) => tasks.map((t) => t.id);

test('启动参与快照只记录纳入和未纳入，不生成未纳入任务的执行结果', () => {
  const tasks = [
    mk('weekly', { enabled: true, weeklySchedule: [SUN] }),
    mk('daily', { enabled: true }),
  ];
  const result = filterTasksForRun(tasks, WED);
  const snapshot = createTaskRunSelection(result, WED);
  assert.deepEqual(snapshot, {
    weekday: WED,
    includedTaskIds: ['daily'],
    excludedByWeeklyScheduleIds: ['weekly'],
  });
  // 日期或列表变化不会改变已生成批次的参与范围。
  tasks[0].weeklySchedule = [WED];
  result.tasks.length = 0;
  assert.deepEqual(snapshot.includedTaskIds, ['daily']);
  assert.deepEqual(snapshot.excludedByWeeklyScheduleIds, ['weekly']);
});

test('周计划清理：保留有效整数、去重排序，且不修改输入', () => {
  const input = [WED, SUN, WED, 6, -1, 7, 1.5, '1', null, NaN, Infinity];
  assert.deepEqual(normalizeWeeklySchedule(input), [SUN, WED, 6]);
  assert.deepEqual(input, [WED, SUN, WED, 6, -1, 7, 1.5, '1', null, NaN, Infinity]);
  const tasks = [mk('mixed', { enabled: true, weeklySchedule: input })];
  assert.deepEqual(ids(filterTasksForRun(tasks, WED).tasks), ['mixed']);
  assert.deepEqual(ids(filterTasksForRun(tasks, MON).tasks), []);
});

test('无效周计划不抛异常或造成整周跳过，沿用未启用规则', () => {
  for (const weeklySchedule of [undefined, null, {}, '0', 0, [], [7, -1, 1.5, '3']]) {
    assert.equal(normalizeWeeklySchedule(weeklySchedule), undefined);
    const task = mk('invalid', { enabled: true, weeklySchedule });
    for (let day = 0; day <= 6; day++) {
      const result = filterTasksForRun([task], day);
      assert.deepEqual(ids(result.tasks), ['invalid']);
      assert.deepEqual(result.skippedByWeeklySchedule, []);
    }
  }
});

test('isTaskAllowedByWeeklySchedule：缺省 / 空数组视为未启用，一律放行', () => {
  assert.equal(isTaskAllowedByWeeklySchedule(mk('a'), WED), true);
  assert.equal(isTaskAllowedByWeeklySchedule(mk('a', { weeklySchedule: [] }), WED), true);
  assert.equal(isTaskAllowedByWeeklySchedule(mk('a', { weeklySchedule: [SUN, WED] }), WED), true);
  assert.equal(isTaskAllowedByWeeklySchedule(mk('a', { weeklySchedule: [SUN] }), WED), false);
});

test('isTaskChecked：enabled 与 runOnce 都算选中', () => {
  assert.equal(isTaskChecked(mk('a', { enabled: true })), true);
  assert.equal(isTaskChecked(mk('a', { runOnce: true })), true);
  assert.equal(isTaskChecked(mk('a')), false);
});

test('isTaskBlockedByWeeklySchedule：仅在「已勾选 + 今天不在计划内」时为真', () => {
  assert.equal(
    isTaskBlockedByWeeklySchedule(mk('a', { enabled: true, weeklySchedule: [SUN] }), WED),
    true,
  );
  // 今天在计划内
  assert.equal(
    isTaskBlockedByWeeklySchedule(mk('a', { enabled: true, weeklySchedule: [WED] }), WED),
    false,
  );
  // 未勾选的任务不属于「被跳过」
  assert.equal(
    isTaskBlockedByWeeklySchedule(mk('a', { enabled: false, weeklySchedule: [SUN] }), WED),
    false,
  );
  // 单次运行是显式意图，优先级高于周计划
  assert.equal(
    isTaskBlockedByWeeklySchedule(mk('a', { runOnce: true, weeklySchedule: [SUN] }), WED),
    false,
  );
  // 未启用周计划
  assert.equal(isTaskBlockedByWeeklySchedule(mk('a', { enabled: true }), WED), false);
});

test('isTaskSelectedForRun：勾选且周计划放行才执行', () => {
  assert.equal(isTaskSelectedForRun(mk('a', { enabled: true }), WED), true);
  assert.equal(isTaskSelectedForRun(mk('a', { enabled: true, weeklySchedule: [SUN] }), WED), false);
  assert.equal(
    isTaskSelectedForRun(mk('a', { enabled: false, weeklySchedule: [WED] }), WED),
    false,
  );
});

test('常规启动：部分任务被周计划跳过，其余照常执行', () => {
  const tasks = [
    mk('sun-only', { enabled: true, weeklySchedule: [SUN] }),
    mk('daily', { enabled: true }),
  ];
  const r = filterTasksForRun(tasks, WED);
  assert.deepEqual(ids(r.tasks), ['daily']);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), ['sun-only']);
});

test('常规启动：全部被跳过时 tasks 为空且 skipped 非空（供调用方走「正常结束」分支）', () => {
  const tasks = [
    mk('a', { enabled: true, weeklySchedule: [SUN] }),
    mk('b', { enabled: true, weeklySchedule: [MON] }),
  ];
  const r = filterTasksForRun(tasks, WED);
  assert.deepEqual(ids(r.tasks), []);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), ['a', 'b']);
});

test('常规启动：保持原始顺序', () => {
  const tasks = [
    mk('1', { enabled: true }),
    mk('2', { enabled: true, weeklySchedule: [SUN] }),
    mk('3', { enabled: true }),
  ];
  const r = filterTasksForRun(tasks, WED);
  assert.deepEqual(ids(r.tasks), ['1', '3']);
});

test('「从此处运行」：锚点为显式操作绕过周计划，锚点之后仍受约束', () => {
  const tasks = [
    mk('before', { enabled: true }),
    mk('before-skipped', { enabled: true, weeklySchedule: [SUN] }),
    mk('anchor', { enabled: true, weeklySchedule: [SUN] }),
    mk('mid', { enabled: true, weeklySchedule: [SUN] }),
    mk('daily', { enabled: true }),
  ];
  const r = filterTasksForRun(tasks, WED, { startFromTaskId: 'anchor' });
  assert.deepEqual(ids(r.tasks), ['anchor', 'daily']);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), ['mid']);
});

test('「从此处运行」：锚点不存在时返回空结果', () => {
  const r = filterTasksForRun([mk('a', { enabled: true })], WED, { startFromTaskId: 'zzz' });
  assert.deepEqual(ids(r.tasks), []);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), []);
});

test('「单独运行」：绕过周计划，且不产生跳过记录', () => {
  const tasks = [mk('a', { runOnce: true, weeklySchedule: [SUN] })];
  const r = filterTasksForRun(tasks, WED, { singleTaskId: 'a' });
  assert.deepEqual(ids(r.tasks), ['a']);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), []);
});

test('单次运行（runOnce）：常规启动与锚点之后的段落都绕过周计划', () => {
  const solo = filterTasksForRun([mk('a', { runOnce: true, weeklySchedule: [SUN] })], WED);
  assert.deepEqual(ids(solo.tasks), ['a']);
  assert.deepEqual(ids(solo.skippedByWeeklySchedule), []);

  // enabled 与 runOnce 同时为真
  const both = filterTasksForRun(
    [mk('b', { enabled: true, runOnce: true, weeklySchedule: [SUN] })],
    WED,
  );
  assert.deepEqual(ids(both.tasks), ['b']);

  // 锚点之后的 runOnce 任务同样绕过
  const afterAnchor = filterTasksForRun(
    [mk('anchor', { enabled: true }), mk('once', { runOnce: true, weeklySchedule: [SUN] })],
    WED,
    { startFromTaskId: 'anchor' },
  );
  assert.deepEqual(ids(afterAnchor.tasks), ['anchor', 'once']);
});

test('兼容性：未勾选 / 无字段 / 空数组均不产生跳过记录', () => {
  const tasks = [
    mk('off', { enabled: false, weeklySchedule: [SUN] }),
    mk('plain', { enabled: true }),
  ];
  const r = filterTasksForRun(tasks, WED);
  assert.deepEqual(ids(r.tasks), ['plain']);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), []);

  const empty = filterTasksForRun([mk('a', { enabled: true, weeklySchedule: [] })], WED);
  assert.deepEqual(ids(empty.tasks), ['a']);
  assert.deepEqual(ids(empty.skippedByWeeklySchedule), []);
});

test('边界：空任务列表', () => {
  const r = filterTasksForRun([], WED);
  assert.deepEqual(ids(r.tasks), []);
  assert.deepEqual(ids(r.skippedByWeeklySchedule), []);
});

test('getWeekdayOf：返回 Date.getDay()（0=周日）', () => {
  // 2026-10-14 是周三
  assert.equal(getWeekdayOf(new Date(2026, 9, 14, 12, 0, 0)), WED);
  assert.equal(getWeekdayOf(new Date(2026, 9, 18, 12, 0, 0)), SUN);
});
