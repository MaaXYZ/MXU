import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRichTextFeatures } from '../src/utils/richText.ts';

test('hasRichTextFeatures：日志正文语法面更宽（多行 / 裸 URL）', () => {
  assert.equal(hasRichTextFeatures('第一行\n第二行'), true);
  assert.equal(hasRichTextFeatures('详情见 https://example.com/x'), true);
  assert.equal(hasRichTextFeatures('# 标题'), true);
  assert.equal(hasRichTextFeatures('普通一行文字'), false);
});
