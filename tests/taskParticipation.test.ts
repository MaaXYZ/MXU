import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';

// 用真实组件和 store 做无 DOM 渲染：补齐 Vite 环境，并让 SSR 读取测试注入的当前状态。
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!result.source) return result;
    let source = result.source.toString();
    if (url.includes('/src/')) source = source.replaceAll('import.meta.env', '({})');
    if (url.includes('/zustand/') && (url.endsWith('/react.mjs') || url.endsWith('/react.js'))) {
      source = source.replaceAll('api.getInitialState()', 'api.getState()');
    }
    return { ...result, source };
  },
});
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useAppStore } = await import('../src/stores/appStore.ts');
const { TaskItem } = await import('../src/components/TaskItem.tsx');
const { Toolbar } = await import('../src/components/Toolbar.tsx');
const { DashboardView } = await import('../src/components/DashboardView.tsx');
const { filterTasksForRun, createTaskRunSelection } = await import('../src/utils/taskRunFilter.ts');
const i18n = (await import('../src/i18n/index.ts')).default;
await i18n.changeLanguage('zh-CN');
hooks.deregister();

function renderTask(t, { isRunning = false, status = 'succeeded', selection } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 12).getTime() });
  const task = {
    id: 'weekly',
    taskName: 'weekly',
    enabled: true,
    weeklySchedule: [0],
    optionValues: {},
    expanded: false,
  };
  useAppStore.setState({
    projectInterface: {
      task: [{ name: 'weekly', entry: 'weekly', label: '周常任务' }],
      controller: [],
      resource: [],
    },
    instances: [{ id: 'fixture', name: 'fixture', selectedTasks: [task], isRunning }],
    activeInstanceId: 'fixture',
    instanceTaskRunStatus: { fixture: { weekly: status } },
    maaTaskIdMapping: {},
    instanceTaskRunSelection: selection ? { fixture: selection } : {},
  });
  return renderToStaticMarkup(React.createElement(TaskItem, { instanceId: 'fixture', task }));
}

test('折叠卡片在启动前明确显示今日不参与，保留勾选并隐藏旧成功结果', (t) => {
  const html = renderTask(t);
  const header = html.split('grid transition-')[0];
  assert.match(header, /今日不参与/);
  assert.match(header, /aria-checked="true"/);
  assert.doesNotMatch(html, /bg-success/);
});

test('运行中周计划排除项复用未勾选任务的紧凑样式，不另加未纳入标签', (t) => {
  const html = renderTask(t, {
    isRunning: true,
    selection: { weekday: 0, includedTaskIds: ['daily'], excludedByWeeklyScheduleIds: ['weekly'] },
  });
  assert.match(html, /px-3 py-1\.5/);
  assert.doesNotMatch(html, /本次未纳入|今日不参与/);
  assert.doesNotMatch(html, /bg-success/);
  assert.doesNotMatch(html, /task-item-running/);
  const instance = useAppStore.getState().instances[0];
  const uncheckedTask = { ...instance.selectedTasks[0], enabled: false, weeklySchedule: undefined };
  useAppStore.setState({
    instances: [{ ...instance, selectedTasks: [uncheckedTask] }],
    instanceTaskRunStatus: { fixture: { weekly: 'idle' } },
    instanceTaskRunSelection: {},
  });
  const uncheckedHtml = renderToStaticMarkup(
    React.createElement(TaskItem, { instanceId: 'fixture', task: uncheckedTask }),
  );
  assert.equal(html, uncheckedHtml);
});

test('单独运行的任务以实际纳入快照为准，不误标为周计划排除', (t) => {
  const html = renderTask(t, {
    isRunning: true,
    status: 'running',
    selection: { weekday: 3, includedTaskIds: ['weekly'], excludedByWeeklyScheduleIds: [] },
  });
  const header = html.split('grid transition-')[0];
  assert.doesNotMatch(header, /今日不参与|本次未纳入/);
  assert.match(html, /task-item-running/);
});

test('运行中跨午夜后，不把已纳入且完成的任务改标为未参与', (t) => {
  const html = renderTask(t, {
    isRunning: true,
    selection: { weekday: 0, includedTaskIds: ['weekly'], excludedByWeeklyScheduleIds: [] },
  });
  const header = html.split('grid transition-')[0];
  assert.doesNotMatch(header, /今日不参与|本次未纳入/);
  assert.match(html, /bg-success/);
});

