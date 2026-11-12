import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBuiltinSkinId } from '../src/skins/types.ts';
import { getSkinTaskState } from '../src/components/skins/state.ts';
import type { TaskStatus } from '../src/types/maa.ts';
import enUS from '../src/i18n/locales/en-US.ts';
import zhCN from '../src/i18n/locales/zh-CN.ts';
import zhTW from '../src/i18n/locales/zh-TW.ts';
import jaJP from '../src/i18n/locales/ja-JP.ts';
import koKR from '../src/i18n/locales/ko-KR.ts';

test('skin IDs accept only bundled choices and old or unrecognized values use the default interface', () => {
  for (const id of ['default', 'deepseek', 'naiwa'] as const)
    assert.equal(normalizeBuiltinSkinId(id), id);
  for (const value of [
    undefined,
    null,
    '',
    false,
    1,
    ['naiwa'],
    { id: 'deepseek' },
    'DeepSeek',
    '__proto__',
    'third-party-skin',
    'https://example.invalid/skin.html',
  ]) {
    assert.equal(normalizeBuiltinSkinId(value), 'default');
  }
});

test('skin task feedback honors active runs before old outcomes and never invents pause or cancellation facts', () => {
  const statuses: Array<TaskStatus | null | undefined> = [
    undefined,
    null,
    'Pending',
    'Running',
    'Succeeded',
    'Failed',
  ];
  for (const status of statuses) assert.equal(getSkinTaskState(true, status), 'running');
  assert.equal(getSkinTaskState(false, 'Succeeded'), 'success');
  assert.equal(getSkinTaskState(false, 'Failed'), 'error');
  for (const status of [undefined, null, 'Pending', 'Running'] as const)
    assert.equal(getSkinTaskState(false, status), 'idle');
  // Stopping currently clears the host fact; it does not distinguish pause from cancellation.
  for (const unsupported of ['Paused', 'Cancelled'])
    assert.equal(getSkinTaskState(false, unsupported as TaskStatus), 'idle');
});

function flattenStrings(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === 'object')
        return Object.entries(flattenStrings(item as Record<string, unknown>, path));
      assert.equal(typeof item, 'string', `${path} must be translated text`);
      assert((item as string).trim(), `${path} must not be empty`);
      return [[path, item as string]];
    }),
  );
}

test('skin controls and factual task labels are translated without invented character dialogue in all five languages', () => {
  const resources = { enUS, zhCN, zhTW, jaJP, koKR };
  const expected = flattenStrings(enUS.skin);
  const settingKeys = Object.keys(enUS.settings)
    .filter((key) => key.startsWith('skin'))
    .sort();
  for (const [language, translation] of Object.entries(resources)) {
    const messages = flattenStrings(translation.skin);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(expected).sort(), language);
    assert.equal(Object.hasOwn(translation.skin, 'deepseek'), false, language);
    assert.equal(Object.hasOwn(translation.skin, 'naiwa'), false, language);
    const settings = Object.fromEntries(
      Object.entries(translation.settings).filter(([key]) => key.startsWith('skin')),
    );
    assert.deepEqual(Object.keys(settings).sort(), settingKeys, language);
    flattenStrings(settings);
    for (const state of ['idle', 'running', 'success', 'error']) {
      assert.ok(messages[`state.${state}`], `${language} needs an accessible ${state} label`);
    }
    for (const key of ['feed', 'poke', 'regionLabel', 'reducedMotion'])
      assert.ok(messages[key], `${language} needs ${key}`);
  }
});
