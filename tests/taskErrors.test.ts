import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstance } from 'i18next';
import { localizeTaskError, preservesTaskRun } from '../src/utils/taskErrors.ts';
import enUS from '../src/i18n/locales/en-US.ts';
import zhCN from '../src/i18n/locales/zh-CN.ts';
import zhTW from '../src/i18n/locales/zh-TW.ts';
import jaJP from '../src/i18n/locales/ja-JP.ts';
import koKR from '../src/i18n/locales/ko-KR.ts';

const codes = ['TASKER_STOPPING', 'TASK_QUEUE_ALREADY_RUNNING', 'INSTANCE_REPLACED'];
const resources = { enUS, zhCN, zhTW, jaJP, koKR };

test('task lifecycle rejections are translated for every supported language and transport', async () => {
  for (const [lng, translation] of Object.entries(resources)) {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation } } });
    for (const code of codes) {
      for (const error of [
        code,
        new Error(`API POST /maa/instances/1/tasks/start failed (500): {"error":"${code}"}`),
      ]) {
        const localized = localizeTaskError(error, (key) => i18n.t(key));
        assert.ok(localized instanceof Error);
        assert.ok(localized.message.length > 0);
        assert.ok(!localized.message.includes(code));
        assert.ok(!localized.message.startsWith('taskList.'));
        // A rejected concurrent/obsolete request cannot own the existing run.
        assert.equal(preservesTaskRun(localized), true);
      }
    }
  }
});

test('unrelated startup errors retain their diagnostics and normal cleanup', () => {
  for (const error of [new Error('Agent start failed: missing file'), 'TASKER_STOPPING_SUFFIX']) {
    assert.equal(
      localizeTaskError(error, () => 'unexpected translation'),
      error,
    );
    assert.equal(preservesTaskRun(error), false);
  }
});
