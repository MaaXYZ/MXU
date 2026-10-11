/**
 * 输入取值 / 校验的纯函数单测。
 *
 * 覆盖本次修复的两条不变量：
 * 1. 只有"没有数据"（键缺失 / null / 空串）才回退 default，非空值原样保留；
 * 2. 值必须通过 verify（以及 int 的整数要求），否则由启动闸门拒绝运行。
 *
 * 被测模块只依赖类型，无需 DOM / Tauri 环境；沿用仓库既有的 Node 内置 test runner。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getInputValueError,
  hasDeclaredValue,
  isEmptyInputValue,
  resolveInputValue,
} from '../src/utils/optionInputValue.ts';

const input = (overrides = {}) => ({ name: 'Demo', ...overrides });

test('isEmptyInputValue：键缺失 / null / 空串都算"没有数据"', () => {
  assert.equal(isEmptyInputValue(undefined), true);
  assert.equal(isEmptyInputValue(null), true);
  assert.equal(isEmptyInputValue(''), true);
  assert.equal(isEmptyInputValue('0'), false);
  assert.equal(isEmptyInputValue(' '), false);
});

test('resolveInputValue：只有没有数据时才回退 default，非空值不被改写', () => {
  const withDefault = input({ default: '400' });
  assert.equal(resolveInputValue(withDefault, undefined), '400');
  assert.equal(resolveInputValue(withDefault, null), '400');
  assert.equal(resolveInputValue(withDefault, ''), '400');
  // 非空但格式非法的值必须原样保留，合法性交给闸门判定
  assert.equal(resolveInputValue(withDefault, '1e6'), '1e6');
  assert.equal(resolveInputValue(withDefault, '0'), '0');
});

test('resolveInputValue：没有 default 的输入保留空值（"留空=不启用"）', () => {
  const noDefault = input();
  assert.equal(resolveInputValue(noDefault, ''), '');
  assert.equal(resolveInputValue(noDefault, null), '');
  assert.equal(resolveInputValue(noDefault, 'abc'), 'abc');
});

test('resolveInputValue：密码字段永不注入 default，null 归一成空串', () => {
  const password = input({ default: 'secret', password: true });
  assert.equal(resolveInputValue(password, undefined), '');
  assert.equal(resolveInputValue(password, null), '');
  assert.equal(resolveInputValue(password, ''), '');
  assert.equal(resolveInputValue(password, 'typed'), 'typed');
});

test('hasDeclaredValue：只有"非空 default 且非密码"的输入才允许自动补空', () => {
  assert.equal(hasDeclaredValue(input({ default: '5' })), true);
  assert.equal(hasDeclaredValue(input({ default: '' })), false);
  assert.equal(hasDeclaredValue(input()), false);
  assert.equal(hasDeclaredValue(input({ default: '5', password: true })), false);
});

test('getInputValueError：空值只在 verify 不接受空串时才算错', () => {
  const requiresNumber = input({ verify: '^\\d+$' });
  assert.deepEqual(getInputValueError(requiresNumber, ''), { kind: 'empty' });

  const optionalNumber = input({ verify: '^\\d*$' });
  assert.equal(getInputValueError(optionalNumber, ''), null);

  // 没有 verify 的输入保留空值语义，不报错
  assert.equal(getInputValueError(input(), ''), null);
  // 非空值不受影响
  assert.equal(getInputValueError(requiresNumber, '1500'), null);
});

test('getInputValueError：非空但不匹配 verify 时报 pattern', () => {
  const requiresNumber = input({ verify: '^(0|[1-9][0-9]{0,8})$' });
  assert.deepEqual(getInputValueError(requiresNumber, '1,500'), { kind: 'pattern' });
  assert.deepEqual(getInputValueError(requiresNumber, 'abc'), { kind: 'pattern' });
  assert.deepEqual(getInputValueError(requiresNumber, '007'), { kind: 'pattern' });
  assert.equal(getInputValueError(requiresNumber, '0'), null);
});

test('getInputValueError：int 字段必须是十进制整数（否则整段 override 会变成非法 JSON）', () => {
  const intInput = input({ pipeline_type: 'int' });
  assert.deepEqual(getInputValueError(intInput, '1e6'), { kind: 'integer' });
  assert.deepEqual(getInputValueError(intInput, 'abc'), { kind: 'integer' });
  assert.equal(getInputValueError(intInput, '12'), null);
  assert.equal(getInputValueError(intInput, '-3'), null);
  // int 的空值仍由代入阶段兜底为 0，这里不额外拦截
  assert.equal(getInputValueError(intInput, ''), null);
});

test('getInputValueError：verify 本身非法时不再静默放行', () => {
  const broken = input({ verify: '^\\d+(' });
  assert.deepEqual(getInputValueError(broken, '1500'), { kind: 'invalid-pattern' });
  assert.deepEqual(getInputValueError(broken, ''), { kind: 'invalid-pattern' });
});
