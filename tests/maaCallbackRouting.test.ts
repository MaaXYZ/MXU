import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchMaaCallback, getCallbackInstanceId } from '../src/utils/maaCallbackRouting.ts';

const instances = [{ id: 'adb-a' }, { id: 'adb-b' }];

test('interleaved callbacks stay in their source log while another tab is viewed', () => {
  const logs: Record<string, string[]> = { 'adb-a': [], 'adb-b': [] };
  // Both transports carry the same instance_id envelope, including callbacks with no task/ctrl ID.
  const events = [
    { instance_id: 'adb-a', message: 'Resource.Loading.Starting' },
    { instance_id: 'adb-b', message: 'Tasker.Task.Starting' },
    { instance_id: 'adb-a', message: 'Node.Action.Succeeded' },
    { instance_id: 'adb-b', message: 'Tasker.Task.Succeeded' },
  ];
  for (const event of events) {
    dispatchMaaCallback(
      { ...event, details: '{"task_id":42}' },
      (message, details, source) => {
        const target = getCallbackInstanceId(source, instances);
        assert.ok(target);
        assert.equal(details.task_id, 42);
        logs[target].push(message);
      },
      () => assert.fail('valid event details must decode'),
    );
  }
  assert.deepEqual(logs, {
    'adb-a': ['Resource.Loading.Starting', 'Node.Action.Succeeded'],
    'adb-b': ['Tasker.Task.Starting', 'Tasker.Task.Succeeded'],
  });
});

test('global, legacy and destroyed-instance callbacks never fall back to a live tab', () => {
  for (const source of [undefined, null, '', 'destroyed']) {
    assert.equal(getCallbackInstanceId(source, instances), undefined);
  }
  assert.equal(getCallbackInstanceId('adb-a', [{ id: 'adb-b' }]), undefined);
});

test('focus content retains its source across asynchronous resolution', async () => {
  const target = getCallbackInstanceId('adb-a', instances);
  assert.equal(target, 'adb-a');
  // The visible tab/instance list may change while a focus image or Markdown is loading.
  const currentInstances = [{ id: 'adb-b' }, { id: 'adb-a' }];
  await Promise.resolve();
  assert.equal(getCallbackInstanceId(target, currentInstances), 'adb-a');
});

test('invalid callback details still preserve their instance source', () => {
  const invalidDetails: string[] = [];
  for (const details of ['invalid', 'null', '[]', '42']) {
    dispatchMaaCallback(
      { instance_id: 'adb-b', message: 'Controller.Action.Failed', details },
      (message, parsedDetails, source) => {
        assert.equal(message, 'Controller.Action.Failed');
        assert.deepEqual(parsedDetails, {});
        assert.equal(getCallbackInstanceId(source, instances), 'adb-b');
      },
      (invalid) => invalidDetails.push(invalid),
    );
  }
  assert.deepEqual(invalidDetails, ['invalid', 'null', '[]', '42']);
});

test('legacy events remain available to non-log listeners without inventing a source', () => {
  dispatchMaaCallback(
    { message: 'Controller.Action.Succeeded', details: '{"ctrl_id":1}' },
    (message, details, source) => {
      assert.equal(message, 'Controller.Action.Succeeded');
      assert.equal(details.ctrl_id, 1);
      assert.equal(source, undefined);
      assert.equal(getCallbackInstanceId(source, instances), undefined);
    },
    () => assert.fail('valid legacy event details must decode'),
  );
});
