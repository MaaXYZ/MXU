import { closestCenter, type CollisionDetection } from '@dnd-kit/core';

export const taskCollisionDetection: CollisionDetection = (args) => {
  const { pointerCoordinates, droppableRects, droppableContainers } = args;
  // Keyboard sorting has no pointer; retain its existing collision strategy.
  if (!pointerCoordinates) return closestCenter(args);

  return droppableContainers
    .flatMap((container) => {
      const rect = droppableRects.get(container.id);
      if (!rect) return [];
      // Hit the whole vertical interval, including the top of a tall expanded task.
      // In gaps or beyond the list, use the nearest edge instead of the card center.
      // Ignore X: these lists only reorder vertically, even when task widths vary.
      return [
        {
          id: container.id,
          data: {
            droppableContainer: container,
            value: Math.max(rect.top - pointerCoordinates.y, pointerCoordinates.y - rect.bottom, 0),
          },
        },
      ];
    })
    .sort((a, b) => a.data.value - b.data.value);
};
