/**
 * MCP 前端桥：处理后端转发来的 MCP 工具请求。
 *
 * 后端（src-tauri/src/mcp）通过 `mcp-request` 事件下发 { id, op, args }，
 * 这里调用与界面相同的 store / service 执行，再通过 `mcp_respond` 回传结果。
 */
import { useAppStore } from '@/stores/appStore';
import { getCurrentControllerAndResource, initializeAllOptionValues } from '@/stores/helpers';
import { maaService } from '@/services/maaService';
import { taskControlService } from '@/services/taskControlService';
import {
  addPretask,
  addProjectTask,
  addSpecialTask,
  getSpecialTaskInitialValues,
} from '@/services/taskAddService';
import i18n, { getInterfaceLangKey } from '@/i18n';
import { isTauri, loggers } from '@/utils';
import {
  convertMcpOptions,
  describeOptions,
  describeSingleOption,
  formatOptionValues,
  type OptionContext,
} from '@/utils/mcpOptions';
import type {
  Instance,
  OptionDefinition,
  OptionValue,
  PretaskItem,
  TaskItem,
} from '@/types/interface';
import type { MxuSpecialTaskDefinition } from '@/types/specialTasks';
import {
  getAllMxuSpecialTasks,
  getMxuSpecialTask,
  MXU_WEBHOOK_TASK_NAME,
} from '@/types/specialTasks';
import { buildPretaskDef, getPretaskItem, getPretaskItems, isPretaskName } from '@/types/pretasks';

const log = loggers.app;

/** 描述文本截断长度，避免把整篇 Markdown 塞给 AI */
const MAX_DESCRIPTION_LENGTH = 300;
const DEFAULT_LOG_LIMIT = 20;

/**
 * 正在由 MCP 发起启动的标签页。
 * 启动流程（连接设备、加载资源）完成前 isRunning 仍为 false，
 * 多个 AI 客户端（或同一客户端连续调用）同时启动同一标签页时，用它避免重复启动。
 */
const startingTabIds = new Set<string>();
const MAX_LOG_LIMIT = 200;

interface BridgeRequest {
  id: number;
  op: string;
  args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

// ============================================================================
// 通用辅助
// ============================================================================

const getState = () => useAppStore.getState();

const getLangKey = () => getInterfaceLangKey(getState().language);

/** 项目文本（interface.json 中的 label/description，支持 $ 国际化） */
const resolveProjectText = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  return getState().resolveI18nText(text, getLangKey()) || undefined;
};

/** MXU 内置文本（特殊任务的 label 等，为 i18n key） */
const resolveAppText = (text: string | undefined): string | undefined =>
  text ? i18n.t(text) : undefined;

