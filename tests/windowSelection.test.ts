import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discoverInitialWindow,
  selectWindow,
  localizeWindowError,
  WindowTargetError,
  WindowSearchGuard,
} from '../src/utils/windowSelection.ts';
import type { ControllerItem, ResourceItem } from '../src/types/interface';

const game = { handle: 42, class_name: 'UnityWndClass', window_name: 'Example Game' };
const another = { ...game, handle: 43, window_name: 'Example Game 2' };
const controllers: ControllerItem[] = [
  { name: 'Android', type: 'Adb' },
  {
    name: 'Desktop foreground',
    type: 'Win32',
    win32: { class_regex: '^UnityWndClass$', window_regex: '^Example Game' },
  },
  {
    name: 'Desktop background',
    type: 'Win32',
    win32: { class_regex: '^UnityWndClass$', window_regex: '^Example Game' },
  },
];
const resources: ResourceItem[] = [
  { name: 'Android resources', path: [], controller: ['Android'] },
  { name: 'PC resources', path: [], controller: ['Desktop foreground', 'Desktop background'] },
];

test('first launch chooses the first matching desktop controller and compatible resource', async () => {
  const selected = await discoverInitialWindow(
    { controller: controllers, resource: resources },
    async (cls, title) => {
      assert.equal(cls, '^UnityWndClass$');
      assert.equal(title, '^Example Game');
      return [game];
    },
  );
  assert.equal(selected?.window.handle, 42);
  assert.equal(selected?.controller.name, 'Desktop foreground');
  assert.equal(selected?.resource.name, 'PC resources');
});

test('zero windows leave defaults alone and multiple windows require a choice', async () => {
  const pi = { controller: controllers, resource: resources };
  assert.equal(await discoverInitialWindow(pi, async () => []), undefined);
  await assert.rejects(
    discoverInitialWindow(pi, async () => [game, another]),
    { code: 'WINDOW_SELECTION_REQUIRED' },
  );
  await assert.rejects(
    discoverInitialWindow(pi, async () => {
      throw new Error('WINDOW_FILTER_INVALID');
    }),
    /WINDOW_FILTER_INVALID/,
  );
});

test('unconfigured generic Win32 controllers are not guessed on first launch', async () => {
  await discoverInitialWindow(
    { controller: [{ name: 'Any window', type: 'Win32' }], resource: resources },
    async () => {
      assert.fail('unfiltered discovery must not choose a random desktop window');
    },
  );
});

test('history is restored only when unique; invalid history can recover a single candidate', () => {
  assert.equal(selectWindow([game, another], { windowName: another.window_name }), another);
  assert.equal(selectWindow([game], { windowName: 'Explorer' }), game);
  assert.equal(selectWindow([game, game]), game);
  assert.throws(() => selectWindow([]), { code: 'WINDOW_NOT_FOUND' });
  assert.throws(() => selectWindow([game, another]), { code: 'WINDOW_SELECTION_REQUIRED' });
  assert.throws(
    () => selectWindow([game, { ...game, handle: 44 }], { windowName: game.window_name }),
    { code: 'WINDOW_SELECTION_REQUIRED' },
  );
});

test('game restart uses a fresh handle, never the remembered UI cache', () => {
  const restarted = { ...game, handle: 500 };
  assert.equal(selectWindow([restarted], { windowName: game.window_name }).handle, 500);
});

test('late search results do not replace a manual choice, another instance, or a newer search', async () => {
  const guard = new WindowSearchGuard();
  let context = 'desktop-a';
  let selected = 'manual';
  let finish!: () => void;
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stillCurrent = guard.begin(() => context === 'desktop-a');
  const pending = response.then(() => {
    if (stillCurrent()) selected = 'automatic';
  });
  guard.invalidate(); // User chooses a window while discovery is in flight.
  finish();
  await pending;
  assert.equal(selected, 'manual');

  const oldSearch = guard.begin(() => context === 'desktop-a');
  const newSearch = guard.begin(() => context === 'desktop-a');
  assert.equal(oldSearch(), false);
  assert.equal(newSearch(), true);
  context = 'desktop-b';
  assert.equal(newSearch(), false);
});

test('native and HTTP errors localize without losing the error code', () => {
  for (const error of [
    'WINDOW_TARGET_MISMATCH: hwnd=42',
    new Error('HTTP 400: WINDOW_TARGET_MISMATCH: hwnd=42'),
  ]) {
    const localized = localizeWindowError(error, (key) => `translated:${key}`);
    assert.ok(localized instanceof WindowTargetError);
    assert.equal(localized.code, 'WINDOW_TARGET_MISMATCH');
    assert.equal(localized.message, 'translated:windowTarget.mismatch');
  }
  const unrelated = new Error('unrelated');
  assert.equal(
    localizeWindowError(unrelated, () => 'unexpected'),
    unrelated,
  );
});
