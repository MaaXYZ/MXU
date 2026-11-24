import type { TaskRunStatus, TaskTiming } from '@/stores/types';

/**
 * 根据相邻两次任务状态更新计时：
 * - 进入 running：重置开始时间
 * - running → succeeded/failed：补结束时间
 * - 首次观察到终态（快照间隔内已完成）：补一条 0 秒记录
 * - 实例停止但后端仍报 running：按结束处理
 * - 回到 idle/pending：清空
 */
export function updateTaskTiming(
  previous: TaskTiming | undefined,
  previousStatus: TaskRunStatus | undefined,
  nextStatus: TaskRunStatus,
  now: number,
  options?: { runningEnded?: boolean },
): TaskTiming | undefined {
  if (nextStatus === 'running') {
    if (options?.runningEnded) {
      return previous && previous.finishedAt === undefined
        ? { ...previous, finishedAt: now }
        : previous;
    }
    if (previousStatus === 'running' && previous) return previous;
    return { startedAt: now };
  }

  if (nextStatus === 'succeeded' || nextStatus === 'failed') {
    if (!previous) return { startedAt: now, finishedAt: now };
    if (previous.finishedAt !== undefined) return previous;
    return { ...previous, finishedAt: now };
  }

  return undefined;
}

export interface TaskDurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** 拆成时/分/秒，具体文案由各语言包决定 */
export function getTaskDurationParts(milliseconds: number): TaskDurationParts {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/** 本地时间 HH:mm:ss */
export function formatTaskClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
