import { useLayoutEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { getSkinTaskState } from './state';
import { useSkinMotion } from './useSkinMotion';
import './shell.css';
import './workspace.css';
import './ocean.css';
import './pond.css';
import './gugugaga.css';

/** Applies the bundled skin around the shared application layout. */
export function BuiltinSkinShell({ children }: { children: ReactNode }) {
  const { skinId, reduced, running, status } = useAppStore(
    useShallow((state) => ({
      skinId: state.skinId,
      reduced: state.skinReducedMotion,
      running: !!state.instances.find((instance) => instance.id === state.activeInstanceId)
        ?.isRunning,
      status: state.activeInstanceId ? state.instanceTaskStatus[state.activeInstanceId] : null,
    })),
  );
  const { systemReduced, pageVisible } = useSkinMotion();
  const motion = reduced || systemReduced ? 'reduced' : pageVisible ? 'full' : 'paused';
  const taskState = getSkinTaskState(running, status);

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
