import { useLayoutEffect, useState, type RefObject } from 'react';

const VIEWPORT_GAP = 8;

/** Keep fixed panels visible when their anchor moves from a top bar to a scene rail. */
export function useAnchoredPanelPosition(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  visible = true,
) {
  const [position, setPosition] = useState({ top: VIEWPORT_GAP, left: VIEWPORT_GAP });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!visible || !anchor || !panel) return;

    let frame: number | null = null;
    const update = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - panelRect.width - VIEWPORT_GAP);
      const maxTop = Math.max(VIEWPORT_GAP, window.innerHeight - panelRect.height - VIEWPORT_GAP);
      const below = anchorRect.bottom + VIEWPORT_GAP;
      const above = anchorRect.top - panelRect.height - VIEWPORT_GAP;
      const preferredTop = below <= maxTop ? below : above >= VIEWPORT_GAP ? above : below;
      const top = Math.max(VIEWPORT_GAP, Math.min(preferredTop, maxTop));
      const left = Math.max(VIEWPORT_GAP, Math.min(anchorRect.right - panelRect.width, maxLeft));
      setPosition((previous) =>
        previous.top === top && previous.left === left ? previous : { top, left },
      );
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };

    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    observer.observe(panel);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [anchorRef, panelRef, visible]);

  return position;
}
