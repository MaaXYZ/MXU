import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContainerAttachOverride, CONTAINER_TASKS } from '../src/types/containerTasks.ts';
import { normalizeContainerTasks, reconcileContainerTasks } from '../src/utils/taskContainer.ts';
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
