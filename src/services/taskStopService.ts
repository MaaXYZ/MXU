import { loggers } from '@/utils/logger';
import { isTauri } from '@/utils/paths';
import { useAppStore } from '@/stores/appStore';

import { maaService } from './maaService';
import { taskExecutionGate } from './taskExecutionGate';
import { cancelTaskQueueMonitor } from './taskMonitor';

const log = loggers.task;

const STOP_TIMEOUT_MS = 8000;
const STOP_REPOST_INTERVAL_MS = 800;
const STOP_POLL_INTERVAL_MS = 100;

const stopPromises = new Map<string, Promise<boolean>>();

async function waitForTaskStop(instanceId: string) {
  const start = Date.now();
  let lastPost = start;

  while (Date.now() - start < STOP_TIMEOUT_MS) {
    const running = await maaService.isRunning(instanceId);
    const admission = await maaService.executionStatus(instanceId);
    if (!running && !admission.busy) {
      return true;
    }

    if (Date.now() - lastPost >= STOP_REPOST_INTERVAL_MS) {
      try {
        await maaService.stopTask(instanceId);
        lastPost = Date.now();
      } catch (error) {
        log.warn(`[task-stop#${instanceId}] 重发停止请求失败:`, error);
      }
    }

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
  const lease = taskExecutionGate.get(instanceId);
  taskExecutionGate.cancel(instanceId);
  const existing = stopPromises.get(instanceId);
  if (existing) {
    return existing;
  }

  const stopPromise = (async () => {
    log.info(`[task-stop#${instanceId}] 停止任务`);
    if (lease) {
      await maaService.setPreActionStop(instanceId, true).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        lease.settled.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained) return false;
      if (lease.source === 'mcp') return true;
    }

    try {
      await maaService.stopTask(instanceId);
    } catch (error) {
      const stillRunning = await maaService.isRunning(instanceId).catch(() => false);
      if (stillRunning) {
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

  const { exit } = await import('@tauri-apps/plugin-process');
  await exit(0);
  return true;
}
