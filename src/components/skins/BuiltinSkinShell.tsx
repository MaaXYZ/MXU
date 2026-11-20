import { useLayoutEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { selectSkinTaskState } from './state';
import { useSkinMotion } from './useSkinMotion';
import './shell.css';
import './workspace.css';
import './ocean.css';
import './pond.css';
import './gugugaga.css';

// The still and laughter come from different source frames with different white backgrounds.
const NAIWA_ALPHA_ROWS = {
  'mxu-naiwa-cutout': '4 0 -7 0 1.98',
  'mxu-naiwa-laugh-cutout': '0 0 -8 0 7.68',
};

/** Applies the bundled skin around the shared application layout. */
export function BuiltinSkinShell({ children }: { children: ReactNode }) {
  const { skinId, reduced, taskState } = useAppStore(
    useShallow((state) => ({
      skinId: state.skinId,
      reduced: state.skinReducedMotion,
      taskState: selectSkinTaskState(state),
    })),
  );
  const { systemReduced, pageVisible } = useSkinMotion();
  const motion = reduced || systemReduced ? 'reduced' : pageVisible ? 'full' : 'paused';

  // Portals (menus/tooltips/dialogs) inherit the same palette as the application.
  // Host accent/semantic tokens remain untouched; selecting default restores inheritance.
  useLayoutEffect(() => {
    const body = document.body;
    const previousSkin = body.getAttribute('data-mxu-skin');
    const previousMotion = body.getAttribute('data-skin-motion');
    body.setAttribute('data-mxu-skin', skinId);
    body.setAttribute('data-skin-motion', motion);
    return () => {
      if (previousSkin === null) body.removeAttribute('data-mxu-skin');
      else body.setAttribute('data-mxu-skin', previousSkin);
      if (previousMotion === null) body.removeAttribute('data-skin-motion');
      else body.setAttribute('data-skin-motion', previousMotion);
    };
  }, [skinId, motion]);

  return (
    <div
      className="skin-shell h-full relative"
      data-mxu-skin={skinId}
      data-skin-motion={motion}
      data-task-state={taskState}
    >
      {skinId === 'naiwa' && (
        <svg className="absolute" width="0" height="0" aria-hidden="true">
          {Object.entries(NAIWA_ALPHA_ROWS).map(([id, alpha]) => (
            <filter key={id} id={id} colorInterpolationFilters="sRGB">
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${alpha}`}
                result="matte"
              />
              <feComposite in="SourceGraphic" in2="matte" operator="in" />
            </filter>
          ))}
        </svg>
      )}
      {skinId !== 'default' && (
        <div className="skin-atmosphere" data-skin-ambient aria-hidden="true">
          <div className="skin-atmosphere__orb" />
          <div className="skin-atmosphere__orb" />
          <div className="skin-atmosphere__orb" />
          <svg className="skin-atmosphere__waves" viewBox="0 0 1440 320" preserveAspectRatio="none">
            <path d="M0 130 Q360 0 720 130 T1440 130 V320 H0Z" />
            <path d="M0 190 Q360 70 720 190 T1440 190 V320 H0Z" />
            <path d="M0 250 Q360 140 720 250 T1440 250 V320 H0Z" />
          </svg>
        </div>
      )}
      {children}
    </div>
  );
}
