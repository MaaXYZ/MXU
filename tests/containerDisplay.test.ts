import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTAINER_TASKS } from '../src/types/containerTasks.ts';
import { getChildDisplaySegments } from '../src/utils/containerDisplay.ts';
import type { OptionDefinition, SelectedTask } from '../src/types/interface.ts';

const DEF = CONTAINER_TASKS.CombatProtocol;

const optionDefs: Record<string, OptionDefinition> = {
  ProtocolSpaceTab: {
    label: '$option.ProtocolSpaceTab.label',
    cases: [
      {
        name: 'OperatorProgression',
        label: '$option.OperatorProgression.label',
        option: ['OperatorProgression', 'ProtocolSpaceLevel'],
      },
      {
        name: 'CrisisDrills',
        label: '$option.CrisisDrills.label',
        option: ['CrisisDrills'],
      },
    ],
  },
  OperatorProgression: {
    label: '$option.OperatorProgression.label',
    cases: [
      { name: 'OperatorEXP', label: '$option.OperatorProgression.OperatorEXP.label' },
      { name: 'OperatorPromotion', label: '$option.OperatorProgression.OperatorPromotion.label' },
    ],
    default_case: 'OperatorEXP',
  },
} as unknown as Record<string, OptionDefinition>;

const child = (overrides: Record<string, unknown>): SelectedTask =>
  ({
    id: 'c1',
    taskName: 'ProtocolSpace',
    enabled: true,
    optionValues: overrides,
    expanded: false,
  }) as unknown as SelectedTask;

test('显示名后缀：分页 + 细分种类两段标签键', () => {
  const segments = getChildDisplaySegments(
    DEF,
    child({
      ProtocolSpaceTab: { type: 'select', caseName: 'OperatorProgression' },
      OperatorProgression: { type: 'select', caseName: 'OperatorEXP' },
    }),
    optionDefs,
  );
  assert.deepEqual(segments, [
    '$option.OperatorProgression.label',
    '$option.OperatorProgression.OperatorEXP.label',
  ]);
});

test('显示名后缀：仅选中分页时只返回一段', () => {
  const segments = getChildDisplaySegments(
    DEF,
    child({ ProtocolSpaceTab: { type: 'select', caseName: 'CrisisDrills' } }),
    optionDefs,
  );
  assert.deepEqual(segments, ['$option.CrisisDrills.label']);
});

test('显示名后缀：未选择分页或选项定义缺失时为空', () => {
  assert.deepEqual(getChildDisplaySegments(DEF, child({}), optionDefs), []);
  assert.deepEqual(
    getChildDisplaySegments(
      DEF,
      child({ ProtocolSpaceTab: { type: 'select', caseName: 'OperatorProgression' } }),
      undefined,
    ),
    [],
  );
});
