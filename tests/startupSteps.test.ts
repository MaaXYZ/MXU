import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionConfig,
  Instance,
  ProjectInterface,
  SelectedTask,
} from '../src/types/interface';

import { getStartupSteps, reorderStartupSteps } from '../src/utils/startupSteps.ts';

const pi: ProjectInterface = {
  interface_version: 2,
  name: 'Test',
  controller: [],
  resource: [],
  task: [],
  pretask: [
    { name: 'Settings', exec: 'settings' },
    { name: 'Launch', exec: 'launcher' },
  ],
};
const task = (name: string): SelectedTask => ({
  id: name,
  taskName: '__MXU_PRETASK__' + name,
  enabled: true,
  optionValues: {},
  expanded: false,
});
const action = (id: string): ActionConfig => ({
  id,
  enabled: true,
  program: id,
  args: '',
  waitForExit: true,
  skipIfRunning: false,
  useCmd: false,
});
function fixture(): Instance {
  return {
    id: 'instance',
    name: 'Test',
    isRunning: false,
    selectedTasks: [task('Launch'), { ...task('Daily'), taskName: 'Daily' }, task('Settings')],
    preActions: [action('Wake'), action('AfterLaunch')],
  };
}
const ids = (instance: Instance) => getStartupSteps(instance, pi).map(({ item }) => item.id);

test('legacy configs keep PI declaration order before external programs', () => {
  assert.deepEqual(ids(fixture()), ['Settings', 'Launch', 'Wake', 'AfterLaunch']);
});

test('programs and pretasks interleave without moving ordinary game tasks', () => {
  const original = fixture();
  const moved = reorderStartupSteps(original, pi, 2, 0);
  assert.deepEqual(ids(moved), ['Wake', 'Settings', 'Launch', 'AfterLaunch']);
  assert.deepEqual(
    moved.selectedTasks.map(({ id }) => id),
    ['Launch', 'Daily', 'Settings'],
  );
  assert.deepEqual(ids(original), ['Settings', 'Launch', 'Wake', 'AfterLaunch']);
  assert.deepEqual(ids(reorderStartupSteps(moved, pi, 2, 1)), [
    'Wake',
    'Launch',
    'Settings',
    'AfterLaunch',
  ]);
});

test('mixed order survives saved JSON and regenerated IDs when copying instances', () => {
  const moved = reorderStartupSteps(fixture(), pi, 2, 0);
  const restored: Instance = JSON.parse(JSON.stringify(moved));
  assert.deepEqual(ids(restored), ['Wake', 'Settings', 'Launch', 'AfterLaunch']);
  restored.selectedTasks = restored.selectedTasks.map((t) => ({ ...t, id: 'copy-' + t.id }));
  restored.preActions = restored.preActions?.map((a) => ({ ...a, id: 'copy-' + a.id }));
  assert.deepEqual(ids(restored), [
    'copy-Wake',
    'copy-Settings',
    'copy-Launch',
    'copy-AfterLaunch',
  ]);
});

test('disabled steps keep their position when re-enabled and new steps append', () => {
  const moved = reorderStartupSteps(fixture(), pi, 2, 0);
  moved.preActions![0].enabled = false;
  assert.deepEqual(ids(moved), ['Wake', 'Settings', 'Launch', 'AfterLaunch']);
  moved.preActions![0].enabled = true;
  moved.preActions!.push(action('New'));
  assert.deepEqual(ids(moved), ['Wake', 'Settings', 'Launch', 'AfterLaunch', 'New']);
});

test('deleted steps do not leave stale ordering references; invalid moves are ignored', () => {
  const moved = reorderStartupSteps(fixture(), pi, 2, 0);
  moved.preActions = moved.preActions!.slice(1);
  assert.deepEqual(ids(moved), ['Settings', 'Launch', 'AfterLaunch']);
  assert.equal(reorderStartupSteps(moved, pi, -1, 0), moved);
  assert.equal(reorderStartupSteps(moved, pi, 0, 50), moved);
});