test('显式执行结束后保留真实成功结果，不按今天计划抹掉结果', (t) => {
  const html = renderTask(t, {
    selection: { weekday: 3, includedTaskIds: ['weekly'], excludedByWeeklyScheduleIds: [] },
  });
  const header = html.split('grid transition-')[0];
  assert.doesNotMatch(header, /今日不参与|本次未纳入/);
  assert.match(html, /bg-success/);
});

test('刷新恢复正在运行的任务时，后端事实优先于没有快照的今日预览', (t) => {
  const html = renderTask(t, { isRunning: true, status: 'running' });
  const header = html.split('grid transition-')[0];
  assert.doesNotMatch(header, /今日不参与|本次未纳入/);
  assert.match(html, /task-item-running/);
});

test('重新启动全部排除时，不再显示上一批成功；下一批纳入后恢复真实状态', (t) => {
  renderTask(t);
  const { instances } = useAppStore.getState();
  const tasks = instances[0].selectedTasks;
  useAppStore
    .getState()
    .setTaskRunSelection('fixture', createTaskRunSelection(filterTasksForRun(tasks, 3), 3));
  let html = renderToStaticMarkup(
    React.createElement(TaskItem, { instanceId: 'fixture', task: tasks[0] }),
  );
  assert.doesNotMatch(html, /bg-success/);
  const selection = createTaskRunSelection(filterTasksForRun(tasks, 0), 0);
  useAppStore.getState().setTaskRunSelection('fixture', selection);
  useAppStore.setState({ instances: [{ ...instances[0], isRunning: true }] });
  html = renderToStaticMarkup(
    React.createElement(TaskItem, { instanceId: 'fixture', task: tasks[0] }),
  );
  assert.match(html, /bg-success/);
  useAppStore.getState().clearTaskRunStatus('fixture');
  assert.equal(useAppStore.getState().instanceTaskRunSelection.fixture, undefined);
});

test('工具栏移除参与统计小字，仍禁用空运行；仪表盘保留未启动原因', (t) => {
  renderTask(t);
  const toolbar = renderToStaticMarkup(
    React.createElement(Toolbar, { showAddPanel: false, onToggleAddPanel: () => {} }),
  );
  assert.doesNotMatch(toolbar, /本次计划参与|周计划排除|weeklySchedulePreview/);
  assert.match(toolbar, /data-role="start-stop-button" disabled=""/);
  useAppStore.setState({
    instanceConnectionStatus: { fixture: 'Connected' },
    instanceResourceLoaded: { fixture: true },
  });
  const dashboard = renderToStaticMarkup(React.createElement(DashboardView, { onClose: () => {} }));
  assert.match(dashboard, /未启动任务：今天没有符合周计划的已选任务/);
});

test('跨端新批次的真实完成结果不会被旧排除快照遮盖，旧批次回填仍被区分', (t) => {
  renderTask(t, {
    selection: { weekday: 3, includedTaskIds: ['daily'], excludedByWeeklyScheduleIds: ['weekly'] },
  });
  useAppStore.setState({ maaTaskIdMapping: { fixture: { 1: 'weekly' } } });
  const states = {
    instances: {
      fixture: {
        connected: true,
        resourceLoaded: true,
        isRunning: false,
        taskRunState: {
          statuses: { weekly: 'succeeded' },
          mappings: { 1: 'weekly' },
          overallStatus: 'Succeeded',
        },
      },
    },
    cachedAdbDevices: [],
    cachedWin32Windows: [],
    cachedWlrootsSockets: [],
    cachedGamescopeInstances: [],
  };
  const task = useAppStore.getState().instances[0].selectedTasks[0];
  useAppStore.getState().restoreBackendStates(states);
  let html = renderToStaticMarkup(React.createElement(TaskItem, { instanceId: 'fixture', task }));
  assert.doesNotMatch(html, /bg-success/);
  states.instances.fixture.taskRunState.mappings = { 2: 'weekly' };
  useAppStore.getState().restoreBackendStates(states);
  html = renderToStaticMarkup(React.createElement(TaskItem, { instanceId: 'fixture', task }));
  assert.match(html, /bg-success/);
  assert.doesNotMatch(html.split('grid transition-')[0], /本次未纳入/);
});
