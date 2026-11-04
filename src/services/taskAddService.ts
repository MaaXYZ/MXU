import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { taskExecutionGate } from './taskExecutionGate';
import { generateTaskPipelineOverride, loggers } from '@/utils';
import i18n, { getInterfaceLangKey } from '@/i18n';
import type { OptionValue, PretaskItem, SelectedTask } from '@/types/interface';
import type { MxuSpecialTaskDefinition } from '@/types/specialTasks';
import { MXU_KILLPROC_TASK_NAME, MXU_LAUNCH_TASK_NAME } from '@/types/specialTasks';
import { pretaskName } from '@/types/pretasks';
import { getProcessNameFromPath } from '@/utils/paths';

const log = loggers.task;

/**
 * 添加任务的统一入口（添加任务面板与 MCP 共用）
 *
 * 规则与界面保持一致：
 * - 普通任务、特殊任务：实例运行中时，添加后立即 PostTask 追加到执行队列
 * - 前置任务（pretask）：固定置于列表顶部；在连接 Controller 之前执行，不支持运行中追加
 */

export interface AddTaskOptions {
  /** 覆盖默认选项值 */
  optionValues?: Record<string, OptionValue>;
  /** 是否勾选，默认 true */
  enabled?: boolean;
}

export interface AddTaskResult {
  taskId: string;
  /** 是否已追加到正在运行的执行队列 */
  appendedToQueue: boolean;
}

/** 获取实例的控制器/资源名称（与添加任务面板的取值方式一致） */
function getInstanceControllerAndResource(instanceId: string) {
  const { instances, projectInterface } = useAppStore.getState();
  const instance = instances.find((i) => i.id === instanceId);
  return {
    controllerName: instance?.controllerName || projectInterface?.controller[0]?.name,
    resourceName: instance?.resourceName || projectInterface?.resource[0]?.name,
  };
}

function findSelectedTask(instanceId: string, taskId: string): SelectedTask | undefined {
  return useAppStore
    .getState()
    .instances.find((i) => i.id === instanceId)
    ?.selectedTasks.find((t) => t.id === taskId);
}

/** 若实例正在运行，把刚添加的任务追加到执行队列 */
async function appendIfRunning(
  instanceId: string,
  taskId: string,
  entry: string,
  getDisplayName: (task: SelectedTask) => string,
): Promise<boolean> {
  const state = useAppStore.getState();
  const instance = state.instances.find((i) => i.id === instanceId);
  if (taskExecutionGate.get(instanceId)?.source === 'mcp') return false;
  if (!instance?.isRunning) return false;

  const addedTask = findSelectedTask(instanceId, taskId);
  if (!addedTask) {
    log.warn('无法找到刚添加的任务');
    return false;
  }
  if (!addedTask.enabled) return false;

  const { controllerName, resourceName } = getInstanceControllerAndResource(instanceId);
  const pipelineOverride = generateTaskPipelineOverride(
    addedTask,
    state.projectInterface,
    controllerName,
    resourceName,
    state.globalOptionValues,
  );

  log.info('运行中追加任务:', entry, ', pipelineOverride:', pipelineOverride);

  try {
    const maaTaskId = await maaService.runTask(instanceId, entry, pipelineOverride, addedTask.id);
    log.info('任务已追加, maaTaskId:', maaTaskId);
    // 注册 task_id 与任务名的映射（用于日志显示）
    useAppStore.getState().registerTaskIdName(maaTaskId, getDisplayName(addedTask));
    return true;
  } catch (err) {
    log.error('追加任务失败:', err);
    return false;
  }
}

/** 添加项目任务（interface.json 中定义的 task） */
export async function addProjectTask(
  instanceId: string,
  taskName: string,
  options?: AddTaskOptions,
): Promise<AddTaskResult | null> {
  const state = useAppStore.getState();
  const task = state.projectInterface?.task.find((t) => t.name === taskName);
  if (!task) return null;

  const taskId = state.addTaskToInstance(instanceId, task, {
    optionValues: options?.optionValues,
    enabled: options?.enabled,
  });
  if (!taskId) return null;

  const appendedToQueue = await appendIfRunning(instanceId, taskId, task.entry, (added) => {
    const langKey = getInterfaceLangKey(useAppStore.getState().language);
    return (
      added.customName ||
      useAppStore.getState().resolveI18nText(task.label, langKey) ||
      added.taskName
    );
  });

  return { taskId, appendedToQueue };
}

/** 特殊任务的输入框初始值：根据已连接程序路径为启动/结束进程任务预填 */
export function getSpecialTaskInitialValues(
  instanceId: string,
  specialTask: MxuSpecialTaskDefinition,
): Record<string, string> | undefined {
  const instance = useAppStore.getState().instances.find((i) => i.id === instanceId);
  const connectedPath = instance?.savedDevice?.connectedProgramPath;
  if (!connectedPath) return undefined;
  if (specialTask.taskName === MXU_LAUNCH_TASK_NAME) {
    return { program: connectedPath };
  }
  if (specialTask.taskName === MXU_KILLPROC_TASK_NAME) {
    return { process_name: getProcessNameFromPath(connectedPath) };
  }
  return undefined;
}

/** 添加 MXU 特殊任务 */
export async function addSpecialTask(
  instanceId: string,
  specialTask: MxuSpecialTaskDefinition,
  options?: AddTaskOptions,
): Promise<AddTaskResult | null> {
  const state = useAppStore.getState();
  if (!state.instances.some((i) => i.id === instanceId)) return null;

  const initialValues = getSpecialTaskInitialValues(instanceId, specialTask);
  const taskId = state.addMxuSpecialTask(instanceId, specialTask.taskName, initialValues, {
    enabled: options?.enabled,
    optionValues: options?.optionValues,
  });
  if (!taskId) return null;

  const appendedToQueue = await appendIfRunning(
    instanceId,
    taskId,
    specialTask.entry,
    (added) => added.customName || i18n.t(specialTask.taskDef.label || specialTask.taskName),
  );

  return { taskId, appendedToQueue };
}

/** 添加前置任务（pretask）：置于列表顶部，不支持运行中追加 */
export function addPretask(
  instanceId: string,
  item: PretaskItem,
  options?: AddTaskOptions,
): AddTaskResult | null {
  const taskId = useAppStore.getState().addTaskToInstance(
    instanceId,
    {
      name: pretaskName(item),
      option: item.option,
      description: item.description,
    },
    { prepend: true, optionValues: options?.optionValues, enabled: options?.enabled },
  );
  if (!taskId) return null;
  return { taskId, appendedToQueue: false };
}
