import { test } from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import zhCN from '../src/i18n/locales/zh-CN.ts';
import zhTW from '../src/i18n/locales/zh-TW.ts';
import enUS from '../src/i18n/locales/en-US.ts';
import jaJP from '../src/i18n/locales/ja-JP.ts';
import koKR from '../src/i18n/locales/ko-KR.ts';

const locales = { 'zh-CN': zhCN, 'zh-TW': zhTW, 'en-US': enUS, 'ja-JP': jaJP, 'ko-KR': koKR };

test('所有语言的周计划星期键均返回七个本地化标签', async () => {
  for (const [language, locale] of Object.entries(locales)) {
    const instance = i18next.createInstance();
    // 禁用回退，确保每种语言自身已定义该键。
    await instance.init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: { translation: locale } },
    });
    const labels = instance.t('schedule.weekdays', { returnObjects: true });
    assert.ok(Array.isArray(labels), language);
    assert.equal(labels.length, 7, language);
    assert.deepEqual(labels, locale.schedule.weekdays, language);
    assert.ok(
      labels.every((label) => typeof label === 'string' && label.length > 0),
      language,
    );
  }
});
