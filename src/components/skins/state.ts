import type { TaskStatus } from '@/types/maa';

export type SkinTaskState = 'idle' | 'running' | 'success' | 'error';

/** Only map facts the host currently supplies. A stopped batch has no cancellation reason. */
export function getSkinTaskState(isRunning: boolean, status?: TaskStatus | null): SkinTaskState {
  if (isRunning) return 'running';
  if (status === 'Succeeded') return 'success';
  if (status === 'Failed') return 'error';
  return 'idle';
}
