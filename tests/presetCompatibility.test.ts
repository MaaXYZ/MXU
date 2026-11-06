import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPresetCompatible } from '../src/utils/presetCompatibility.ts';
import type { PresetItem } from '../src/types/interface.ts';

test('不限制控制器的预设继续适用于所有控制器', () => {
  assert.equal(isPresetCompatible({ name: '通用' }, '模拟器'), true);
  assert.equal(isPresetCompatible({ name: '通用', controller: [] }, '桌面'), true);
});

test('限制使用 controller.name 而非控制器类型', () => {
  const preset: PresetItem = { name: '模拟器日常', controller: ['安卓模拟器', '备用模拟器'] };
  assert.equal(isPresetCompatible(preset, '安卓模拟器'), true);
  assert.equal(isPresetCompatible(preset, '备用模拟器'), true);
  assert.equal(isPresetCompatible(preset, 'Adb'), false);
  assert.equal(isPresetCompatible(preset, '桌面'), false);
});

test('切换控制器时仅保留通用预设和当前控制器适用的预设', () => {
  const presets: PresetItem[] = [
    { name: '通用' },
    { name: '模拟器日常', controller: ['模拟器'] },
    { name: '桌面日常', controller: ['桌面'] },
  ];
  const visible = (controller: string) =>
    presets.filter((preset) => isPresetCompatible(preset, controller)).map((preset) => preset.name);
  assert.deepEqual(visible('模拟器'), ['通用', '模拟器日常']);
  assert.deepEqual(visible('桌面'), ['通用', '桌面日常']);
  assert.deepEqual(visible('其他'), ['通用']);
});
