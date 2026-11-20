import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestCenter, type CollisionDetection } from '@dnd-kit/core';
import { taskCollisionDetection } from '../src/utils/taskSorting.ts';

type CollisionArgs = Parameters<CollisionDetection>[0];
type Rect = CollisionArgs['collisionRect'];

function rect(top: number, height: number, left = 0): Rect {
  return { top, height, bottom: top + height, left, width: 200, right: left + 200 };
}

function fixture(
  entries: [string, Rect][],
  activeId: string,
  collisionRect: Rect,
  pointerCoordinates: CollisionArgs['pointerCoordinates'],
): CollisionArgs {
  return {
    active: {
      id: activeId,
      data: { current: {} },
      rect: { current: { initial: null, translated: collisionRect } },
    },
    collisionRect,
    pointerCoordinates,
    droppableRects: new Map(entries),
    droppableContainers: entries.map(([id, bounds]) => ({
      id,
      key: id,
      disabled: false,
      data: { current: {} },
      node: { current: null },
      rect: { current: bounds },
    })),
  };
}

test('a tall task moves up when its handle reaches the previous task', () => {
  const args = fixture(
    [
      ['previous', rect(0, 48)],
      ['active', rect(56, 720)],
    ],
    'active',
    rect(0, 720),
    { x: 20, y: 24 },
  );
  // Reproduces #452: the whole-card center still selects the original task.
  assert.equal(closestCenter(args)[0].id, 'active');
  assert.equal(taskCollisionDetection(args)[0].id, 'previous');
});

test('entering the top of an expanded target selects that target', () => {
  const args = fixture(
    [
      ['previous', rect(0, 48)],
      ['expanded', rect(56, 720)],
      ['active', rect(784, 48)],
    ],
    'active',
    rect(56, 48),
    { x: 20, y: 80 },
  );
  assert.equal(closestCenter(args)[0].id, 'previous');
  assert.equal(taskCollisionDetection(args)[0].id, 'expanded');
});

test('starting near the handle of a tall task does not jump to its neighbor', () => {
  const args = fixture(
    [
      ['previous', rect(0, 48)],
      ['active', rect(56, 720)],
      ['next', rect(784, 48)],
    ],
    'active',
    rect(46, 720),
    { x: 20, y: 70 },
  );
  assert.equal(taskCollisionDetection(args)[0].id, 'active');
  // Comparing pointer-to-center instead would incorrectly select "previous".
  assert.equal(closestCenter({ ...args, collisionRect: rect(70, 0) })[0].id, 'previous');
});

test('moving down and reversing follows the pointer, independent of card height', () => {
  const args = fixture(
    [
      ['active', rect(-600, 720)],
      ['next', rect(128, 48)],
      ['last', rect(184, 48)],
    ],
    'active',
    rect(130, 720),
    { x: 20, y: 150 },
  );
  assert.equal(taskCollisionDetection(args)[0].id, 'next');
  args.pointerCoordinates!.y = 210;
  assert.equal(taskCollisionDetection(args)[0].id, 'last');
  args.pointerCoordinates!.y = 150;
  assert.equal(taskCollisionDetection(args)[0].id, 'next');
});

test('gaps use the nearest edge and list extremes stay reachable', () => {
  const args = fixture(
    [
      ['first', rect(0, 48)],
      ['expanded', rect(56, 720)],
    ],
    'first',
    rect(0, 48),
    { x: 20, y: 0 },
  );
  for (const [y, expected] of [
    [-50, 'first'],
    [48, 'first'],
    [50, 'first'],
    [54, 'expanded'],
    [56, 'expanded'],
    [900, 'expanded'],
  ] as const) {
    args.pointerCoordinates!.y = y;
    assert.equal(taskCollisionDetection(args)[0].id, expected, `pointer y=${y}`);
  }
});

test('decorative horizontal offsets do not change pointer sorting', () => {
  const args = fixture(
    [
      ['first', rect(0, 48, 0)],
      ['offset', rect(56, 100, 500)],
    ],
    'first',
    rect(0, 48),
    { x: -1000, y: 80 },
  );
  assert.equal(taskCollisionDetection(args)[0].id, 'offset');
  args.pointerCoordinates!.x = 2000;
  assert.equal(taskCollisionDetection(args)[0].id, 'offset');
});

test('scrolling uses current viewport rectangles', () => {
  const args = fixture(
    [
      ['active', rect(0, 720)],
      ['next', rect(728, 48)],
    ],
    'active',
    rect(0, 720),
    { x: 20, y: 150 },
  );
  assert.equal(taskCollisionDetection(args)[0].id, 'active');
  args.droppableRects = new Map([
    ['active', rect(-600, 720)],
    ['next', rect(128, 48)],
  ]);
  assert.equal(taskCollisionDetection(args)[0].id, 'next');
});

test('unmeasured containers and empty lists do not create targets', () => {
  const args = fixture([['missing', rect(0, 48)]], 'missing', rect(0, 48), { x: 0, y: 0 });
  args.droppableRects.clear();
  assert.deepEqual(taskCollisionDetection(args), []);
  args.droppableContainers = [];
  assert.deepEqual(taskCollisionDetection(args), []);
});

test('keyboard sorting retains the default center collision behavior', () => {
  const args = fixture(
    [
      ['first', rect(0, 48)],
      ['next', rect(56, 720)],
    ],
    'first',
    rect(56, 720),
    null,
  );
  assert.deepEqual(taskCollisionDetection(args), closestCenter(args));
});
