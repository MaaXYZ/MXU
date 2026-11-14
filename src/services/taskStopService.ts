import { loggers } from '@/utils/logger';
import { isTauri } from '@/utils/paths';
import { useAppStore } from '@/stores/appStore';

import { maaService } from './maaService';
import { cancelTaskQueueMonitor } from './taskMonitor';

const log = loggers.task;

const STOP_TIMEOUT_MS = 8000;
const STOP_POLL_INTERVAL_MS = 100;

const stopPromises = new Map<string, Promise<boolean>>();

async function waitForTaskStop(instanceId: string) {
  const start = Date.now();

  while (Date.now() - start < STOP_TIMEOUT_MS) {
    const running = await maaService.isRunning(instanceId);
    if (running === false) {
      return true;
    }

    // Stop targets the instance. Reposting after another client restarts
    // would cancel its new queue if we missed the idle interval.
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }

  return false;
}

function cleanupTaskState(instanceId: string) {
  const state = useAppStore.getState();
  state.updateInstance(instanceId, { isRunning: false });
  state.setInstanceTaskStatus(instanceId, null);
  state.setInstanceCurrentTaskId(instanceId, null);
  state.clearScheduleExecution(instanceId);
}

export async function stopInstanceTasks(instanceId: string): Promise<boolean> {
  const existing = stopPromises.get(instanceId);
  if (existing) {
    return existing;
  }

  const stopPromise = (async () => {
    log.info(`[task-stop#${instanceId}] 停止任务`);

    try {
      await maaService.stopTask(instanceId);
    } catch (error) {
      const stillRunning = await maaService.isRunning(instanceId).catch(() => null);
      if (stillRunning !== false) {
        throw error;
      }
      log.info(`[task-stop#${instanceId}] Tasker 已停止，跳过首次 stop 错误`);
    }

    const stopped = await waitForTaskStop(instanceId);
    if (!stopped) {
      log.warn(`[task-stop#${instanceId}] 等待任务停止超时，保留运行状态`);
      return false;
    }

    cancelTaskQueueMonitor(instanceId);

    // Backend idle already includes this run's Agent cleanup. A new stopAgent
    // RPC here could target the next run started by another client meanwhile.
    cleanupTaskState(instanceId);
    return true;
  })().finally(() => {
    stopPromises.delete(instanceId);
  });

  stopPromises.set(instanceId, stopPromise);
  return stopPromise;
}

export async function stopInstanceTasksAndExitApp(instanceId: string): Promise<boolean> {
  const stopped = await stopInstanceTasks(instanceId);
  if (!stopped) {
    return false;
  }

  if (!isTauri()) {
    return true;
  }

  log.info(`[task-stop#${instanceId}] 任务已停止，请求退出应用`);
  const { exit } = await import('@tauri-apps/plugin-process');
  await exit(0);
  return true;
}
