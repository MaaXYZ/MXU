import type { Instance } from '@/types/interface';
import type { TaskRunFilterOptions } from '@/utils/taskRunFilter';

/**
 * 外部触发的任务启动/停止入口（如 MCP）。
 *
 * 由 Toolbar 注册具体实现，复用与托盘/全局快捷键相同的启动、停止流程，
 * 确保外部触发与界面操作行为一致。
 */
export interface TaskControlHandlers {
  /** 启动实例任务；返回是否成功启动 */
  start: (instance: Instance, options?: TaskRunFilterOptions) => Promise<boolean>;
  /** 停止实例任务；返回是否已停止 */
  stop: (instanceId: string) => Promise<boolean>;
}

let handlers: TaskControlHandlers | null = null;

export const taskControlService = {
  setHandlers(value: TaskControlHandlers | null) {
    handlers = value;
  },

  isReady(): boolean {
    return handlers !== null;
  },

  async start(instance: Instance, options?: TaskRunFilterOptions): Promise<boolean> {
    if (!handlers) return false;
    return handlers.start(instance, options);
  },

  async stop(instanceId: string): Promise<boolean> {
    if (!handlers) return false;
    return handlers.stop(instanceId);
  },
};
