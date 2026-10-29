import type { SelectedTask } from '@/types/interface';

export interface TaskRunFilterOptions {
  /** 从此任务开始运行（包含该任务，忽略之前的任务） */
  startFromTaskId?: string;
  /** 仅运行指定任务 */
  singleTaskId?: string;
}

/** 获取指定时刻的星期（0-6，0=周日），用于周计划判断 */
export function getWeekdayOf(date: Date = new Date()): number {
  return date.getDay();
}

/** 任务是否被用户选中参与运行（勾选或单次运行） */
export function isTaskChecked(task: SelectedTask): boolean {
  return task.enabled || Boolean(task.runOnce);
}

/** 清理配置或共享数据中的周计划；没有有效星期时视为未启用。 */
export function normalizeWeeklySchedule(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const weekdays = value.filter(
    (day): day is number =>
      typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
  );
  const normalized = [...new Set(weekdays)].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 判断任务是否被周计划放行。
 * 缺省或空数组表示未启用周计划，一律放行。
 */
export function isTaskAllowedByWeeklySchedule(task: SelectedTask, todayWeekday: number): boolean {
  const schedule = normalizeWeeklySchedule(task.weeklySchedule);
  if (!schedule) {
    return true;
  }
  return schedule.includes(todayWeekday);
}

/**
 * 任务是否因周计划而在今天被跳过。
 * - 单次运行（runOnce）是用户的显式意图，优先级高于周计划，不会被跳过；
 * - 未勾选的任务不属于"被跳过"。
 */
export function isTaskBlockedByWeeklySchedule(task: SelectedTask, todayWeekday: number): boolean {
  if (task.runOnce) return false;
  if (!task.enabled) return false;
  return !isTaskAllowedByWeeklySchedule(task, todayWeekday);
}

/**
 * 判断任务是否应在常规启动时被包含。
 * 显式操作路径（单次运行、从此处运行的锚点）不受周计划约束。
 */
export function isTaskSelectedForRun(task: SelectedTask, todayWeekday: number): boolean {
  return isTaskChecked(task) && !isTaskBlockedByWeeklySchedule(task, todayWeekday);
}

export interface TaskRunFilterResult {
  /** 本次实际参与运行的任务 */
  tasks: SelectedTask[];
  /** 已勾选、但因周计划不含今天而被跳过的任务（仅常规路径会产生） */
  skippedByWeeklySchedule: SelectedTask[];
}

/** 启动时的参与快照；未纳入不是一种任务执行结果。 */
export interface TaskRunSelection {
  weekday: number;
  includedTaskIds: string[];
  excludedByWeeklyScheduleIds: string[];
}

export function createTaskRunSelection(
  result: TaskRunFilterResult,
  weekday: number,
): TaskRunSelection {
  return {
    weekday,
    includedTaskIds: result.tasks.map((task) => task.id),
    excludedByWeeklyScheduleIds: result.skippedByWeeklySchedule.map((task) => task.id),
  };
}

/** 提取"已勾选但今天不在周计划内"的任务（未勾选、单次运行的任务不算） */
function collectWeeklySkipped(tasks: SelectedTask[], todayWeekday: number): SelectedTask[] {
  return tasks.filter((task) => isTaskBlockedByWeeklySchedule(task, todayWeekday));
}

/**
 * 根据运行模式筛选待执行任务。
 *
 * 周计划仅在常规启动路径生效：
 * - `singleTaskId`（单独运行）为显式操作，不做周计划过滤；
 * - `startFromTaskId`（从此处运行）的锚点任务为显式操作，不做周计划过滤，
 *   锚点之后的任务仍按周计划筛选。
 */
export function filterTasksForRun(
  tasks: SelectedTask[],
  todayWeekday: number,
  options?: TaskRunFilterOptions,
): TaskRunFilterResult {
  // 仅运行指定任务：显式操作，绕过周计划
  if (options?.singleTaskId) {
    const task = tasks.find((t) => t.id === options.singleTaskId);
    return { tasks: task ? [task] : [], skippedByWeeklySchedule: [] };
  }

  let startIndex = 0;
  if (options?.startFromTaskId) {
    const idx = tasks.findIndex((t) => t.id === options.startFromTaskId);
    if (idx < 0) return { tasks: [], skippedByWeeklySchedule: [] };
    startIndex = idx;
  }

  const sliced = tasks.slice(startIndex);
  if (sliced.length === 0) return { tasks: [], skippedByWeeklySchedule: [] };

  // 从此处运行：锚点任务为显式操作，绕过周计划
  if (options?.startFromTaskId) {
    const [anchor, ...rest] = sliced;
    return {
      tasks: [anchor, ...rest.filter((t) => isTaskSelectedForRun(t, todayWeekday))],
      skippedByWeeklySchedule: collectWeeklySkipped(rest, todayWeekday),
    };
  }

  return {
    tasks: sliced.filter((t) => isTaskSelectedForRun(t, todayWeekday)),
    skippedByWeeklySchedule: collectWeeklySkipped(sliced, todayWeekday),
  };
}
