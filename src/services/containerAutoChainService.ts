import { useAppStore } from '@/stores/appStore';
import { isContainerTaskName } from '@/types/containerTasks';
import {
  getContainerCurrentIndex,
  getContainerMode,
  refreshContainerStatusNow,
} from '@/services/containerStatusService';
import { taskStartService } from '@/services/taskStartService';

let started = false;
/** 各实例本次运行的起始槽位（用于判断这次运行是否推进了轮换） */
const runStartIndex = new Map<string, number>();
/** 正在接力的实例，避免重入 */
const chainingInstances = new Set<string>();

/**
 * 容器自动接力：某次容器运行因槽位达标而自然结束后，自动带着下一个槽位
 * 自己的配置启动下一次运行；直到某次运行没有推进槽位（理智不足等自然停止）、
 * 运行失败或实例被手动停止。仅在理智模式下启用（日期模式由日期驱动轮换）。
 */
export function initContainerAutoChain(): void {
  if (started) return;
  started = true;

  useAppStore.subscribe((state, prev) => {
    for (const instance of state.instances) {
      const prevInstance = prev.instances.find((i) => i.id === instance.id);
      if (!prevInstance || prevInstance.isRunning === instance.isRunning) continue;

      const container = instance.selectedTasks.find(
        (t) => isContainerTaskName(t.taskName) && !t.parentId,
      );
      if (!container) continue;

      if (!prevInstance.isRunning && instance.isRunning) {
        // 运行开始：记录起始槽位
        void refreshContainerStatusNow().then(() => {
          const index = getContainerCurrentIndex(container.taskName);
          if (index !== undefined) runStartIndex.set(instance.id, index);
        });
        continue;
      }

      // 运行结束：仅“自然成功且槽位已推进”时接力（失败/手动停止不接力）
      const startedIndex = runStartIndex.get(instance.id);
      runStartIndex.delete(instance.id);
      const runStatus = state.instanceTaskRunStatus[instance.id]?.[container.id];
      if (runStatus !== 'succeeded' || startedIndex === undefined) continue;
      if (getContainerMode(container.taskName) !== 'sanity') continue;

      void refreshContainerStatusNow().then(() => {
        const nowIndex = getContainerCurrentIndex(container.taskName);
        if (nowIndex === undefined || nowIndex === startedIndex) return;
        if (chainingInstances.has(instance.id)) return;
        const latest = useAppStore.getState().instances.find((i) => i.id === instance.id);
        if (!latest || latest.isRunning) return;
        chainingInstances.add(instance.id);
        void taskStartService
          .start(latest, { singleTaskId: container.id })
          .finally(() => chainingInstances.delete(instance.id));
      });
    }
  });
}
