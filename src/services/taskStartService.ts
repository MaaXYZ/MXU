import type { Instance } from '@/types/interface';
import type { TaskRunFilterOptions } from '@/utils/taskRunFilter';
import type { AppState } from '@/stores/types';
import type { TaskConfig } from '@/types/maa';
import type { TaskExecutionLease } from './taskExecutionGate';

export type TaskStartSnapshot = Pick<
  AppState,
  | 'projectInterface'
  | 'globalOptionValues'
  | 'basePath'
  | 'language'
  | 'tcpCompatMode'
  | 'maaVersion'
  | 'interfaceTranslations'
  | 'preActionConnectDelaySec'
> & {
  taskIds: string[];
  controllerName: string;
  resourceName: string;
};

export type AutoConnectPhase = 'idle' | 'searching' | 'connecting' | 'loading_resource';

export interface TaskStartOptions extends TaskRunFilterOptions {
  executionLease?: TaskExecutionLease;
  signal?: AbortSignal;
  snapshot?: TaskStartSnapshot;
  executeTasks?: (
    tasks: TaskConfig[],
    submit: (tasks: TaskConfig[]) => Promise<number[]>,
  ) => Promise<number[]>;
  /** 定时策略名称（定时执行时传入） */
  schedulePolicyName?: string;
  /** 自动连接阶段变化回调（用于 UI 状态更新） */
  onPhaseChange?: (phase: AutoConnectPhase) => void;
}

export type TaskStartHandler = (instance: Instance, options?: TaskStartOptions) => Promise<boolean>;

let handler: TaskStartHandler | null = null;

export const taskStartService = {
  setHandler(fn: TaskStartHandler | null) {
    handler = fn;
  },

  async start(instance: Instance, options?: TaskStartOptions): Promise<boolean> {
    if (!handler) return false;
    return handler(instance, options);
  },
};