const truncate = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  return text.length > MAX_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_LENGTH)}…` : text;
};

const optionalString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw mcpError('paramNotString', { key });
  return value;
};

const requiredString = (args: Record<string, unknown>, key: string): string => {
  const value = optionalString(args, key);
  if (!value) throw mcpError('paramMissing', { key });
  return value;
};

/** 解析目标标签页（实例）：指定了 tab_id 则使用之，否则使用当前选中的标签页 */
function resolveInstance(args: Record<string, unknown>): Instance {
  const state = getState();
  const instanceId = optionalString(args, 'tab_id');
  if (instanceId) {
    const instance = state.instances.find((i) => i.id === instanceId);
    if (!instance) throw mcpError('tabNotFound', { id: instanceId });
    return instance;
  }
  const active = state.getActiveInstance();
  if (!active) throw mcpError('noActiveTab');
  return active;
}

/** 与添加任务面板一致的控制器/资源取值 */
function getPanelControllerAndResource(instance: Instance) {
  const pi = getState().projectInterface;
  return {
    controllerName: instance.controllerName || pi?.controller[0]?.name,
    resourceName: instance.resourceName || pi?.resource[0]?.name,
  };
}

function isTaskDefCompatible(
  taskDef: Pick<TaskItem, 'controller' | 'resource'>,
  controllerName: string | undefined,
  resourceName: string | undefined,
): boolean {
  if (
    taskDef.controller?.length &&
    (!controllerName || !taskDef.controller.includes(controllerName))
  ) {
    return false;
  }
  if (taskDef.resource?.length && (!resourceName || !taskDef.resource.includes(resourceName))) {
    return false;
  }
  return true;
}

/** 构造本地化错误（语言包 mcp.errors.*） */
function mcpError(key: string, params?: Record<string, string | number>): Error {
  return new Error(i18n.t(`mcp.errors.${key}`, params));
}

/** 选项上下文：错误信息走语言包 */
function optionContext(
  resolveText: OptionContext['resolveText'],
  controllerName: string | undefined,
  resourceName: string | undefined,
): OptionContext {
  return {
    resolveText,
    controllerName,
    resourceName,
    translate: (key, params) => i18n.t(`mcp.errors.${key}`, params),
  };
}

function addAiLog(instanceId: string, key: string, params?: Record<string, string>) {
  getState().addLog(instanceId, { type: 'info', message: i18n.t(key, params) });
}

// ============================================================================
// 任务定义解析（项目任务 / 前置任务 / 特殊任务）
// ============================================================================

type TaskKind = 'task' | 'pretask' | 'special';

interface ResolvedTaskDef {
  kind: TaskKind;
  def: TaskItem;
  allOptions: Record<string, OptionDefinition>;
  resolveText: (text: string | undefined) => string | undefined;
  pretask?: PretaskItem;
  special?: MxuSpecialTaskDefinition;
}

function resolveTaskDef(taskName: string): ResolvedTaskDef | null {
  const pi = getState().projectInterface;
  const special = getMxuSpecialTask(taskName);
  if (special) {
    return {
      kind: 'special',
      def: special.taskDef,
      allOptions: special.optionDefs,
      resolveText: resolveAppText,
      special,
    };
  }
  if (!pi) return null;
  if (isPretaskName(taskName)) {
    const item = getPretaskItem(pi, taskName);
    if (!item) return null;
    return {
      kind: 'pretask',
      def: buildPretaskDef(item),
      allOptions: pi.option ?? {},
      resolveText: resolveProjectText,
      pretask: item,
    };
  }
  const def = pi.task.find((t) => t.name === taskName);
  if (!def) return null;
  return { kind: 'task', def, allOptions: pi.option ?? {}, resolveText: resolveProjectText };
}

function taskLabel(resolved: ResolvedTaskDef): string {
  return resolved.resolveText(resolved.def.label) || resolved.def.name;
}

function kindFlags(kind: TaskKind) {
  return {
    ...(kind === 'pretask' ? { pretask: true } : {}),
    ...(kind === 'special' ? { special: true } : {}),
  };
}

/** 任务添加时的默认选项值（用于校验与输入框字段合并） */
function getDefaultOptionValues(
  instance: Instance,
  resolved: ResolvedTaskDef,
): Record<string, OptionValue> {
  const optionKeys = resolved.def.option ?? [];
  const defaults = initializeAllOptionValues(optionKeys, resolved.allOptions);
  if (resolved.special) {
    const initialValues = getSpecialTaskInitialValues(instance.id, resolved.special);
    if (initialValues) {
      for (const value of Object.values(defaults)) {
        if (value.type !== 'input') continue;
        for (const name of Object.keys(value.values)) {
          if (name in initialValues) value.values[name] = initialValues[name];
        }
      }
    }
  }
  return defaults;
}

/** 执行启动（调用方已做参数校验并持有启动锁） */
async function startTabTasks(
  instance: Instance,
  taskId: string | undefined,
  taskName: string | undefined,
): Promise<unknown> {
  // 控制器要求管理员权限时，无法由 AI 代为提权
  const state = getState();
  const { controllerName } = getCurrentControllerAndResource(state, instance.id);
  const controller = state.projectInterface?.controller.find((c) => c.name === controllerName);
  if (controller?.permission_required && !(await maaService.isElevated())) {
    throw mcpError('adminRequired');
  }

  if (taskName) {
    addAiLog(instance.id, 'mcp.log.startTask', { name: taskName });
  } else {
    addAiLog(instance.id, 'mcp.log.startTasks');
  }

  const existingLogIds = new Set((getState().instanceLogs[instance.id] ?? []).map((l) => l.id));
  const latest = getState().instances.find((i) => i.id === instance.id) ?? instance;
  const started = await taskControlService.start(
    latest,
    taskId ? { singleTaskId: taskId } : undefined,
  );
  if (started) return { started: true };

  // 启动失败原因由启动流程写入日志，取本次调用期间新增的警告/错误
  const reasons = (getState().instanceLogs[instance.id] ?? [])
    .filter((l) => !existingLogIds.has(l.id) && (l.type === 'error' || l.type === 'warning'))
    .map((l) => l.message);
  throw reasons.length > 0
    ? mcpError('startFailedWithReasons', { reasons: reasons.join('; ') })
    : mcpError('startFailed');
}

// ============================================================================
// 处理函数
// ============================================================================

const handlers: Record<string, Handler> = {
  resolve_tab: (args) => ({ tab_id: resolveInstance(args).id }),

  list_tabs: () => {
    const state = getState();
    const pi = state.projectInterface;
    return {
      project: pi
        ? {
            name: pi.name,
            label: resolveProjectText(pi.label) ?? pi.name,
            version: pi.version,
          }
        : null,
      tabs: state.instances.map((instance) => {
        const { controllerName, resourceName } = getCurrentControllerAndResource(
          state,
          instance.id,
        );
        const controller = pi?.controller.find((c) => c.name === controllerName);
        const resource = pi?.resource.find((r) => r.name === resourceName);
        return {
          tab_id: instance.id,
          name: instance.name,
          active: instance.id === state.activeInstanceId,
          controller: controllerName
            ? {
                name: controllerName,
                label: resolveProjectText(controller?.label) ?? controllerName,
              }
            : null,
          resource: resourceName
            ? { name: resourceName, label: resolveProjectText(resource?.label) ?? resourceName }
            : null,
          connected: state.instanceConnectionStatus[instance.id] === 'Connected',
          running: instance.isRunning,
          task_count: instance.selectedTasks.length,
        };
      }),
    };
  },

  list_available_tasks: (args) => {
    const instance = resolveInstance(args);
    const pi = getState().projectInterface;
    if (!pi) throw mcpError('projectNotLoaded');
    const { controllerName, resourceName } = getPanelControllerAndResource(instance);

    const tasks: Record<string, unknown>[] = [];

    for (const item of getPretaskItems(pi)) {
      const def = buildPretaskDef(item);
      if (!isTaskDefCompatible(def, controllerName, resourceName)) continue;
      tasks.push({
        name: def.name,
        label: resolveProjectText(def.label) || def.name,
        description: truncate(resolveProjectText(def.description)),
        pretask: true,
      });
    }

    for (const def of pi.task) {
      if (!isTaskDefCompatible(def, controllerName, resourceName)) continue;
      tasks.push({
        name: def.name,
        label: resolveProjectText(def.label) || def.name,
        description: truncate(resolveProjectText(def.description)),
      });
    }

    // Webhook 保留在注册表中以兼容已有任务，但不再提供新增入口（与添加任务面板一致）
    for (const special of getAllMxuSpecialTasks()) {
      if (special.taskName === MXU_WEBHOOK_TASK_NAME) continue;
      tasks.push({
        name: special.taskName,
        label: resolveAppText(special.taskDef.label) || special.taskName,
        description: truncate(resolveAppText(special.taskDef.description)),
        special: true,
      });
    }

    return { tab_id: instance.id, tasks };
  },

  describe_task: (args) => {
    const instance = resolveInstance(args);
    const taskName = requiredString(args, 'task_name');
    const resolved = resolveTaskDef(taskName);
    if (!resolved) throw mcpError('taskNotFound', { name: taskName });
    const { controllerName, resourceName } = getPanelControllerAndResource(instance);
    const ctx = optionContext(resolved.resolveText, controllerName, resourceName);
    const optionKeys = resolved.def.option ?? [];

    // 指定 option_key：只返回这一个选项，取值列表完整展开
    const optionKey = optionalString(args, 'option_key');
    if (optionKey) {
      return {
        name: resolved.def.name,
        label: taskLabel(resolved),
        ...describeSingleOption(optionKey, optionKeys, resolved.allOptions, ctx),
      };
    }

    return {
      name: resolved.def.name,
      label: taskLabel(resolved),
      description: truncate(resolved.resolveText(resolved.def.description)),
      ...kindFlags(resolved.kind),
      ...describeOptions(optionKeys, resolved.allOptions, ctx),
    };
  },

  get_task_list: (args) => {
    const instance = resolveInstance(args);
    const state = getState();
    const runStatus = state.instanceTaskRunStatus[instance.id] ?? {};
    const { controllerName, resourceName } = getPanelControllerAndResource(instance);

    return {
      tab_id: instance.id,
      running: instance.isRunning,
      tasks: instance.selectedTasks.map((task) => {
        const resolved = resolveTaskDef(task.taskName);
        const ctx = optionContext(
          resolved?.resolveText ?? resolveProjectText,
          controllerName,
          resourceName,
        );
        return {
          task_id: task.id,
          name: task.taskName,
          label: task.customName || (resolved ? taskLabel(resolved) : task.taskName),
          ...(resolved ? kindFlags(resolved.kind) : {}),
          enabled: task.enabled,
          ...(task.runOnce ? { run_once: true } : {}),
          run_status: runStatus[task.id] ?? 'idle',
          options: resolved
            ? formatOptionValues(
                resolved.def.option ?? [],
                resolved.allOptions,
                task.optionValues,
                ctx,
              )
            : {},
        };
      }),
    };
  },

  add_task: async (args) => {
    const instance = resolveInstance(args);
    const taskName = requiredString(args, 'task_name');
    const resolved = resolveTaskDef(taskName);
    if (!resolved) throw mcpError('taskNotFound', { name: taskName });
    if (resolved.special?.taskName === MXU_WEBHOOK_TASK_NAME) {
      throw mcpError('taskNotAddable', { name: taskName });
    }

    const { controllerName, resourceName } = getPanelControllerAndResource(instance);
    if (!isTaskDefCompatible(resolved.def, controllerName, resourceName)) {
      throw mcpError('taskIncompatible', { name: taskName });
    }

    const rawOptions = args.options;
    if (
      rawOptions !== undefined &&
      rawOptions !== null &&
      (typeof rawOptions !== 'object' || Array.isArray(rawOptions))
    ) {
      throw mcpError('paramOptionsNotObject');
    }
    const enabled = args.enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
      throw mcpError('paramEnabledNotBoolean');
    }

    const optionValues = convertMcpOptions({
      optionKeys: resolved.def.option ?? [],
      allOptions: resolved.allOptions,
      defaults: getDefaultOptionValues(instance, resolved),
      input: (rawOptions as Record<string, unknown> | undefined) ?? {},
      ctx: optionContext(resolved.resolveText, controllerName, resourceName),
    });

    const addOptions = { optionValues, enabled: enabled ?? undefined };
    const result =
      resolved.kind === 'special' && resolved.special
        ? await addSpecialTask(instance.id, resolved.special, addOptions)
        : resolved.kind === 'pretask' && resolved.pretask
          ? addPretask(instance.id, resolved.pretask, addOptions)
          : await addProjectTask(instance.id, taskName, addOptions);
    if (!result) throw mcpError('addTaskFailed', { name: taskName });

    addAiLog(instance.id, 'mcp.log.addTask', { name: taskLabel(resolved) });

    const running = getState().instances.find((i) => i.id === instance.id)?.isRunning ?? false;
    return {
      task_id: result.taskId,
      appended_to_queue: result.appendedToQueue,
      ...(running && resolved.kind === 'pretask'
        ? { note: i18n.t('mcp.notes.pretaskNextRun') }
        : {}),
    };
  },

  update_task: (args) => {
    const instance = resolveInstance(args);
    const taskId = requiredString(args, 'task_id');
    // 本期只支持标签页未运行时修改（运行中修改排队任务需同步执行队列，暂不支持）
    if (instance.isRunning) throw mcpError('updateWhileRunning');
    const task = instance.selectedTasks.find((t) => t.id === taskId);
    if (!task) throw mcpError('taskIdNotFound', { id: taskId });

    const resolved = resolveTaskDef(task.taskName);
    if (!resolved) throw mcpError('taskDefMissing', { name: task.taskName });

    const { controllerName, resourceName } = getPanelControllerAndResource(instance);
    // 与界面一致：不兼容当前控制器/资源的任务不能修改
    if (!isTaskDefCompatible(resolved.def, controllerName, resourceName)) {
      throw mcpError('updateIncompatible', { name: task.taskName });
    }

    const rawOptions = args.options;
    if (
      rawOptions !== undefined &&
      rawOptions !== null &&
      (typeof rawOptions !== 'object' || Array.isArray(rawOptions))
    ) {
      throw mcpError('paramOptionsNotObject');
    }
    const enabled = args.enabled;
    if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
      throw mcpError('paramEnabledNotBoolean');
    }
    const input = (rawOptions as Record<string, unknown> | undefined) ?? {};
    if (Object.keys(input).length === 0 && typeof enabled !== 'boolean') {
      throw mcpError('nothingToUpdate');
    }

    const ctx = optionContext(resolved.resolveText, controllerName, resourceName);
    const optionKeys = resolved.def.option ?? [];
    // 以当前值为基准（缺失的选项按默认值补齐），只覆盖传入的选项
    const current = {
      ...initializeAllOptionValues(optionKeys, resolved.allOptions),
      ...task.optionValues,
    };
    const changed = convertMcpOptions({
      optionKeys,
      allOptions: resolved.allOptions,
      defaults: current,
      input,
      ctx,
    });

    const optionValues = { ...task.optionValues, ...changed };
    getState().updateInstance(instance.id, {
      selectedTasks: instance.selectedTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              optionValues,
              // 与勾选框行为一致：修改勾选状态时清除「单次运行」标记
              ...(typeof enabled === 'boolean' ? { enabled, runOnce: false } : {}),
            }
          : t,
      ),
    });

    addAiLog(instance.id, 'mcp.log.updateTask', {
      name: task.customName || taskLabel(resolved),
    });

    return {
      task_id: taskId,
      enabled: typeof enabled === 'boolean' ? enabled : task.enabled,
      options: formatOptionValues(optionKeys, resolved.allOptions, optionValues, ctx),
    };
  },

  remove_task: (args) => {
    const instance = resolveInstance(args);
    const taskId = requiredString(args, 'task_id');
    // 与界面一致：运行中不能删除任务
    if (instance.isRunning) throw mcpError('removeWhileRunning');
    const task = instance.selectedTasks.find((t) => t.id === taskId);
    if (!task) throw mcpError('taskIdNotFound', { id: taskId });

    const resolved = resolveTaskDef(task.taskName);
    getState().removeTaskFromInstance(instance.id, taskId);
    addAiLog(instance.id, 'mcp.log.removeTask', {
      name: task.customName || (resolved ? taskLabel(resolved) : task.taskName),
    });
    return { removed: true };
  },

  start_tasks: async (args) => {
    const instance = resolveInstance(args);
    const taskId = optionalString(args, 'task_id');
    if (instance.isRunning) throw mcpError('alreadyRunning');
    // 检查与占用都发生在第一个 await 之前，不会被并发请求穿插
    if (startingTabIds.has(instance.id)) {
      throw mcpError('tabStarting');
    }
    if (!taskControlService.isReady()) throw mcpError('uiNotReady');

    let taskName: string | undefined;
    if (taskId) {
      const task = instance.selectedTasks.find((t) => t.id === taskId);
      if (!task) throw mcpError('taskIdNotFound', { id: taskId });
      const resolved = resolveTaskDef(task.taskName);
      taskName = task.customName || (resolved ? taskLabel(resolved) : task.taskName);
    }

    startingTabIds.add(instance.id);
    try {
      return await startTabTasks(instance, taskId, taskName);
    } finally {
      startingTabIds.delete(instance.id);
    }
  },

  stop_tasks: async (args) => {
    const instance = resolveInstance(args);
    if (!taskControlService.isReady()) throw mcpError('uiNotReady');
    addAiLog(instance.id, 'mcp.log.stopTasks');
    const stopped = await taskControlService.stop(instance.id);
    return stopped ? { stopped: true } : { stopped: false, note: i18n.t('mcp.notes.stopPending') };
  },

  get_run_status: (args) => {
    const instance = resolveInstance(args);
    const state = getState();
    const rawLimit = args.log_limit;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(MAX_LOG_LIMIT, Math.max(0, Math.floor(rawLimit)))
        : DEFAULT_LOG_LIMIT;
    const runStatus = state.instanceTaskRunStatus[instance.id] ?? {};
    const logs = state.instanceLogs[instance.id] ?? [];

    return {
      tab_id: instance.id,
      running: instance.isRunning,
      // 由 MCP 发起、仍在连接设备/加载资源的启动
      starting: startingTabIds.has(instance.id),
      connected: state.instanceConnectionStatus[instance.id] === 'Connected',
      tasks: instance.selectedTasks
        .filter((task) => runStatus[task.id] && runStatus[task.id] !== 'idle')
        .map((task) => {
          const resolved = resolveTaskDef(task.taskName);
          return {
            task_id: task.id,
            label: task.customName || (resolved ? taskLabel(resolved) : task.taskName),
            run_status: runStatus[task.id],
          };
        }),
      logs: (limit > 0 ? logs.slice(-limit) : []).map((l) => ({
        time: new Date(l.timestamp).toISOString(),
        type: l.type,
        message: l.message,
      })),
    };
  },
};

// ============================================================================
// 监听注册
// ============================================================================

async function handleRequest(request: BridgeRequest) {
  const { invoke } = await import('@tauri-apps/api/core');
  const handler = handlers[request.op];
  let response: { id: number; ok: boolean; data?: unknown; error?: string };
  try {
    if (!handler) throw mcpError('unknownOp', { op: request.op });
    const data = await handler(request.args ?? {});
    response = { id: request.id, ok: true, data: data ?? null };
  } catch (err) {
    response = {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    await invoke('mcp_respond', { response });
  } catch (err) {
    log.error('[mcp] 回传结果失败:', err);
  }
}

/** 把当前界面语言的 MCP 文本（instructions、工具标题/描述、参数说明、后端错误）推送给后端 */
async function pushMcpTexts() {
  const { invoke } = await import('@tauri-apps/api/core');
  const texts = i18n.t('mcp.server', { returnObjects: true });
  await invoke('mcp_set_texts', { texts });
}

/** 注册 MCP 请求监听，返回取消函数（仅桌面端） */
export async function initMcpBridge(): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  const unlisten = await listen<BridgeRequest>('mcp-request', (event) => {
    void handleRequest(event.payload);
  });

  // 切换界面语言后重新推送；已连接的客户端在重连后生效
  const onLanguageChanged = () => {
    pushMcpTexts().catch((err) => log.warn('[mcp] 推送 MCP 文本失败:', err));
  };
  i18n.on('languageChanged', onLanguageChanged);
  await pushMcpTexts().catch((err) => log.warn('[mcp] 推送 MCP 文本失败:', err));

  await invoke('mcp_bridge_ready');
  return () => {
    unlisten();
    i18n.off('languageChanged', onLanguageChanged);
  };
}

/** 同步 MCP 开关到后端（即时生效） */
export async function syncMcpEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_mcp_server_enabled', { enabled });
}
