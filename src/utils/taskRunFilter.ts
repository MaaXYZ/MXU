import type { SelectedTask } from '@/types/interface';

export interface TaskRunFilterOptions {
  /** 从此任务开始运行（包含该任务，忽略之前的任务） */
  startFromTaskId?: string;
  /** 仅运行指定任务 */
  singleTaskId?: string;
}

/** 判断任务是否应在常规启动时被包含（容器子任务随容器执行，不进入主队列） */
export function isTaskSelectedForRun(task: SelectedTask): boolean {
  if (task.parentId) return false;
  return task.enabled || Boolean(task.runOnce);
}

/** 根据运行模式筛选待执行任务 */
export function filterTasksForRun(
  tasks: SelectedTask[],
  options?: TaskRunFilterOptions,
): SelectedTask[] {
  if (options?.singleTaskId) {
    const task = tasks.find((t) => t.id === options.singleTaskId);
    return task ? [task] : [];
  }

  let startIndex = 0;
  if (options?.startFromTaskId) {
    const idx = tasks.findIndex((t) => t.id === options.startFromTaskId);
    if (idx < 0) return [];
    startIndex = idx;
  }

  const sliced = tasks.slice(startIndex);
  if (sliced.length === 0) return [];

  if (options?.startFromTaskId) {
    const [anchor, ...rest] = sliced;
    return [anchor, ...rest.filter(isTaskSelectedForRun)];
  }

  return sliced.filter(isTaskSelectedForRun);
}
