import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContainerAttachOverride, CONTAINER_TASKS } from '../src/types/containerTasks.ts';
import {
  normalizeContainerTasks,
  planTaskReorder,
  reconcileContainerTasks,
} from '../src/utils/taskContainer.ts';
import type { SelectedTask } from '../src/types/interface.ts';

const DEF = CONTAINER_TASKS.CombatProtocol;

const task = (id: string, taskName: string, parentId?: string): SelectedTask => ({
  id,
  taskName,
  enabled: true,
  optionValues: {},
  expanded: false,
  parentId,
});

test('归一化：子任务收拢为紧随容器之后的连续块（同型多条目保留）', () => {
  const input = [
    task('c', 'CombatProtocol'),
    task('n1', 'DailyRewards'),
    task('ch2', 'ProtocolSpace', 'c'),
    task('n2', 'CloseGame'),
    task('ch3', 'ProtocolSpace', 'c'),
    task('ch1', 'AutoEssence', 'c'),
  ];
  const out = normalizeContainerTasks(input);
  assert.deepEqual(
    out.map((t) => t.id),
    ['c', 'ch2', 'ch3', 'ch1', 'n1', 'n2'],
  );
});

test('归一化：子任务出现在容器之前视为移出容器', () => {
  const input = [task('ch', 'AutoEssence', 'c'), task('c', 'CombatProtocol')];
  const out = normalizeContainerTasks(input);
  assert.deepEqual(
    out.map((t) => t.id),
    ['ch', 'c'],
  );
  assert.equal(out[0].parentId, undefined);
});

test('归一化：悬空与不被支持的子任务挂载会被清除', () => {
  const ghost = [task('c', 'CombatProtocol'), task('x', 'AutoEssence', 'missing')];
  assert.equal(normalizeContainerTasks(ghost)[1].parentId, undefined);

  const unsupported = [task('c', 'CombatProtocol'), task('y', 'DailyRewards', 'c')];
  assert.equal(normalizeContainerTasks(unsupported)[1].parentId, undefined);
});

test('归一化：无变化时返回原数组引用', () => {
  const input = [task('c', 'CombatProtocol'), task('ch', 'AutoEssence', 'c')];
  assert.equal(normalizeContainerTasks(input), input);
  assert.equal(reconcileContainerTasks(input), input);
});

test('attach 合成覆写：槽位表与逐槽位阈值按条目顺序写入', () => {
  const override = buildContainerAttachOverride(
    DEF,
    ['ProtocolSpace', 'ProtocolSpace', 'AutoEssence'],
    [240, 120, 480],
  );
  assert.deepEqual(override, {
    CombatProtocolMain: {
      attach: {
        slots: ['ProtocolSpace', 'ProtocolSpace', 'AutoEssence'],
        slot_thresholds: [240, 120, 480],
      },
    },
  });
});

test('attach 合成覆写：空槽位表', () => {
  const override = buildContainerAttachOverride(DEF, [], []);
  assert.deepEqual(override, {
    CombatProtocolMain: {
      attach: {
        slots: [],
        slot_thresholds: [],
      },
    },
  });
});

test('排序：容器连同子任务块一起下移', () => {
  const input = [
    task('c', 'CombatProtocol'),
    task('ch1', 'AutoEssence', 'c'),
    task('ch2', 'ProtocolSpace', 'c'),
    task('n1', 'DailyRewards'),
    task('n2', 'CloseGame'),
  ];
  const out = planTaskReorder(input, 0, 4);
  assert.deepEqual(
    out.map((t) => t.id),
    ['n1', 'n2', 'c', 'ch1', 'ch2'],
  );
  assert.deepEqual(
    out.map((t) => t.parentId),
    [undefined, undefined, undefined, 'c', 'c'],
  );
});

test('排序：容器连同子任务块一起上移', () => {
  const input = [
    task('n0', 'DailyRewards'),
    task('n1', 'CloseGame'),
    task('c', 'CombatProtocol'),
    task('ch1', 'AutoEssence', 'c'),
  ];
  const out = planTaskReorder(input, 2, 0);
  assert.deepEqual(
    out.map((t) => t.id),
    ['c', 'ch1', 'n0', 'n1'],
  );
});

test('排序：拖到自身或自己的子任务上顺序不变', () => {
  const input = [
    task('c', 'CombatProtocol'),
    task('ch1', 'AutoEssence', 'c'),
    task('ch2', 'ProtocolSpace', 'c'),
    task('n1', 'DailyRewards'),
  ];
  assert.equal(planTaskReorder(input, 0, 1), input);
  assert.equal(planTaskReorder(input, 0, 2), input);
});

test('排序：普通任务按单元素移动', () => {
  const input = [
    task('a', 'DailyRewards'),
    task('b', 'CloseGame'),
    task('c', 'CombatProtocol'),
    task('ch', 'AutoEssence', 'c'),
  ];
  const out = planTaskReorder(input, 0, 2);
  assert.deepEqual(
    out.map((t) => t.id),
    ['b', 'c', 'a', 'ch'],
  );
});

test('排序：子任务按单元素移动（拖到容器之前交给归一化解绑）', () => {
  const input = [
    task('c', 'CombatProtocol'),
    task('ch1', 'AutoEssence', 'c'),
    task('ch2', 'ProtocolSpace', 'c'),
  ];
  const out = planTaskReorder(input, 2, 0);
  assert.deepEqual(
    out.map((t) => t.id),
    ['ch2', 'c', 'ch1'],
  );
  assert.equal(out[0].parentId, 'c');
});

test('排序：越界或原地时返回原数组引用', () => {
  const input = [task('a', 'DailyRewards'), task('c', 'CombatProtocol')];
  assert.equal(planTaskReorder(input, 0, 0), input);
  assert.equal(planTaskReorder(input, 0, 5), input);
  assert.equal(planTaskReorder(input, -1, 1), input);
});
