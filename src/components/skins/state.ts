import type { TaskStatus } from '@/types/maa';
import type { AppState } from '@/stores/types';

export type SkinTaskState = 'idle' | 'running' | 'success' | 'error';

/** Only map facts the host currently supplies. A stopped batch has no cancellation reason. */
export function getSkinTaskState(isRunning: boolean, status?: TaskStatus | null): SkinTaskState {
  if (isRunning) return 'running';
  if (status === 'Succeeded') return 'success';
  if (status === 'Failed') return 'error';
  return 'idle';
}

export function selectSkinTaskState(state: AppState): SkinTaskState {
  const { activeInstanceId, instances, instanceTaskStatus } = state;
  const instance = instances.find((item) => item.id === activeInstanceId);
  return getSkinTaskState(
    !!instance?.isRunning,
    activeInstanceId ? instanceTaskStatus[activeInstanceId] : null,
  );
}
