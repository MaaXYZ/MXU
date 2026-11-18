import { closestCenter, type CollisionDetection } from '@dnd-kit/core';

/** A winding single-column route still orders by Y, regardless of decorative X offsets. */
const closestVerticalCenter: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  const center = collisionRect.top + collisionRect.height / 2;
  return droppableContainers
    .flatMap((container) => {
      const rect = droppableRects.get(container.id);
      return rect
        ? [
            {
              id: container.id,
              data: {
                droppableContainer: container,
                value: Math.abs(center - rect.top - rect.height / 2),
              },
            },
          ]
        : [];
    })
    .sort((a, b) => a.data.value - b.data.value);
};

function withVerticalPointer(fallback: CollisionDetection): CollisionDetection {
  return (args) => {
    const { pointerCoordinates, droppableRects, droppableContainers } = args;
    // Keyboard sorting has no pointer; retain its existing collision strategy.
    if (!pointerCoordinates) return fallback(args);

    return droppableContainers
      .flatMap((container) => {
        const rect = droppableRects.get(container.id);
        if (!rect) return [];
        // Hit the whole vertical interval, including the top of a tall expanded task.
        // In gaps or beyond the list, use the nearest edge instead of the card center.
        // Ignore X: these lists only reorder vertically, even in winding skins.
        return [
          {
            id: container.id,
            data: {
              droppableContainer: container,
              value: Math.max(
                rect.top - pointerCoordinates.y,
                pointerCoordinates.y - rect.bottom,
                0,
              ),
            },
          },
        ];
      })
      .sort((a, b) => a.data.value - b.data.value);
  };
}

export const taskCollisionDetection = withVerticalPointer(closestCenter);
export const verticalTaskCollisionDetection = withVerticalPointer(closestVerticalCenter);
