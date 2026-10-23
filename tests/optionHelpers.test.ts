/**
 * 嵌套子选项推导的单测。
 *
 * 背景：ProjectInterface 协议允许 case.option 挂子配置项（最大嵌套无限层）。
 * switch / select 是单选，取当前选中的 case 即可；checkbox 是多选，
 * 任意被勾选的 case 都可能带子项，必须逐个汇总 —— 早期实现按单选处理，
 * 导致 checkbox 下的子配置项永远推导不出来。
 *
 * 被测模块只有 type-only import，运行时无需 DOM / Tauri 环境。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getSelectedCasesWithOptions, findSwitchCase } from '../src/utils/optionHelpers.ts';

type CaseItem = {
  name: string;
  label?: string;
  option?: string[];
};

function checkbox(cases: CaseItem[], default_case?: string[]) {
  return { type: 'checkbox' as const, cases, default_case };
}

test('checkbox：勾选一个带子项的 case 时返回它', () => {
  const optionDef = checkbox([
    { name: '节点2舰种1', option: ['节点2检测目标名', '节点2反向检测目标'] },
    { name: '节点2舰种2', option: ['节点2检测目标名2'] },
  ]);
  const result = getSelectedCasesWithOptions(optionDef, {
    type: 'checkbox',
    caseNames: ['节点2舰种1'],
  });
  assert.deepEqual(
    result.map((c) => c.name),
    ['节点2舰种1'],
  );
});

test('checkbox：同时勾选多个带子项的 case 时全部返回，且保持定义顺序', () => {
  const optionDef = checkbox([
    { name: 'A', option: ['a1'] },
    { name: 'B', option: ['b1'] },
    { name: 'C', option: ['c1'] },
  ]);
  // 故意让勾选顺序与定义顺序相反，返回值仍应按定义顺序
  const result = getSelectedCasesWithOptions(optionDef, {
    type: 'checkbox',
    caseNames: ['C', 'A'],
  });
  assert.deepEqual(
    result.map((c) => c.name),
    ['A', 'C'],
  );
});

test('checkbox：勾选了不带子项的 case 时返回空数组', () => {
  const optionDef = checkbox([{ name: '纯开关项' }, { name: '带子项', option: ['x'] }]);
  const result = getSelectedCasesWithOptions(optionDef, {
    type: 'checkbox',
    caseNames: ['纯开关项'],
  });
  assert.deepEqual(result, []);
});

test('checkbox：value 缺失时回退到 default_case', () => {
  const optionDef = checkbox(
    [
      { name: 'A', option: ['a1'] },
      { name: 'B', option: ['b1'] },
    ],
    ['B'],
  );
  const result = getSelectedCasesWithOptions(optionDef, undefined);
  assert.deepEqual(
    result.map((c) => c.name),
    ['B'],
  );
});

test('checkbox：既无 value 也无 default_case 时返回空数组，不抛错', () => {
  const optionDef = checkbox([{ name: 'A', option: ['a1'] }]);
  assert.deepEqual(getSelectedCasesWithOptions(optionDef, undefined), []);
});

test('switch：按布尔值取对应分支，两个分支都可挂子项', () => {
  const optionDef = {
    type: 'switch' as const,
    cases: [
      { name: 'Yes', option: ['on1'] },
      { name: 'No', option: ['off1'] },
    ] as [CaseItem, CaseItem],
  };
  const on = getSelectedCasesWithOptions(optionDef, { type: 'switch', value: true });
  const off = getSelectedCasesWithOptions(optionDef, { type: 'switch', value: false });
  assert.deepEqual(
    on.map((c) => c.name),
    ['Yes'],
  );
  assert.deepEqual(
    off.map((c) => c.name),
    ['No'],
  );
});

test('switch：value 缺失时按未选中处理', () => {
  const optionDef = {
    type: 'switch' as const,
    cases: [{ name: 'Yes', option: ['on1'] }, { name: 'No' }] as [CaseItem, CaseItem],
  };
  assert.deepEqual(getSelectedCasesWithOptions(optionDef, undefined), []);
});

test('select：按 caseName 取对应 case', () => {
  const optionDef = {
    type: 'select' as const,
    cases: [{ name: '简单' }, { name: '完整', option: ['子项1', '子项2'] }],
  };
  const result = getSelectedCasesWithOptions(optionDef, { type: 'select', caseName: '完整' });
  assert.deepEqual(
    result.map((c) => c.name),
    ['完整'],
  );
});

test('select：无 value 时依次回退 default_case、首个 case', () => {
  const withDefault = {
    type: 'select' as const,
    cases: [{ name: 'A' }, { name: 'B', option: ['b1'] }],
    default_case: 'B',
  };
  assert.deepEqual(
    getSelectedCasesWithOptions(withDefault, undefined).map((c) => c.name),
    ['B'],
  );

  const withoutDefault = { type: 'select' as const, cases: [{ name: 'A', option: ['a1'] }] };
  assert.deepEqual(
    getSelectedCasesWithOptions(withoutDefault, undefined).map((c) => c.name),
    ['A'],
  );
});

test('select：省略 type 时按 select 处理（协议允许）', () => {
  const optionDef = { cases: [{ name: 'A', option: ['a1'] }] };
  assert.deepEqual(
    getSelectedCasesWithOptions(optionDef, undefined).map((c) => c.name),
    ['A'],
  );
});

test('input / hotkey：没有 case，返回空数组', () => {
  const optionDef = {
    type: 'input' as const,
    inputs: [{ name: 'field' }],
  };
  assert.deepEqual(getSelectedCasesWithOptions(optionDef, undefined), []);
});

test('回归：checkbox 不得按单选逻辑只返回第一个分支', () => {
  // 真实场景：战斗检测目标舰种 12 个 case，每个挂 3 个子项
  const cases: CaseItem[] = [];
  for (let node = 1; node <= 2; node += 1) {
    for (let ship = 1; ship <= 2; ship += 1) {
      cases.push({
        name: `节点${node}舰种${ship}`,
        option: [`节点${node}检测目标名`, `节点${node}反向检测目标`],
      });
    }
  }
  const optionDef = checkbox(cases);
  const result = getSelectedCasesWithOptions(optionDef, {
    type: 'checkbox',
    caseNames: ['节点2舰种1', '节点1舰种2'],
  });
  assert.equal(result.length, 2, '两个勾选项都应被推导出来');
  assert.deepEqual(
    result.flatMap((c) => c.option ?? []),
    ['节点1检测目标名', '节点1反向检测目标', '节点2检测目标名', '节点2反向检测目标'],
  );
});

test('findSwitchCase：仍按 Yes/No 别名匹配', () => {
  const cases: CaseItem[] = [{ name: 'Yes' }, { name: 'No' }];
  assert.equal(findSwitchCase(cases, true)?.name, 'Yes');
  assert.equal(findSwitchCase(cases, false)?.name, 'No');
  assert.equal(findSwitchCase(undefined, true), undefined);
});
