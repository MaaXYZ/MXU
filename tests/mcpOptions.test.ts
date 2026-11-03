/**
 * MCP 选项工具（src/utils/mcpOptions.ts）的单测：
 * 结构描述、AI 传入值的严格校验与转换、当前值输出（含密码打码）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertMcpOptions,
  describeOptions,
  describeSingleOption,
  formatOptionValues,
  MASKED_VALUE,
  type OptionContext,
} from '../src/utils/mcpOptions.ts';
import { initializeAllOptionValues } from '../src/stores/helpers.ts';
import type { OptionDefinition } from '../src/types/interface.ts';

const allOptions: Record<string, OptionDefinition> = {
  Stage: {
    label: '$关卡',
    cases: [
      { name: 'A', label: '$关卡A' },
      { name: 'B', label: '$关卡B', option: ['Times'] },
    ],
    default_case: 'A',
  },
  Times: {
    type: 'input',
    inputs: [{ name: 'count', default: '1', verify: '^[1-9]\\d*$', pattern_msg: '$请输入正整数' }],
  },
  Rewards: {
    type: 'checkbox',
    cases: [{ name: 'Gold' }, { name: 'Exp' }, { name: 'Item' }],
    default_case: ['Gold'],
    max_count: 2,
  },
  AutoUse: {
    type: 'switch',
    cases: [{ name: 'Yes', option: ['Account'] }, { name: 'No' }],
    default_case: 'No',
  },
  Account: {
    type: 'input',
    inputs: [
      { name: 'user', default: '' },
      { name: 'password', default: '', password: true },
    ],
  },
  PcOnly: {
    controller: ['Win32'],
    cases: [{ name: 'On' }, { name: 'Off' }],
  },
};

const optionKeys = ['Stage', 'Rewards', 'AutoUse', 'PcOnly'];

const ctx: OptionContext = {
  resolveText: (text) => (text ? text.replace(/^\$/, '') : undefined),
  controllerName: 'Adb',
  resourceName: 'Official',
};

const convert = (input: Record<string, unknown>) =>
  convertMcpOptions({
    optionKeys,
    allOptions,
    defaults: initializeAllOptionValues(optionKeys, allOptions),
    input,
    ctx,
  });

test('describeOptions：摊平为 key 表，输出 label、默认值与子选项 key，跳过不兼容选项', () => {
  const { root_options, options } = describeOptions(optionKeys, allOptions, ctx);
  assert.deepEqual(root_options, ['Stage', 'Rewards', 'AutoUse']);
  // 不兼容当前控制器的选项不出现在表中
  assert.equal('PcOnly' in options, false);

  const stage = options.Stage;
  assert.equal(stage.type, 'select');
  assert.equal(stage.label, '关卡');
  assert.equal(stage.default, 'A');
  assert.equal(stage.cases?.[1].label, '关卡B');
  // 子选项只写 key，定义在表中
  assert.deepEqual(stage.cases?.[1].options, ['Times']);
  assert.equal(options.Times.type, 'input');

  const autoUse = options.AutoUse;
  assert.deepEqual(
    autoUse.cases?.map((c) => c.name),
    ['Yes', 'No'],
  );
  assert.equal(autoUse.default, 'No');
  assert.deepEqual(autoUse.cases?.[0].options, ['Account']);
  assert.equal(options.Account.inputs?.[1].password, true);
});

test('convertMcpOptions：合法取值被转换，并补齐新激活的子选项', () => {
  const values = convert({ Stage: 'B', Rewards: ['Exp', 'Item'], AutoUse: 'Yes' });
  assert.deepEqual(values.Stage, { type: 'select', caseName: 'B' });
  assert.deepEqual(values.Rewards, { type: 'checkbox', caseNames: ['Exp', 'Item'] });
  assert.deepEqual(values.AutoUse, { type: 'switch', value: true });
  // 切到 B / 打开开关后激活的子选项使用默认值
  assert.deepEqual(values.Times, { type: 'input', values: { count: '1' } });
  assert.deepEqual(values.Account, { type: 'input', values: { user: '', password: '' } });
});

test('convertMcpOptions：只传部分输入字段时，其余字段保留默认值', () => {
  const values = convert({ Account: { user: 'alice' } });
  assert.deepEqual(values.Account, { type: 'input', values: { user: 'alice', password: '' } });
});

test('convertMcpOptions：非法取值报错并列出合法取值', () => {
  assert.throws(() => convert({ Stage: 'C' }), /没有取值 "C"，可选："A", "B"/);
  assert.throws(() => convert({ Unknown: 'x' }), /没有选项 "Unknown"/);
  assert.throws(() => convert({ AutoUse: 'maybe' }), /"Yes" 或 "No"/);
  assert.throws(() => convert({ Rewards: ['Gold', 'Exp', 'Item'] }), /最多只能选择 2 项/);
  assert.throws(() => convert({ Times: { count: '0' } }), /不符合格式要求：请输入正整数（正则/);
  assert.throws(() => convert({ Times: { other: '1' } }), /没有字段 "other"/);
  assert.throws(() => convert({ PcOnly: 'On' }), /不适用于当前控制器/);
});

test('formatOptionValues：只输出激活的选项，密码打码', () => {
  const values = {
    ...initializeAllOptionValues(optionKeys, allOptions),
    ...convert({ AutoUse: 'Yes', Account: { user: 'alice', password: 'secret' } }),
  };
  const formatted = formatOptionValues(optionKeys, allOptions, values, ctx);
  assert.deepEqual(formatted, {
    Stage: 'A',
    Rewards: ['Gold'],
    AutoUse: 'Yes',
    Account: { user: 'alice', password: MASKED_VALUE },
  });
});

test('convertMcpOptions：以当前值为基准修改（update_task），只覆盖传入的选项与字段', () => {
  const current = {
    ...initializeAllOptionValues(optionKeys, allOptions),
    ...convert({ AutoUse: 'Yes', Account: { user: 'alice', password: 'old' } }),
  };
  const changed = convertMcpOptions({
    optionKeys,
    allOptions,
    defaults: current,
    input: { Account: { password: 'new' }, Stage: 'B' },
    ctx,
  });
  // 只改 password，user 保留当前值
  assert.deepEqual(changed.Account, {
    type: 'input',
    values: { user: 'alice', password: 'new' },
  });
  assert.deepEqual(changed.Stage, { type: 'select', caseName: 'B' });
  // 切到 B 后新激活的子选项补默认值；未传入的选项不出现在结果中
  assert.deepEqual(changed.Times, { type: 'input', values: { count: '1' } });
  assert.equal('AutoUse' in changed, false);
  assert.equal('Rewards' in changed, false);
});

test('describeOptions：重复引用的选项只定义一次，相同大列表只输出一次', () => {
  const bigCases = Array.from({ length: 10 }, (_, i) => ({ name: `Item${i}`, label: `$物品${i}` }));
  const opts: Record<string, OptionDefinition> = {
    Mode: {
      cases: [
        { name: 'A', option: ['Shared'] },
        { name: 'B', option: ['Shared'] },
      ],
    },
    Shared: { type: 'switch', cases: [{ name: 'Yes' }, { name: 'No' }] },
    Priority1: { cases: bigCases },
    Priority2: { cases: bigCases },
  };
  const { root_options, options } = describeOptions(['Mode', 'Priority1', 'Priority2'], opts, ctx);
  assert.deepEqual(root_options, ['Mode', 'Priority1', 'Priority2']);

  // 两个取值都引用同一个 key，表中只有一份定义；没有子选项的开关不列出 Yes / No
  assert.deepEqual(options.Mode.cases?.[0].options, ['Shared']);
  assert.deepEqual(options.Mode.cases?.[1].options, ['Shared']);
  assert.equal(options.Shared.cases, undefined);
  assert.deepEqual(Object.keys(options).sort(), ['Mode', 'Priority1', 'Priority2', 'Shared']);

  assert.equal(options.Priority1.cases?.length, 10);
  assert.equal(options.Priority2.cases, undefined);
  assert.equal(options.Priority2.cases_same_as, 'Priority1');
});

test('describeOptions：超过 50 项的取值列表默认不展开，describeSingleOption 完整展开', () => {
  const manyCases = Array.from({ length: 60 }, (_, i) => ({ name: `Goods${i}` }));
  const opts: Record<string, OptionDefinition> = {
    Fill: { type: 'switch', cases: [{ name: 'Yes', option: ['WhatToFill'] }, { name: 'No' }] },
    WhatToFill: { cases: manyCases, default_case: 'Goods0' },
  };

  const { options } = describeOptions(['Fill'], opts, ctx);
  assert.deepEqual(options.Fill.cases?.[0].options, ['WhatToFill']);
  const whatToFill = options.WhatToFill;
  assert.equal(whatToFill.cases, undefined);
  assert.equal(whatToFill.cases_omitted, true);
  assert.equal(whatToFill.case_count, 60);
  assert.equal(whatToFill.default, 'Goods0');

  const single = describeSingleOption('WhatToFill', ['Fill'], opts, ctx);
  assert.deepEqual(single.root_options, ['WhatToFill']);
  assert.equal(single.options.WhatToFill.cases?.length, 60);
  assert.equal(single.options.WhatToFill.cases_omitted, undefined);

  assert.throws(() => describeSingleOption('Nope', ['Fill'], opts, ctx), /没有选项 "Nope"/);
});
