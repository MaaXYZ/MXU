import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWelcomeContentHash, resolveWelcomeEntries } from '../src/utils/welcomeContent.ts';

test('单条 welcome 继续按字符串解析，并保留旧版已读 hash', async () => {
  const entries = await resolveWelcomeEntries('$notice', async (source) => {
    assert.equal(source, '$notice');
    return 'a';
  });
  assert.deepEqual(entries, [{ source: '$notice', content: 'a' }]);
  assert.equal(getWelcomeContentHash(entries), '2p');
});

test('多条公告独立解析，异步完成顺序不会改变展示顺序', async () => {
  const pending = new Map<string, (content: string) => void>();
  const sources = ['$notice', 'announcements/update.md', 'https://example.com/notice'];
  const result = resolveWelcomeEntries(
    sources,
    (source) => new Promise<string>((resolve) => pending.set(source, resolve)),
  );

  pending.get(sources[2])!('第三条');
  pending.get(sources[1])!('第二条');
  pending.get(sources[0])!('第一条');
  assert.deepEqual(await result, [
    { source: sources[0], content: '第一条' },
    { source: sources[1], content: '第二条' },
    { source: sources[2], content: '第三条' },
  ]);
});

test('没有公告或空数组时不发起内容加载', async () => {
  const resolve = async (): Promise<string> => {
    assert.fail('不应加载空公告列表');
  };
  assert.deepEqual(await resolveWelcomeEntries(undefined, resolve), []);
  assert.deepEqual(await resolveWelcomeEntries('', resolve), []);
  assert.deepEqual(await resolveWelcomeEntries([], resolve), []);
});

test('公告重排、增删、来源或内容更新都会重新提示', () => {
  const entries = [
    { source: '$first', content: '第一条' },
    { source: 'second.md', content: '第二条' },
  ];
  const hash = getWelcomeContentHash(entries);
  assert.equal(getWelcomeContentHash([...entries]), hash);
  assert.notEqual(getWelcomeContentHash([...entries].reverse()), hash);
  assert.notEqual(getWelcomeContentHash(entries.slice(1)), hash);
  assert.notEqual(getWelcomeContentHash([...entries, entries[0]]), hash);
  assert.notEqual(
    getWelcomeContentHash([entries[0], { ...entries[1], content: '新版第二条' }]),
    hash,
  );
  assert.notEqual(
    getWelcomeContentHash([entries[0], { ...entries[1], source: 'new-second.md' }]),
    hash,
  );
});

test('公告边界参与已读判断，避免不同列表拼成相同文本', () => {
  const first = [
    { source: '$a', content: 'ab' },
    { source: '$b', content: 'c' },
  ];
  const second = [
    { source: '$a', content: 'a' },
    { source: '$b', content: 'bc' },
  ];
  assert.notEqual(getWelcomeContentHash(first), getWelcomeContentHash(second));
});
