import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { filterTasksForRun } from '../src/utils/taskRunFilter.ts';

// Node 测试运行器不读取 tsconfig paths；只补齐解析，使用真实的业务模块。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { buildTabConfigExportText, importTabConfigFromText } =
  await import('../src/utils/tabExportImport.ts');
hooks.deregister();

function makeInstance(weeklySchedule) {
  return {
    id: 'instance',
    name: '周计划配置',
    controllerName: 'controller',
    selectedTasks: [
      {
        id: 'weekly',
        taskName: 'weekly',
        enabled: true,
        weeklySchedule,
        optionValues: {},
        expanded: true,
      },
    ],
  };
}

test('标签页导出导入保留任务周计划', async () => {
  const instance = makeInstance([0, 3]);
  const text = await buildTabConfigExportText(instance, 'demo');
  const result = await importTabConfigFromText('demo', text);
  assert.equal(result.tabName, instance.name);
  assert.deepEqual(result.payload.selectedTasks[0].weeklySchedule, [0, 3]);
});

test('标签页导出导入兼容缺省与空数组周计划', async () => {
  for (const weeklySchedule of [undefined, []]) {
    const text = await buildTabConfigExportText(makeInstance(weeklySchedule), 'demo');
    const result = await importTabConfigFromText('demo', text);
    assert.equal(result.payload.selectedTasks[0].weeklySchedule, undefined);
  }
});

async function importWireSchedule(ws) {
  const wire = { t: [{ i: 'weekly', tn: 'weekly', e: true, ov: {}, ws }] };
  const compressed = new Blob([JSON.stringify(wire)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const data = Buffer.from(await new Response(compressed).arrayBuffer()).toString('base64url');
  return importTabConfigFromText('demo', `demo://tab-sharing/v1/test/${data}`);
}

test('共享负载中的非数组或全无效周计划不会存入任务或阻止启动', async () => {
  for (const ws of [{ day: 0 }, '0', null, 0, [7, -1, 1.5, '3']]) {
    const result = await importWireSchedule(ws);
    const tasks = result.payload.selectedTasks;
    assert.equal(tasks[0].weeklySchedule, undefined);
    assert.deepEqual(
      filterTasksForRun(tasks, 3).tasks.map((task) => task.id),
      ['weekly'],
    );
  }
});

test('共享负载中的混合周计划保留有效星期，维持有效日期的限制', async () => {
  const result = await importWireSchedule([3, 0, 3, 6, -1, 7, 1.5, '1']);
  const tasks = result.payload.selectedTasks;
  assert.deepEqual(tasks[0].weeklySchedule, [0, 3, 6]);
  assert.equal(filterTasksForRun(tasks, 3).tasks.length, 1);
  assert.equal(filterTasksForRun(tasks, 1).tasks.length, 0);
});
