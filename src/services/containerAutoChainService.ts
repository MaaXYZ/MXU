import { useAppStore } from '@/stores/appStore';
import { isContainerTaskName } from '@/types/containerTasks';
import {
  getContainerMode,
  getContainerRotatedThisBattle,
  getContainerSlotTaskNames,
  refreshContainerStatusNow,
} from '@/services/containerStatusService';
import { taskStartService } from '@/services/taskStartService';

let started = false;
/** 正在接力的实例，避免重入 */
const chainingInstances = new Set<string>();

/** 状态文件写入竞争时的重试间隔 */
const RETRY_DELAY_MS = 500;

/**
 * 容器自动接力：某次容器运行因槽位达标而自然结束后，自动带着下一个槽位
 * 自己的配置启动下一次运行；直到某次运行没有推进槽位（理智不足等自然停止）、
 * 运行失败或实例被手动停止。仅在理智模式下启用（日期模式由日期驱动轮换）。
 *
 * 是否发生了轮换以状态文件的 `rotated_this_battle` 标记为准（达标轮换后由
 * 项目侧置位、下次进入时清除），不依赖槽位索引是否变化——单槽位容器达标后
 * 索引不变，首次运行开始时也可能还没有状态文件，索引比较会漏掉这两种情况。
 */
export function initContainerAutoChain(): void {
  if (started) return;
  started = true;

  useAppStore.subscribe((state, prev) => {
    for (const instance of state.instances) {
      const prevInstance = prev.instances.find((i) => i.id === instance.id);
      if (!prevInstance || prevInstance.isRunning === instance.isRunning) continue;
      // 只在「运行结束」时判断是否接力
      if (prevInstance.isRunning || !instance.isRunning) continue;

      const container = instance.selectedTasks.find(
        (t) => isContainerTaskName(t.taskName) && !t.parentId,
      );
      if (!container) continue;

      // 仅“自然成功”时接力（失败/手动停止不接力）
      const runStatus = state.instanceTaskRunStatus[instance.id]?.[container.id];
      if (runStatus !== 'succeeded') continue;
      if (chainingInstances.has(instance.id)) continue;

      void (async () => {
        // 等状态文件落盘（写入竞争时短暂重试一次），再判断本次运行是否达标轮换
        let rotated = false;
        for (let attempt = 0; attempt < 2 && !rotated; attempt += 1) {
          await refreshContainerStatusNow();
          rotated = getContainerRotatedThisBattle(container.taskName);
          if (!rotated && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          }
        }
        if (!rotated) return;
        if (getContainerMode(container.taskName) !== 'sanity') return;
        // 状态文件的槽位表须与本实例当前装配一致，避免按错误的索引接力
        if (!slotsMatchInstance(instance.id, container.id, container.taskName)) return;

        const latest = useAppStore.getState().instances.find((i) => i.id === instance.id);
        if (!latest || latest.isRunning) return;
        if (chainingInstances.has(instance.id)) return;
        chainingInstances.add(instance.id);
        void taskStartService
          .start(latest, { singleTaskId: container.id })
          .finally(() => chainingInstances.delete(instance.id));
      })();
    }
  });
}

/** 状态文件记录的槽位表是否与本实例容器当前装配的槽位表一致。 */
function slotsMatchInstance(
  instanceId: string,
  containerTaskId: string,
  containerTaskName: string,
): boolean {
  const instance = useAppStore.getState().instances.find((i) => i.id === instanceId);
  if (!instance) return false;
  const children = instance.selectedTasks.filter((t) => t.parentId === containerTaskId);
  // 未拖入条目时项目侧使用默认顺序，状态文件中的槽位表无法与条目对应，视为一致
  if (children.length === 0) return true;
  const slotTaskNames = getContainerSlotTaskNames(containerTaskName);
  if (!slotTaskNames || slotTaskNames.length !== children.length) return false;
  return slotTaskNames.every((name, index) => name === children[index].taskName);
}
