import { useLayoutEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { getSkinTaskState } from './state';
import { useSkinMotion } from './useSkinMotion';
import './shell.css';
import './gugugaga.css';

/** Trusted bundled presentation. No scene code can issue business commands. */
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
        <div className="skin-atmosphere" data-skin-ambient aria-hidden="true" />
      )}
      {children}
    </div>
  );
}
