import i18n, { getInterfaceLangKey, setLanguage as setI18nLanguage } from '@/i18n';
import { saveConfig } from '@/services/configService';
import { maaService } from '@/services/maaService';
import { isTelemetryBlockedByBuild, setTelemetryEnabled } from '@/services/telemetryService';
import {
  type AccentColor,
  applyTheme,
  clearCustomAccents,
  type CustomAccent,
  registerCustomAccent,
  resolveThemeMode,
  unregisterCustomAccent,
} from '@/themes';
import type {
  LegacyActionConfig,
  MxuConfig,
  RecentlyClosedInstance,
  SavedTask,
} from '@/types/config';
import {
  clampAddTaskPanelHeight,
  DEFAULT_MAX_LOGS_PER_INSTANCE,
  defaultAddTaskPanelHeight,
  defaultMirrorChyanSettings,
  defaultScreenshotFrameRate,
  defaultWindowSize,
  normalizeAddTaskPanelHeight,
} from '@/types/config';
import type {
  ActionConfig,
  Instance,
  OptionDefinition,
  OptionValue,
  PresetTaskItem,
  ProjectInterface,
  SchedulePolicy,
  SelectedTask,
} from '@/types/interface';
import type { ConnectionStatus, TaskStatus } from '@/types/maa';
import { getMxuSpecialTask, isMxuSpecialTask, MXU_SPECIAL_TASKS } from '@/types/specialTasks';
import {
  getPretaskItems,
  pretaskName,
  isPretaskName,
  getPretaskItem,
  resolveCompatTaskDef,
} from '@/types/pretasks';
import { decryptCdk, encryptCdk } from '@/utils/cdkCrypto';
import {
  decryptPasswordOptionValues,
  encryptPasswordOptionValues,
} from '@/utils/passwordOptionValues';
import { loggers } from '@/utils/logger';
import { findSwitchCase } from '@/utils/optionHelpers';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import { clearLogsOnBackend, logToStdout, pushLogToBackend } from '@/utils/logStdout';
import {
  cacheBackendAppearance,
  cacheBackendLayout,
  getBackendAppearance,
  getBackendLayout,
  loadWebUIAppearance,
  loadWebUILayout,
  patchWebUIAppearance,
  patchWebUILayout,
} from '@/services/appearanceStorage';
import { isTauri } from '@/utils/paths';
import {
  convertPresetOptionValue,
  generateId,
  getCurrentControllerAndResource,
  initializeAllOptionValues,
  isTaskCompatible,
  sanitizeOptionValues,
} from './helpers';
import { persistRuntimeLogs } from '@/utils/runtimeLogPersistence';
import { cacheTaskEnabledForController } from '@/utils/taskControllerCache';
import { normalizeWeeklySchedule } from '@/utils/taskRunFilter';
// 从独立模块导入类型和辅助函数
import type { AppState, LogEntry, TaskRunStatus } from './types';

/** 低于该速度（字节/秒）视为慢速下载 */
const SLOW_DOWNLOAD_SPEED_BPS = 1024 * 1024;

/** 慢速需要持续这么久才认定为「确实慢」，避免下载刚开始时误报 */
export const SLOW_DOWNLOAD_DURATION_MS = 5000;

/**
 * 规范化定时策略：仅保留 times（分钟精度）字段，丢弃旧版整点 hours 字段。
 * 不做新旧数据迁移——旧配置中基于 hours 的时间点不会被转换为 times，加载后时间点为空，需用户重新配置。
 */
function normalizeSchedulePolicies(inst: {
  schedulePolicies?: SchedulePolicy[];
}): SchedulePolicy[] | undefined {
  if (!inst.schedulePolicies) return undefined;
  return inst.schedulePolicies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    enabled: policy.enabled,
    weekdays: policy.weekdays,
    times: Array.isArray(policy.times) ? policy.times : [],
  }));
}

/** 向后兼容：将旧版单个 preAction 迁移为 preActions 数组 */
function migratePreActions(inst: {
  preActions?: ActionConfig[];
  preAction?: LegacyActionConfig;
}): ActionConfig[] | undefined {
  if (inst.preActions && inst.preActions.length > 0) {
    return inst.preActions.map((a) => (a.id ? a : { ...a, id: generateId() }));
  }
  if (inst.preAction) {
    return [{ ...inst.preAction, id: generateId() }];
  }
  return undefined;
}

function cleanOptionValues(
  optionValues: Record<string, OptionValue>,
  pi: ProjectInterface | null,
): Record<string, OptionValue> {
  if (!pi?.option) return {};
  return sanitizeOptionValues(optionValues, pi.option, (message) => loggers.config.warn(message));
}

function restoreOptionValuesFromConfig(
  optionValues: Record<string, OptionValue>,
  pi: ProjectInterface | null,
  projectName?: string,
): Record<string, OptionValue> {
  const cleaned = cleanOptionValues(optionValues, pi);
  if (!pi?.option) return cleaned;
  return decryptPasswordOptionValues(cleaned, pi.option, projectName);
}

function persistOptionValues(
  optionValues: Record<string, OptionValue>,
  pi: ProjectInterface | null,
  projectName?: string,
): Record<string, OptionValue> {
  if (!pi?.option) return optionValues;
  return encryptPasswordOptionValues(optionValues, pi.option, projectName);
}

function updateSelectedName(
  selectedNames: Record<string, string>,
  instanceId: string,
  name: string | undefined,
): Record<string, string> {
  const updatedNames = { ...selectedNames };
  if (name === undefined) {
    delete updatedNames[instanceId];
  } else {
    updatedNames[instanceId] = name;
  }
  return updatedNames;
}

function isTaskControllerCompatible(
  taskDef: { controller?: string[] } | undefined,
  controllerName: string | undefined,
): boolean {
  return (
    !controllerName ||
    !taskDef?.controller ||
    taskDef.controller.length === 0 ||
    taskDef.controller.includes(controllerName)
  );
}

function resolveTaskEnabledForController(
  task: SelectedTask,
  taskDef: { controller?: string[] } | undefined,
  previousControllerName: string | undefined,
  controllerName: string,
  enabledByController: Record<string, boolean>,
): boolean {
  if (!isTaskControllerCompatible(taskDef, controllerName)) return false;

  if (Object.prototype.hasOwnProperty.call(enabledByController, controllerName)) {
    return enabledByController[controllerName];
  }

  // 首次进入新控制器时继承当前值，但不能继承由“不支持该任务”产生的 false。
  if (isTaskControllerCompatible(taskDef, previousControllerName)) {
    return task.enabled;
  }

  const cachedEntries = Object.entries(enabledByController);
  for (let index = cachedEntries.length - 1; index >= 0; index -= 1) {
    const [cachedControllerName, enabled] = cachedEntries[index];
    if (isTaskControllerCompatible(taskDef, cachedControllerName)) return enabled;
  }

  return task.enabled;
}

function forwardLogToStdout(message: string) {
  const plain = message.replace(/<[^>]*>/g, '').trim();
  if (!plain) return;
  logToStdout(plain);
}

// 重新导出类型供外部使用
export type {
  DownloadProgress,
  DownloadStatus,
  InstallStatus,
  JustUpdatedInfo,
  Language,
  LogEntry,
  LogType,
  PageView,
  ScheduleExecutionInfo,
  TaskRunStatus,
  Theme,
  UpdateInfo,
} from './types';

// 最近关闭列表最大条目数
const MAX_RECENTLY_CLOSED = 30;

export const useAppStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    // 启动流程完成前禁止落盘，避免空状态覆盖已有配置
    configPersistenceReady: false,
    setConfigPersistenceReady: (ready) => set({ configPersistenceReady: ready }),

    // 主题和语言
    theme: 'light',
    accentColor: 'emerald',
    language: 'system',
    backgroundImage: undefined,
    backgroundOpacity: 50,
    confirmBeforeDelete: false,
    maxLogsPerInstance: DEFAULT_MAX_LOGS_PER_INSTANCE,
    autoClearLogsOnLaunch: false,
    helpImproveSoftware: true,
    customAccents: [],
    setTheme: (theme) => {
      set({ theme });
      const mode = resolveThemeMode(theme);
      applyTheme(mode, get().accentColor);
      if (!isTauri()) patchWebUIAppearance({ theme });
    },
    setAccentColor: (accent) => {
      set({ accentColor: accent });
      const { theme } = get();
      const mode = resolveThemeMode(theme);
      applyTheme(mode, accent);
      if (!isTauri()) patchWebUIAppearance({ accentColor: accent });
    },
    setLanguage: (lang) => {
      set({ language: lang });
      setI18nLanguage(lang);
      if (!isTauri()) patchWebUIAppearance({ language: lang });
    },
    setBackgroundImage: (path) => {
      set({ backgroundImage: path });
      if (!isTauri()) patchWebUIAppearance({ backgroundImage: path });
    },
    setBackgroundOpacity: (opacity) => {
      const clamped = Math.max(0, Math.min(100, opacity));
      set({ backgroundOpacity: clamped });
      if (!isTauri()) patchWebUIAppearance({ backgroundOpacity: clamped });
    },
    setConfirmBeforeDelete: (enabled) => set({ confirmBeforeDelete: enabled }),
    setMaxLogsPerInstance: (value) => {
      set({
        maxLogsPerInstance: Math.max(100, Math.min(10000, Math.floor(value))),
      });
      const state = get();
      persistRuntimeLogs(state.instanceLogs, state.maxLogsPerInstance);
    },
    setAutoClearLogsOnLaunch: (enabled) => {
      set({ autoClearLogsOnLaunch: enabled });
    },
    setHelpImproveSoftware: (enabled) => {
      // 调试 / 开发版本强制关闭，忽略开启请求
      const blocked = isTelemetryBlockedByBuild(get().projectInterface);
      const next = blocked ? false : enabled;
      set({ helpImproveSoftware: next });
      void setTelemetryEnabled(next);
    },
    addCustomAccent: (accent) => {
      set((state) => ({
        customAccents: [...state.customAccents, accent],
      }));
      registerCustomAccent(accent);
      const { theme, accentColor } = get();
      if (accentColor === accent.name) {
        const mode = resolveThemeMode(theme);
        applyTheme(mode, accent.name);
      }
      if (!isTauri()) patchWebUIAppearance({ customAccents: get().customAccents });
    },
    updateCustomAccent: (id, accent) => {
      const oldAccent = get().customAccents.find((a) => a.id === id);
      set((state) => ({
        customAccents: state.customAccents.map((a) => (a.id === id ? accent : a)),
      }));
      if (oldAccent) {
        unregisterCustomAccent(oldAccent.name);
      }
      registerCustomAccent(accent);
      const { theme, accentColor } = get();
      if (accentColor === accent.name) {
        const mode = resolveThemeMode(theme);
        applyTheme(mode, accent.name);
      }
      if (!isTauri()) patchWebUIAppearance({ customAccents: get().customAccents });
    },
    removeCustomAccent: (id) => {
      const accent = get().customAccents.find((a) => a.id === id);
      if (accent) {
        unregisterCustomAccent(accent.name);
        set((state) => ({
          customAccents: state.customAccents.filter((a) => a.id !== id),
        }));
        const { theme, accentColor } = get();
        if (accentColor === accent.name) {
          const defaultAccent: AccentColor = 'emerald';
          set({ accentColor: defaultAccent });
          const mode = resolveThemeMode(theme);
          applyTheme(mode, defaultAccent);
          if (!isTauri()) patchWebUIAppearance({ accentColor: defaultAccent });
        }
        if (!isTauri()) patchWebUIAppearance({ customAccents: get().customAccents });
      }
    },
    reorderCustomAccents: (oldIndex, newIndex) => {
      set((state) => {
        const next = [...state.customAccents];
        if (oldIndex < 0 || newIndex < 0 || oldIndex >= next.length || newIndex >= next.length) {
          return { customAccents: next };
        }
        const [moved] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, moved);
        return { customAccents: next };
      });
      if (!isTauri()) patchWebUIAppearance({ customAccents: get().customAccents });
    },

    // 快捷键设置（默认：F10 开始任务，F11 结束任务）
    hotkeys: {
      startTasks: 'F10',
      stopTasks: 'F11',
    },
    setHotkeys: (hotkeys) => set({ hotkeys }),

    // 全局快捷键注册失败信息（不落盘，仅本次运行）
    globalHotkeyError: null,
    setGlobalHotkeyError: (err) => set({ globalHotkeyError: err }),

    // 当前页面
    currentPage: 'main',
    setCurrentPage: (page) => set({ currentPage: page }),

    settingsTargetSection: null,
    setSettingsTargetSection: (section) => set({ settingsTargetSection: section }),

    // 调试选项（不落盘，每次启动默认关闭）
    saveDraw: false,
    setSaveDraw: async (enabled) => {
      set({ saveDraw: enabled });
      // 调用 MaaFramework API 设置全局选项
      try {
        await maaService.setSaveDraw(enabled);
      } catch (err) {
        loggers.app.error('设置保存调试图像失败:', err);
      }
    },

    // Interface 数据
    projectInterface: null,
    interfaceTranslations: {},
    basePath: '.',
    dataPath: '.',
    setProjectInterface: (pi) => set({ projectInterface: pi }),
    setInterfaceTranslations: (lang, translations) =>
      set((state) => ({
        interfaceTranslations: {
          ...state.interfaceTranslations,
          [lang]: translations,
        },
      })),
    setBasePath: (path) => set({ basePath: path }),
    setDataPath: (path) => set({ dataPath: path }),

    // 多开实例
    instances: [],
    activeInstanceId: null,
    nextInstanceNumber: 1,

    createInstance: (name, exactName) => {
      const id = generateId();
      const instanceNumber = get().nextInstanceNumber;
      const pi = get().projectInterface;

      // 只添加 default_check 为 true 的任务
      const defaultTasks: SelectedTask[] = [];
      if (pi) {
        // 获取默认控制器名称，用于检查任务兼容性
        const defaultControllerName = pi.controller[0]?.name;

        pi.task.forEach((task) => {
          if (!task.default_check) return;

          // 检查任务是否支持默认控制器
          const isControllerCompatible =
            !task.controller ||
            task.controller.length === 0 ||
            !!(defaultControllerName && task.controller.includes(defaultControllerName));

          const optionValues =
            task.option && pi.option ? initializeAllOptionValues(task.option, pi.option) : {};
          defaultTasks.push({
            id: generateId(),
            taskName: task.name,
            enabled: isControllerCompatible, // 不兼容默认控制器的任务不勾选
            optionValues,
            expanded: true, // 新建配置时自动展开所有任务
          });
        });
      }

      // 默认控制器和资源名称
      const defaultControllerNameValue = pi?.controller[0]?.name;
      const defaultResourceNameValue = pi?.resource[0]?.name;

      const newInstance: Instance = {
        id,
        name:
          exactName && name
            ? name
            : name
              ? `${name} ${instanceNumber}`
              : `Config ${instanceNumber}`,
        controllerName: defaultControllerNameValue,
        resourceName: defaultResourceNameValue,
        selectedTasks: defaultTasks,
        isRunning: false,
      };

      // 收集所有新建任务的 ID 用于入场动画
      const newTaskIds = defaultTasks.map((t) => t.id);

      set((state) => {
        // 持久化默认控制器和资源选择，避免其他组件 fallback 到 controller[0] 导致判断错误
        const newSelectedController = { ...state.selectedController };
        const newSelectedResource = { ...state.selectedResource };
        if (defaultControllerNameValue) {
          newSelectedController[id] = defaultControllerNameValue;
        }
        if (defaultResourceNameValue) {
          newSelectedResource[id] = defaultResourceNameValue;
        }

        const hasPresets = (get().projectInterface?.preset?.length ?? 0) > 0;
        return {
          instances: [...state.instances, newInstance],
          activeInstanceId: id,
          nextInstanceNumber: state.nextInstanceNumber + 1,
          // 有预设时不自动展开添加任务面板，由预设选择器引导用户
          showAddTaskPanel: !hasPresets,
          animatingTaskIds: [...state.animatingTaskIds, ...newTaskIds],
          animatingTabIds: [...state.animatingTabIds, id], // 添加到标签页进入动画列表
          selectedController: newSelectedController,
          selectedResource: newSelectedResource,
        };
      });

      return id;
    },

    removeInstance: (id) => {
      get().clearControllerRuntimeState(id);

      set((state) => {
        const instanceToClose = state.instances.find((i) => i.id === id);
        const newInstances = state.instances.filter((i) => i.id !== id);
        let newActiveId = state.activeInstanceId;

        if (state.activeInstanceId === id) {
          newActiveId = newInstances.length > 0 ? newInstances[0].id : null;
        }

        // 将关闭的实例添加到最近关闭列表
        let newRecentlyClosed = state.recentlyClosed;
        if (instanceToClose) {
          const closedRecord: RecentlyClosedInstance = {
            id: instanceToClose.id,
            name: instanceToClose.name,
            closedAt: Date.now(),
            controllerId: instanceToClose.controllerId,
            resourceId: instanceToClose.resourceId,
            controllerName: instanceToClose.controllerName,
            resourceName: instanceToClose.resourceName,
            savedDevice: instanceToClose.savedDevice,
            tasks: instanceToClose.selectedTasks.map((t) => ({
              id: t.id,
              taskName: t.taskName,
              customName: t.customName,
              enabled: t.enabled,
              enabledByController: cacheTaskEnabledForController(
                t.enabledByController,
                instanceToClose.controllerName,
                t.enabled,
              ),
              weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
              optionValues: t.optionValues,
              expanded: t.expanded,
              collapsedOptions: t.collapsedOptions,
            })),
            schedulePolicies: instanceToClose.schedulePolicies,
            preActions: instanceToClose.preActions,
          };
          // 添加到列表头部，并限制最大条目数
          newRecentlyClosed = [closedRecord, ...state.recentlyClosed].slice(0, MAX_RECENTLY_CLOSED);
        }

        // 如果删除的实例是"启动后自动执行"的目标实例，重置自动执行设置并记录被删名称
        const autoStartUpdate: Partial<AppState> = {};
        if (state.autoStartInstanceId === id) {
          autoStartUpdate.autoStartInstanceId = undefined;
          autoStartUpdate.autoRunOnLaunch = false;
          autoStartUpdate.autoStartRemovedInstanceName = instanceToClose?.name;
        }

        return {
          instances: newInstances,
          activeInstanceId: newActiveId,
          recentlyClosed: newRecentlyClosed,
          ...autoStartUpdate,
        };
      });
    },

    setActiveInstance: (id) => set({ activeInstanceId: id }),

    updateInstance: (id, updates) =>
      set((state) => ({
        instances: state.instances.map((i) => (i.id === id ? { ...i, ...updates } : i)),
        ...(Object.prototype.hasOwnProperty.call(updates, 'controllerName') && {
          selectedController: updateSelectedName(
            state.selectedController,
            id,
            updates.controllerName,
          ),
        }),
        ...(Object.prototype.hasOwnProperty.call(updates, 'resourceName') && {
          selectedResource: updateSelectedName(state.selectedResource, id, updates.resourceName),
        }),
      })),

    renameInstance: (id, newName) =>
      set((state) => ({
        instances: state.instances.map((i) => (i.id === id ? { ...i, name: newName } : i)),
      })),

    reorderInstances: (oldIndex, newIndex) =>
      set((state) => {
        const instances = [...state.instances];
        const [removed] = instances.splice(oldIndex, 1);
        instances.splice(newIndex, 0, removed);
        return { instances };
      }),

    getActiveInstance: () => {
      const state = get();
      return state.instances.find((i) => i.id === state.activeInstanceId) || null;
    },

    // 任务操作
    addTaskToInstance: (instanceId, task, options) => {
      const pi = get().projectInterface;
      if (!pi) return;

      // 递归初始化所有选项（包括嵌套选项）
      const optionValues =
        task.option && pi.option ? initializeAllOptionValues(task.option, pi.option) : {};

      // 判断新任务是否有选项或描述（用于决定是否展开）
      const hasOptions = !!(task.option && task.option.length > 0);
      const hasDescription = !!task.description;
      const shouldExpand = hasOptions || hasDescription;

      const newTask: SelectedTask = {
        id: generateId(),
        taskName: task.name,
        enabled: true,
        optionValues,
        expanded: shouldExpand, // 有选项或描述的任务自动展开
      };

      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                // prepend: pretask 等前置任务固定置于列表顶部
                selectedTasks: options?.prepend
                  ? [newTask, ...i.selectedTasks]
                  : [...i.selectedTasks, newTask],
              }
            : i,
        ),
        lastAddedTaskId: newTask.id, // 记录最近添加的任务 ID
        animatingTaskIds: [...state.animatingTaskIds, newTask.id], // 加入动画列表
      }));
    },

    // v2.3.0: 应用预设配置到实例
    applyPreset: (instanceId, presetName) => {
      const pi = get().projectInterface;
      if (!pi?.preset) return;

      const preset = pi.preset.find((p) => p.name === presetName);
      if (!preset) return;

      const newTasks: SelectedTask[] = [];

      // 按默认值初始化选项，再用预设值覆盖
      const buildSelectedTask = (
        taskName: string,
        optionKeys: string[] | undefined,
        presetTask: PresetTaskItem,
      ): SelectedTask => {
        const optionValues =
          optionKeys && pi.option ? initializeAllOptionValues(optionKeys, pi.option) : {};
        if (presetTask.option && pi.option) {
          for (const [optionKey, presetValue] of Object.entries(presetTask.option)) {
            const converted = convertPresetOptionValue(optionKey, presetValue, pi.option);
            if (converted) {
              optionValues[optionKey] = converted;
            }
          }
        }
        return {
          id: generateId(),
          taskName,
          enabled: presetTask.enabled !== false,
          optionValues,
          expanded: true,
        };
      };

      // v2.10.3: 按 preset.pretask 设置预任务（按顶层 pretask 顺序排列，未列出的不添加）。
      // 预设只能应用于空任务列表，未声明 pretask 时无需保留已有预任务
      if (preset.pretask) {
        const pretaskItems = getPretaskItems(pi);
        for (const presetPretask of preset.pretask) {
          if (!pretaskItems.some((item) => item.name === presetPretask.name)) {
            loggers.task.warn(
              `[applyPreset] Pretask "${presetPretask.name}" referenced in preset "${presetName}" not found in project interface and will be skipped.`,
            );
          }
        }
        for (const item of pretaskItems) {
          const presetPretask = preset.pretask.find((p) => p.name === item.name);
          if (!presetPretask) continue;
          newTasks.push(buildSelectedTask(pretaskName(item), item.option, presetPretask));
        }
      }

      for (const presetTask of preset.task ?? []) {
        const taskDef = pi.task.find((t) => t.name === presetTask.name);
        if (!taskDef) {
          loggers.task.warn(
            `[applyPreset] Task "${presetTask.name}" referenced in preset "${presetName}" not found in project interface and will be skipped.`,
          );
          continue;
        }
        newTasks.push(buildSelectedTask(presetTask.name, taskDef.option, presetTask));
      }

      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId ? { ...i, selectedTasks: newTasks } : i,
        ),
      }));
    },

    // 添加延迟任务到实例（保留向后兼容，内部调用 addMxuSpecialTask）
    addSleepTaskToInstance: (instanceId: string, sleepTime: number = 5) => {
      return get().addMxuSpecialTask(instanceId, '__MXU_SLEEP__', {
        sleep_time: String(sleepTime),
      });
    },

    // 通用 MXU 特殊任务添加函数
    addMxuSpecialTask: (
      instanceId: string,
      taskName: string,
      initialValues?: Record<string, string>,
      taskOptions?: {
        enabled?: boolean;
        expanded?: boolean;
        customName?: string;
        switchOverrides?: Record<string, boolean>;
      },
    ) => {
      // 从注册表获取特殊任务定义
      const specialTask = getMxuSpecialTask(taskName);

      if (!specialTask) {
        loggers.task.warn(`未找到特殊任务定义: ${taskName}`);
        return '';
      }

      // 根据任务定义初始化选项值
      const optionValues: Record<string, OptionValue> = {};

      for (const [optionKey, optionDef] of Object.entries(specialTask.optionDefs) as [
        string,
        OptionDefinition,
      ][]) {
        if (optionDef.type === 'input') {
          const values: Record<string, string> = {};
          for (const input of optionDef.inputs || []) {
            values[input.name] = initialValues?.[input.name] ?? input.default ?? '';
          }
          optionValues[optionKey] = { type: 'input', values };
        } else if (optionDef.type === 'switch') {
          const overridden = taskOptions?.switchOverrides?.[optionKey];
          if (overridden !== undefined) {
            optionValues[optionKey] = { type: 'switch', value: overridden };
          } else {
            const defaultCase = optionDef.default_case;
            const isOn = defaultCase === 'Yes' || defaultCase === optionDef.cases[0]?.name;
            optionValues[optionKey] = { type: 'switch', value: isOn };
          }
        } else if (optionDef.type === 'checkbox') {
          const defaultCases = optionDef.default_case || [];
          optionValues[optionKey] = { type: 'checkbox', caseNames: [...defaultCases] };
        } else if (optionDef.type === 'select') {
          const caseName =
            (optionDef.default_case as string | undefined) || optionDef.cases?.[0]?.name || '';
          optionValues[optionKey] = { type: 'select', caseName };
        } else if (optionDef.type === 'hotkey') {
          const values: Record<string, string> = {};
          for (const input of optionDef.hotkeys || []) {
            values[input.name] = initialValues?.[input.name] ?? input.default ?? '';
          }
          optionValues[optionKey] = { type: 'hotkey', values };
        }
      }

      const newTask: SelectedTask = {
        id: generateId(),
        taskName,
        customName: taskOptions?.customName,
        enabled: taskOptions?.enabled ?? true,
        optionValues,
        expanded: taskOptions?.expanded ?? true,
      };

      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId ? { ...i, selectedTasks: [...i.selectedTasks, newTask] } : i,
        ),
        lastAddedTaskId: newTask.id,
        animatingTaskIds: [...state.animatingTaskIds, newTask.id],
      }));

      return newTask.id;
    },

    removeTaskFromInstance: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.filter((t) => t.id !== taskId),
              }
            : i,
        ),
      })),

    reorderTasks: (instanceId, oldIndex, newIndex) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;
          const len = i.selectedTasks.length;
          if (oldIndex < 0 || oldIndex >= len || newIndex < 0 || newIndex >= len) return i;
          if (oldIndex === newIndex) return i;

          const tasks = [...i.selectedTasks];
          const [removed] = tasks.splice(oldIndex, 1);
          tasks.splice(newIndex, 0, removed);

          return { ...i, selectedTasks: tasks };
        }),
      })),

    toggleTaskEnabled: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) => {
                  if (t.id !== taskId) return t;
                  if (t.runOnce) {
                    return { ...t, enabled: false, runOnce: false };
                  }
                  return { ...t, enabled: !t.enabled, runOnce: false };
                }),
              }
            : i,
        ),
      })),

    setTaskRunOnce: (instanceId, taskId, runOnce) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) =>
                  t.id === taskId
                    ? runOnce
                      ? { ...t, enabled: false, runOnce: true }
                      : { ...t, runOnce: false }
                    : t,
                ),
              }
            : i,
        ),
      })),

    clearAllTaskRunOnce: (instanceId) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) =>
                  t.runOnce ? { ...t, runOnce: false } : t,
                ),
              }
            : i,
        ),
      })),

    setTaskWeeklySchedule: (instanceId, taskId, weekdays) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) => {
                  if (t.id !== taskId) return t;
                  return { ...t, weeklySchedule: normalizeWeeklySchedule(weekdays) };
                }),
              }
            : i,
        ),
      })),

    toggleTaskExpanded: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) =>
                  t.id === taskId ? { ...t, expanded: !t.expanded } : t,
                ),
              }
            : i,
        ),
      })),

    toggleOptionCollapsed: (instanceId, taskId, optionKey) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) =>
                  t.id === taskId
                    ? {
                        ...t,
                        collapsedOptions: {
                          ...(t.collapsedOptions ?? {}),
                          [optionKey]: !t.collapsedOptions?.[optionKey],
                        },
                      }
                    : t,
                ),
              }
            : i,
        ),
      })),

    setTaskOptionValue: (instanceId, taskId, optionKey, value) => {
      const pi = get().projectInterface;

      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;

          return {
            ...i,
            selectedTasks: i.selectedTasks.map((t) => {
              if (t.id !== taskId) return t;

              const newOptionValues = { ...t.optionValues, [optionKey]: value };

              // 当选项值改变时，初始化新的嵌套选项
              if (pi?.option) {
                const optDef = pi.option[optionKey];
                if (
                  optDef &&
                  (optDef.type === 'switch' || optDef.type === 'select' || !optDef.type) &&
                  'cases' in optDef
                ) {
                  let selectedCase;

                  if (optDef.type === 'switch') {
                    const isChecked = value.type === 'switch' && value.value;
                    selectedCase = findSwitchCase(optDef.cases, isChecked);
                  } else {
                    const caseName =
                      value.type === 'select' ? value.caseName : optDef.cases?.[0]?.name;
                    selectedCase = optDef.cases?.find((c) => c.name === caseName);
                  }

                  // 初始化嵌套选项（如果尚未初始化）
                  if (selectedCase?.option && selectedCase.option.length > 0) {
                    for (const nestedKey of selectedCase.option) {
                      if (!newOptionValues[nestedKey]) {
                        const nestedDef = pi.option[nestedKey];
                        if (nestedDef) {
                          const nestedValues = initializeAllOptionValues([nestedKey], pi.option);
                          Object.assign(newOptionValues, nestedValues);
                        }
                      }
                    }
                  }
                }
              }

              return { ...t, optionValues: newOptionValues };
            }),
          };
        }),
      }));
    },

    globalOptionValues: {},

    setGlobalOptionValue: (optionKey, value) => {
      const pi = get().projectInterface;

      set((state) => {
        const newValues = { ...state.globalOptionValues, [optionKey]: value };

        // 当选项值改变时，初始化新的嵌套选项（与 setTaskOptionValue 逻辑一致）
        if (pi?.option) {
          const optDef = pi.option[optionKey];
          if (
            optDef &&
            (optDef.type === 'switch' || optDef.type === 'select' || !optDef.type) &&
            'cases' in optDef
          ) {
            let selectedCase;
            if (optDef.type === 'switch') {
              const isChecked = value.type === 'switch' && value.value;
              selectedCase = findSwitchCase(optDef.cases, isChecked);
            } else {
              const caseName = value.type === 'select' ? value.caseName : optDef.cases?.[0]?.name;
              selectedCase = optDef.cases?.find((c) => c.name === caseName);
            }

            if (selectedCase?.option && selectedCase.option.length > 0) {
              for (const nestedKey of selectedCase.option) {
                if (!newValues[nestedKey]) {
                  const nestedDef = pi.option[nestedKey];
                  if (nestedDef) {
                    Object.assign(newValues, initializeAllOptionValues([nestedKey], pi.option));
                  }
                }
              }
            }
          }
        }

        return { globalOptionValues: newValues };
      });
    },

    selectAllTasks: (instanceId, enabled) =>
      set((state) => {
        const { controllerName, resourceName } = getCurrentControllerAndResource(state, instanceId);

        return {
          instances: state.instances.map((i) => {
            if (i.id !== instanceId) return i;
            return {
              ...i,
              selectedTasks: i.selectedTasks.map((t) => {
                if (!enabled) return { ...t, enabled: false, runOnce: false };
                // 全选时不兼容的任务显式禁用
                const taskDef = resolveCompatTaskDef(state.projectInterface, t.taskName);
                if (!isTaskCompatible(taskDef, controllerName, resourceName)) {
                  return { ...t, enabled: false, runOnce: false };
                }
                return { ...t, enabled: true, runOnce: false };
              }),
            };
          }),
        };
      }),

    collapseAllTasks: (instanceId, expanded) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) => ({ ...t, expanded })),
              }
            : i,
        ),
      })),

    renameTask: (instanceId, taskId, newName) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                selectedTasks: i.selectedTasks.map((t) =>
                  t.id === taskId ? { ...t, customName: newName || undefined } : t,
                ),
              }
            : i,
        ),
      })),

    // 复制任务
    duplicateTask: (instanceId, taskId) => {
      const state = get();
      const instance = state.instances.find((i) => i.id === instanceId);
      if (!instance) return;

      const taskIndex = instance.selectedTasks.findIndex((t) => t.id === taskId);
      if (taskIndex === -1) return;

      const originalTask = instance.selectedTasks[taskIndex];

      // 计算新任务的显示名称
      const copySuffix = i18n.t('common.copySuffix');
      let newCustomName: string;
      if (originalTask.customName) {
        newCustomName = `${originalTask.customName}${copySuffix}`;
      } else {
        // 获取任务的原始 label
        const taskDef = state.projectInterface?.task.find((t) => t.name === originalTask.taskName);
        const langKey = getInterfaceLangKey(state.language);
        const originalLabel =
          state.resolveI18nText(taskDef?.label, langKey) || taskDef?.name || originalTask.taskName;
        newCustomName = `${originalLabel}${copySuffix}`;
      }

      const newTask: SelectedTask = {
        ...originalTask,
        id: generateId(),
        customName: newCustomName,
        runOnce: false,
        enabledByController: originalTask.enabledByController
          ? { ...originalTask.enabledByController }
          : undefined,
        optionValues: { ...originalTask.optionValues },
      };

      const tasks = [...instance.selectedTasks];
      tasks.splice(taskIndex + 1, 0, newTask);

      set({
        instances: state.instances.map((i) =>
          i.id === instanceId ? { ...i, selectedTasks: tasks } : i,
        ),
      });
    },

    // 上移任务
    moveTaskUp: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;

          const taskIndex = i.selectedTasks.findIndex((t) => t.id === taskId);
          if (taskIndex <= 0) return i;

          const tasks = [...i.selectedTasks];
          [tasks[taskIndex - 1], tasks[taskIndex]] = [tasks[taskIndex], tasks[taskIndex - 1]];

          return { ...i, selectedTasks: tasks };
        }),
      })),

    // 下移任务
    moveTaskDown: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;

          const taskIndex = i.selectedTasks.findIndex((t) => t.id === taskId);
          if (taskIndex === -1 || taskIndex >= i.selectedTasks.length - 1) return i;

          const tasks = [...i.selectedTasks];
          [tasks[taskIndex], tasks[taskIndex + 1]] = [tasks[taskIndex + 1], tasks[taskIndex]];

          return { ...i, selectedTasks: tasks };
        }),
      })),

    // 置顶任务
    moveTaskToTop: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;

          const taskIndex = i.selectedTasks.findIndex((t) => t.id === taskId);
          if (taskIndex <= 0) return i;

          const tasks = [...i.selectedTasks];
          const [task] = tasks.splice(taskIndex, 1);
          tasks.unshift(task);

          return { ...i, selectedTasks: tasks };
        }),
      })),

    // 置底任务
    moveTaskToBottom: (instanceId, taskId) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;

          const taskIndex = i.selectedTasks.findIndex((t) => t.id === taskId);
          if (taskIndex === -1 || taskIndex >= i.selectedTasks.length - 1) return i;

          const tasks = [...i.selectedTasks];
          const [task] = tasks.splice(taskIndex, 1);
          tasks.push(task);

          return { ...i, selectedTasks: tasks };
        }),
      })),

    // 复制实例
    duplicateInstance: (instanceId) => {
      const state = get();
      const sourceInstance = state.instances.find((i) => i.id === instanceId);
      if (!sourceInstance) return '';

      const newId = generateId();
      const instanceNumber = state.nextInstanceNumber;

      const newInstance: Instance = {
        ...sourceInstance,
        id: newId,
        name: `${sourceInstance.name}${i18n.t('common.copySuffix')}`,
        selectedTasks: sourceInstance.selectedTasks.map((t) => ({
          ...t,
          id: generateId(),
          enabledByController: t.enabledByController ? { ...t.enabledByController } : undefined,
          optionValues: { ...t.optionValues },
        })),
        isRunning: false,
        preActions: sourceInstance.preActions?.map((a) => ({ ...a, id: generateId() })),
      };

      // 复制源实例的控制器和资源选择
      const newSelectedController = { ...state.selectedController };
      const newSelectedResource = { ...state.selectedResource };
      const sourceControllerName =
        state.selectedController[instanceId] || sourceInstance.controllerName;
      const sourceResourceName = state.selectedResource[instanceId] || sourceInstance.resourceName;
      if (sourceControllerName) {
        newSelectedController[newId] = sourceControllerName;
      }
      if (sourceResourceName) {
        newSelectedResource[newId] = sourceResourceName;
      }

      set({
        instances: [...state.instances, newInstance],
        activeInstanceId: newId,
        nextInstanceNumber: instanceNumber + 1,
        selectedController: newSelectedController,
        selectedResource: newSelectedResource,
      });

      return newId;
    },

    // v2.3.0: 跳过预设选择的实例（不持久化，每次启动重置）
    skippedPresetInstanceIds: new Set<string>(),
    skipPreset: (instanceId) =>
      set((state) => ({
        skippedPresetInstanceIds: new Set([...state.skippedPresetInstanceIds, instanceId]),
        showAddTaskPanel: true,
      })),

    // v2.3.0: 预设初始化标记（持久化）
    presetInitialized: false,
    setPresetInitialized: (value) => set({ presetInitialized: value }),

    // 全局 UI 状态
    showAddTaskPanel: false,
    setShowAddTaskPanel: (show) =>
      set((state) => ({
        showAddTaskPanel: show,
        // 手动收起面板时清除所有 "new" 标记
        newTaskNames: show ? state.newTaskNames : [],
      })),

    // 最近添加的任务 ID
    lastAddedTaskId: null,
    clearLastAddedTaskId: () => set({ lastAddedTaskId: null }),

    // 正在播放入场动画的任务 ID 列表
    animatingTaskIds: [],
    removeAnimatingTaskId: (taskId) =>
      set((state) => ({
        animatingTaskIds: state.animatingTaskIds.filter((id) => id !== taskId),
      })),

    // 标签页动画状态
    animatingTabIds: [],
    closingTabIds: [],
    removeAnimatingTabId: (tabId) =>
      set((state) => ({
        animatingTabIds: state.animatingTabIds.filter((id) => id !== tabId),
      })),
    startTabCloseAnimation: (tabId) => {
      const state = get();
      if (state.instances.length <= 1) return; // 最后一个标签不能关闭

      // 添加到关闭动画列表
      set((s) => ({
        closingTabIds: [...s.closingTabIds, tabId],
      }));

      // 动画结束后真正删除
      setTimeout(() => {
        const currentState = get();
        // 从关闭动画列表移除
        set((s) => ({
          closingTabIds: s.closingTabIds.filter((id) => id !== tabId),
        }));
        // 调用原始的 removeInstance
        currentState.removeInstance(tabId);
      }, 120); // 与 CSS 动画时长一致
    },

    // 新增任务名称列表（会持久化到配置文件）
    newTaskNames: [],
    setNewTaskNames: (names) => set({ newTaskNames: names }),
    removeNewTaskName: (name) =>
      set((state) => ({
        newTaskNames: state.newTaskNames.filter((n) => n !== name),
      })),
    clearNewTaskNames: () => set({ newTaskNames: [] }),

    // 国际化文本解析
    resolveI18nText: (text, lang) => {
      if (!text) return '';
      if (!text.startsWith('$')) return text;

      const key = text.slice(1);
      const translations = get().interfaceTranslations[lang];
      return translations?.[key] || key;
    },

    // 配置导入
    importConfig: (config) => {
      const pi = get().projectInterface;

      // 折叠状态本地优先：其他客户端修改配置触发 importConfig 时沿用内存中的值，
      // 只有冷启动（内存为空）才回落到配置里持久化的值，避免别的端把当前正在看的面板收起来。
      // 运行状态则纯属本地，不随配置同步。
      const prevRunningByInstance = new Map<string, boolean>();
      const prevExpandedByTask = new Map<string, boolean>();
      const prevCollapsedByTask = new Map<string, Record<string, boolean> | undefined>();
      for (const inst of get().instances) {
        prevRunningByInstance.set(inst.id, inst.isRunning);
        for (const t of inst.selectedTasks) {
          prevExpandedByTask.set(t.id, t.expanded);
          prevCollapsedByTask.set(t.id, t.collapsedOptions);
        }
      }

      // 获取保存时的任务快照，用于判断哪些是真正新增的任务
      const snapshotTaskNames = new Set(config.interfaceTaskSnapshot || []);

      // 检测新增任务（相比快照）并与已保存的 newTaskNames 合并
      const savedNewTaskNames = new Set(config.newTaskNames || []);
      const detectedNewTaskNames: string[] = [];
      if (pi) {
        pi.task.forEach((task) => {
          // 任务在快照中不存在即为新增任务，或者之前已标记为新增但用户未查看
          if (!snapshotTaskNames.has(task.name) || savedNewTaskNames.has(task.name)) {
            detectedNewTaskNames.push(task.name);
          }
        });
      }

      // 获取有效的任务名称集合（包含 interface 任务、MXU 特殊任务与 pretask 伪任务）
      const validTaskNames = new Set([
        ...(pi?.task.map((t) => t.name) || []),
        ...Object.keys(MXU_SPECIAL_TASKS),
        ...getPretaskItems(pi).map((item) => pretaskName(item)),
      ]);

      const instances: Instance[] = config.instances.map((inst) => {
        // 记录被过滤掉的无效任务
        const invalidTasks = inst.tasks.filter((t) => !validTaskNames.has(t.taskName));
        if (invalidTasks.length > 0) {
          loggers.config.warn(
            `实例 "${inst.name}" 中有 ${invalidTasks.length} 个无效任务被移除:`,
            invalidTasks.map((t) => t.taskName),
          );
        }

        // 恢复已保存的任务，过滤掉无效任务（taskName 在 interface 或 MXU
        // 特殊任务中不存在的），并清理已删除的 option
        const savedTasks: SelectedTask[] = inst.tasks
          .filter((t) => validTaskNames.has(t.taskName))
          .map((t) => {
            // MXU 特殊任务使用独立的选项系统，直接保留其
            // optionValues
            if (isMxuSpecialTask(t.taskName)) {
              return {
                id: t.id,
                taskName: t.taskName,
                customName: t.customName,
                enabled: t.enabled,
                enabledByController: t.enabledByController,
                weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
                optionValues: t.optionValues,
                expanded: prevExpandedByTask.get(t.id) ?? t.expanded ?? false,
                collapsedOptions: prevCollapsedByTask.get(t.id) ?? t.collapsedOptions,
              };
            }

            // pretask 伪任务的 option 引用顶层 pi.option
            if (isPretaskName(t.taskName)) {
              const pretaskItem = getPretaskItem(pi, t.taskName);
              const cleanedValues = restoreOptionValuesFromConfig(
                t.optionValues,
                pi,
                get().projectInterface?.name,
              );
              const defaultValues =
                pretaskItem?.option && pi?.option
                  ? initializeAllOptionValues(pretaskItem.option, pi.option)
                  : {};
              const mergedValues = {
                ...defaultValues,
                ...cleanedValues,
              };
              return {
                id: t.id,
                taskName: t.taskName,
                customName: t.customName,
                enabled: t.enabled,
                enabledByController: t.enabledByController,
                weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
                optionValues: mergedValues,
                expanded: prevExpandedByTask.get(t.id) ?? t.expanded ?? false,
                collapsedOptions: prevCollapsedByTask.get(t.id) ?? t.collapsedOptions,
              };
            }

            const taskDef = pi?.task.find((td) => td.name === t.taskName);
            const cleanedValues = restoreOptionValuesFromConfig(
              t.optionValues,
              pi,
              get().projectInterface?.name,
            );
            // 为缺失的 option 添加默认值（根据 default_case）
            const defaultValues =
              taskDef?.option && pi?.option
                ? initializeAllOptionValues(taskDef.option, pi.option)
                : {};
            // 用户保存的值优先，缺失的使用默认值
            const mergedValues = {
              ...defaultValues,
              ...cleanedValues,
            };
            return {
              id: t.id,
              taskName: t.taskName,
              customName: t.customName,
              enabled: t.enabled,
              enabledByController: t.enabledByController,
              weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
              optionValues: mergedValues,
              expanded: prevExpandedByTask.get(t.id) ?? t.expanded ?? false,
              collapsedOptions: prevCollapsedByTask.get(t.id) ?? t.collapsedOptions,
            };
          });

        return {
          id: inst.id,
          name: inst.name,
          controllerId: inst.controllerId,
          resourceId: inst.resourceId,
          controllerName: inst.controllerName,
          resourceName: inst.resourceName,
          savedDevice: inst.savedDevice,
          selectedTasks: savedTasks,
          isRunning: prevRunningByInstance.get(inst.id) ?? false,
          schedulePolicies: normalizeSchedulePolicies(inst),
          preActions: migratePreActions(inst),
        };
      });

      // 恢复选中的控制器和资源状态，同时校验它们在当前 interface 中是否仍然存在
      const validControllerNames = new Set(pi?.controller.map((c) => c.name) || []);
      const validResourceNames = new Set(pi?.resource.map((r) => r.name) || []);

      const selectedController: Record<string, string> = {};
      const selectedResource: Record<string, string> = {};
      instances.forEach((inst) => {
        if (inst.controllerName) {
          if (validControllerNames.has(inst.controllerName)) {
            selectedController[inst.id] = inst.controllerName;
          } else {
            loggers.config.warn(
              `实例 "${inst.name}" 的控制器 "${inst.controllerName}" 在当前 interface 中不存在，已重置`,
            );
            inst.controllerName = '';
          }
        }
        if (inst.resourceName) {
          if (validResourceNames.has(inst.resourceName)) {
            selectedResource[inst.id] = inst.resourceName;
          } else {
            loggers.config.warn(
              `实例 "${inst.name}" 的资源 "${inst.resourceName}" 在当前 interface 中不存在，已重置`,
            );
            inst.resourceName = '';
          }
        }
      });

      // 根据已有实例名字计算下一个编号，避免重复
      let maxNumber = 0;
      instances.forEach((inst) => {
        const match = inst.name.match(/^配置\s*(\d+)$/);
        if (match) {
          maxNumber = Math.max(maxNumber, parseInt(match[1], 10));
        }
      });

      const configAccentColor = (config.settings.accentColor as AccentColor) || 'deepsea';

      // WebUI 模式下：缓存后端外观 & 布局设置，使用 localStorage 本地值
      const isWebUI = !isTauri();
      if (isWebUI) {
        cacheBackendAppearance(config.settings, config.customAccents);
        cacheBackendLayout(config.settings);
      }

      // 确定实际使用的外观设置
      const localAppearance = isWebUI ? loadWebUIAppearance() : null;
      const localLayout = isWebUI ? loadWebUILayout() : null;
      const effectiveTheme = localAppearance?.theme ?? config.settings.theme;
      const effectiveAccentColor = localAppearance?.accentColor ?? configAccentColor;
      const effectiveLanguage = localAppearance?.language ?? config.settings.language;
      const effectiveBgImage = localAppearance
        ? localAppearance.backgroundImage
        : config.settings.backgroundImage;
      const effectiveBgOpacity =
        localAppearance?.backgroundOpacity ?? config.settings.backgroundOpacity ?? 50;
      const effectiveCustomAccents = localAppearance?.customAccents ?? config.customAccents ?? [];

      // 加载自定义强调色
      clearCustomAccents();
      effectiveCustomAccents.forEach((accent: CustomAccent) => {
        registerCustomAccent(accent);
      });

      // 恢复最后激活的实例
      // ID，如果保存的实例仍存在则使用它，否则回退到第一个实例
      const savedActiveId = config.lastActiveInstanceId;
      const activeInstanceId =
        savedActiveId && instances.some((i) => i.id === savedActiveId)
          ? savedActiveId
          : instances.length > 0
            ? instances[0].id
            : null;

      set({
        instances,
        activeInstanceId,
        theme: effectiveTheme,
        accentColor: effectiveAccentColor,
        language: effectiveLanguage,
        backgroundImage: effectiveBgImage,
        backgroundOpacity: effectiveBgOpacity,
        confirmBeforeDelete: config.settings.confirmBeforeDelete ?? false,
        maxLogsPerInstance: config.settings.maxLogsPerInstance ?? DEFAULT_MAX_LOGS_PER_INSTANCE,
        autoClearLogsOnLaunch: config.settings.autoClearLogsOnLaunch ?? false,
        // 默认开启；调试 / 开发版本强制关闭
        helpImproveSoftware: isTelemetryBlockedByBuild(get().projectInterface)
          ? false
          : (config.settings.helpImproveSoftware ?? true),
        customAccents: effectiveCustomAccents,
        selectedController,
        selectedResource,
        nextInstanceNumber: maxNumber + 1,
        windowSize: localLayout?.windowSize ?? config.settings.windowSize ?? defaultWindowSize,
        windowPosition: localLayout ? localLayout.windowPosition : config.settings.windowPosition,
        mirrorChyanSettings: (() => {
          const saved = config.settings.mirrorChyan || defaultMirrorChyanSettings;
          const piName = get().projectInterface?.name;
          if (saved.cdk) {
            return { ...saved, cdkEncrypted: encryptCdk(saved.cdk, piName) };
          }
          if (saved.cdkEncrypted) {
            return { ...saved, cdk: decryptCdk(saved.cdkEncrypted, piName) };
          }
          return saved;
        })(),
        proxySettings: config.settings.proxy,
        showOptionPreview:
          localLayout?.showOptionPreview ?? config.settings.showOptionPreview ?? true,
        sidePanelExpanded:
          localLayout?.sidePanelExpanded ?? config.settings.sidePanelExpanded ?? true,
        rightPanelWidth: localLayout?.rightPanelWidth ?? config.settings.rightPanelWidth ?? 320,
        rightPanelCollapsed:
          localLayout?.rightPanelCollapsed ?? config.settings.rightPanelCollapsed ?? false,
        addTaskPanelHeight: normalizeAddTaskPanelHeight(
          localLayout?.addTaskPanelHeight ?? config.settings.addTaskPanelHeight,
        ),
        connectionPanelExpanded:
          localLayout?.connectionPanelExpanded ?? config.settings.connectionPanelExpanded ?? true,
        screenshotPanelExpanded:
          localLayout?.screenshotPanelExpanded ?? config.settings.screenshotPanelExpanded ?? true,
        screenshotFrameRate:
          localLayout?.screenshotFrameRate ??
          config.settings.screenshotFrameRate ??
          defaultScreenshotFrameRate,
        welcomeShownHash: config.settings.welcomeShownHash ?? '',
        devMode: config.settings.devMode ?? false,
        tcpCompatMode: config.settings.tcpCompatMode ?? false,
        allowLanAccess: config.settings.allowLanAccess ?? false,
        webServerEnabled: config.settings.webServerEnabled ?? true,
        webServerPort: config.settings.webServerPort ?? 12701,
        autoStartInstanceId: config.settings.autoStartInstanceId,
        autoRunOnLaunch: config.settings.autoRunOnLaunch ?? false,
        autoStartRemovedInstanceName: config.settings.autoStartRemovedInstanceName,
        minimizeToTray: config.settings.minimizeToTray ?? false,
        onboardingCompleted: config.settings.onboardingCompleted ?? false,
        preActionConnectDelaySec: config.settings.preActionConnectDelaySec ?? 5,
        hotkeys: config.settings.hotkeys ?? {
          startTasks: 'F10',
          stopTasks: 'F11',
          globalEnabled: false,
        },
        recentlyClosed: (config.recentlyClosed || []).map((rc) => ({
          ...rc,
          tasks: rc.tasks.map((t) =>
            isMxuSpecialTask(t.taskName)
              ? t
              : {
                  ...t,
                  optionValues: restoreOptionValuesFromConfig(t.optionValues, pi, pi?.name),
                },
          ),
        })),
        // 记录新增任务，并在有新增时自动展开添加任务面板
        newTaskNames: detectedNewTaskNames,
        showAddTaskPanel: detectedNewTaskNames.length > 0,
        // v2.3.0: 恢复预设初始化标记
        presetInitialized: config.presetInitialized ?? false,
        // 全局任务设置值：以 global_option 的默认值为基底，合并已保存值（保存值优先）
        globalOptionValues: (() => {
          const globalKeys = pi?.global_option;
          const projectName = pi?.name;
          if (!globalKeys || globalKeys.length === 0 || !pi?.option) {
            return restoreOptionValuesFromConfig(config.globalOptionValues || {}, pi, projectName);
          }
          const defaults = initializeAllOptionValues(globalKeys, pi.option);
          return {
            ...defaults,
            ...restoreOptionValuesFromConfig(config.globalOptionValues || {}, pi, projectName),
          };
        })(),
      });

      // 应用主题（包括强调色）
      const mode = resolveThemeMode(effectiveTheme);
      applyTheme(mode, effectiveAccentColor);
      setI18nLanguage(effectiveLanguage);

      // 同步托盘设置到后端（仅 Tauri 环境）
      const minimizeToTray = config.settings.minimizeToTray ?? false;
      if (minimizeToTray) {
        import('@/utils/paths').then(({ isTauri }) => {
          if (!isTauri()) return;
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('set_minimize_to_tray', { enabled: minimizeToTray }).catch((err) => {
              loggers.app.error('同步托盘设置失败:', err);
            });
          });
        });
      }
    },

    // MaaFramework 状态
    maaInitialized: false,
    maaVersion: null,
    setMaaInitialized: (initialized, version) =>
      set({
        maaInitialized: initialized,
        maaVersion: version || null,
      }),

    // 实例运行时状态
    instanceConnectionStatus: {},
    instanceResourceLoaded: {},
    instanceCurrentTaskId: {},
    instanceTaskStatus: {},

    setInstanceConnectionStatus: (instanceId, status) => {
      const previousStatus = get().instanceConnectionStatus[instanceId];
      if (previousStatus === 'Connected' && status === 'Disconnected') {
        get().clearControllerRuntimeState(instanceId);
      }

      set((state) => ({
        instanceConnectionStatus: {
          ...state.instanceConnectionStatus,
          [instanceId]: status,
        },
      }));
    },

    setInstanceResourceLoaded: (instanceId, loaded) =>
      set((state) => ({
        instanceResourceLoaded: {
          ...state.instanceResourceLoaded,
          [instanceId]: loaded,
        },
      })),

    setInstanceCurrentTaskId: (instanceId, taskId) =>
      set((state) => ({
        instanceCurrentTaskId: {
          ...state.instanceCurrentTaskId,
          [instanceId]: taskId,
        },
      })),

    setInstanceTaskStatus: (instanceId, status) =>
      set((state) => ({
        instanceTaskStatus: {
          ...state.instanceTaskStatus,
          [instanceId]: status,
        },
      })),

    // 选中的控制器和资源
    selectedController: {},
    selectedResource: {},

    setSelectedController: (instanceId, controllerName) =>
      set((state) => {
        const pi = state.projectInterface;
        const updatedInstances = state.instances.map((instance) => {
          if (instance.id !== instanceId)
            return { ...instance, controllerName: instance.controllerName };

          const previousControllerName =
            state.selectedController[instanceId] ||
            instance.controllerName ||
            pi?.controller[0]?.name;

          const updatedTasks = instance.selectedTasks.map((task) => {
            const taskDef = resolveCompatTaskDef(pi, task.taskName);
            const enabledByController =
              cacheTaskEnabledForController(
                task.enabledByController,
                previousControllerName,
                task.enabled,
              ) ?? {};

            const enabled = resolveTaskEnabledForController(
              task,
              taskDef,
              previousControllerName,
              controllerName,
              enabledByController,
            );

            return {
              ...task,
              enabled,
              enabledByController: cacheTaskEnabledForController(
                enabledByController,
                controllerName,
                enabled,
              ),
            };
          });

          return { ...instance, controllerName, selectedTasks: updatedTasks };
        });

        return {
          selectedController: {
            ...state.selectedController,
            [instanceId]: controllerName,
          },
          instances: updatedInstances,
        };
      }),

    setSelectedResource: (instanceId, resourceName) =>
      set((state) => {
        const pi = state.projectInterface;
        // 自动取消不兼容任务的勾选
        const updatedInstances = state.instances.map((instance) => {
          if (instance.id !== instanceId)
            return { ...instance, resourceName: instance.resourceName };

          const updatedTasks = instance.selectedTasks.map((task) => {
            const taskDef = pi?.task.find((t) => t.name === task.taskName);
            // 如果任务指定了 resource 限制且不包含新资源，取消勾选
            if (taskDef?.resource && taskDef.resource.length > 0) {
              if (!taskDef.resource.includes(resourceName)) {
                return { ...task, enabled: false };
              }
            }
            return task;
          });

          return { ...instance, resourceName, selectedTasks: updatedTasks };
        });

        return {
          selectedResource: {
            ...state.selectedResource,
            [instanceId]: resourceName,
          },
          instances: updatedInstances,
        };
      }),

    // 保存设备信息到实例
    setInstanceSavedDevice: (instanceId, savedDevice) =>
      set((state) => ({
        instances: state.instances.map((i) => (i.id === instanceId ? { ...i, savedDevice } : i)),
      })),

    addPreAction: (
      instanceId: string,
      action: ActionConfig,
      dedup?: { field: 'program'; value: string },
    ) => {
      let added = true;
      set((state) => {
        if (dedup) {
          const inst = state.instances.find((i) => i.id === instanceId);
          if (
            inst?.preActions?.some(
              (a) => a[dedup.field].toLowerCase() === dedup.value.toLowerCase(),
            )
          ) {
            added = false;
            return state;
          }
        }
        return {
          instances: state.instances.map((i) =>
            i.id === instanceId ? { ...i, preActions: [...(i.preActions || []), action] } : i,
          ),
        };
      });
      return added;
    },

    updatePreAction: (instanceId: string, actionId: string, updates: Partial<ActionConfig>) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                preActions: i.preActions?.map((a) =>
                  a.id === actionId ? { ...a, ...updates } : a,
                ),
              }
            : i,
        ),
      })),

    removePreAction: (instanceId: string, actionId: string) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId) return i;
          const filtered = i.preActions?.filter((a) => a.id !== actionId);
          return { ...i, preActions: filtered?.length ? filtered : undefined };
        }),
      })),

    reorderPreActions: (instanceId: string, oldIndex: number, newIndex: number) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId || !i.preActions) return i;
          const len = i.preActions.length;
          if (oldIndex < 0 || oldIndex >= len || newIndex < 0 || newIndex >= len) return i;
          if (oldIndex === newIndex) return i;
          const items = [...i.preActions];
          const [removed] = items.splice(oldIndex, 1);
          items.splice(newIndex, 0, removed);
          return { ...i, preActions: items };
        }),
      })),

    renamePreAction: (instanceId: string, actionId: string, name: string) =>
      set((state) => ({
        instances: state.instances.map((i) =>
          i.id === instanceId
            ? {
                ...i,
                preActions: i.preActions?.map((a) =>
                  a.id === actionId ? { ...a, customName: name || undefined } : a,
                ),
              }
            : i,
        ),
      })),

    duplicatePreAction: (instanceId: string, actionId: string) =>
      set((state) => ({
        instances: state.instances.map((i) => {
          if (i.id !== instanceId || !i.preActions) return i;
          const idx = i.preActions.findIndex((a) => a.id === actionId);
          if (idx === -1) return i;
          const source = i.preActions[idx];
          const copy: ActionConfig = { ...source, id: generateId() };
          const items = [...i.preActions];
          items.splice(idx + 1, 0, copy);
          return { ...i, preActions: items };
        }),
      })),

    // 设备列表缓存
    cachedAdbDevices: [],
    cachedWin32Windows: [],
    cachedWlrootsSockets: [],
    cachedGamescopeInstances: [],
    setCachedAdbDevices: (devices) => set({ cachedAdbDevices: devices }),
    setCachedWin32Windows: (windows) => set({ cachedWin32Windows: windows }),
    setCachedWlrootsSockets: (sockets) => set({ cachedWlrootsSockets: sockets }),
    setCachedGamescopeInstances: (instances) => set({ cachedGamescopeInstances: instances }),

    // 从后端恢复 MAA 运行时状态（后端是单一真相来源）
    // skipRunningState: 运行时 state-changed 事件（connected/resource-loading）调用时
    // 为 true，避免过时的后端状态覆盖前端已设置的 isRunning（竞态：connect/resource 事件
    // 的防抖 getAllStates 可能在前端 setIsRunning(true) 之后、后端 startTasks 完成之前
    // 返回 false）。任务相关事件和初始化恢复时不传此选项，以后端为准。
    restoreBackendStates: (states, options) =>
      set((currentState) => {
        const skipRunning = options?.skipRunningState ?? false;
        const connectionStatus: Record<string, ConnectionStatus> = {};
        const resourceLoaded: Record<string, boolean> = {};
        const taskStatus: Record<string, TaskStatus | null> = {};
        const instanceTaskRunStatus: Record<string, Record<string, TaskRunStatus>> = {};
        const instanceTaskRunSelection = { ...currentState.instanceTaskRunSelection };
        const maaTaskIdMapping: Record<string, Record<number, string>> = {};
        const instancePendingTaskIds: Record<string, number[]> = {};
        const instanceCurrentTaskIndex: Record<string, number> = {};

        // 更新实例的 isRunning 状态
        const updatedInstances = currentState.instances.map((instance) => {
          const backendState = states.instances[instance.id];
          if (backendState) {
            const isRunning = skipRunning ? instance.isRunning : backendState.isRunning;
            return { ...instance, isRunning };
          }
          return instance;
        });

        for (const [instanceId, state] of Object.entries(states.instances)) {
          connectionStatus[instanceId] = state.connected ? 'Connected' : 'Disconnected';
          resourceLoaded[instanceId] = state.resourceLoaded;

          // 从后端 task_run_state 恢复任务运行状态
          const trs = state.taskRunState;
          if (trs) {
            // 转换 statuses（string -> TaskRunStatus）
            const statuses: Record<string, TaskRunStatus> = {};
            for (const [k, v] of Object.entries(trs.statuses)) {
              statuses[k] = v as TaskRunStatus;
            }
            instanceTaskRunStatus[instanceId] = statuses;

            // 转换 mappings（string keys -> number keys）
            const mappings: Record<number, string> = {};
            for (const [k, v] of Object.entries(trs.mappings)) {
              mappings[Number(k)] = v;
            }
            maaTaskIdMapping[instanceId] = mappings;

            // 另一端可能已启动新批次（甚至瞬时完成）；新任务 ID 证明它不是旧批次残留。
            const previousMappings = currentState.maaTaskIdMapping[instanceId] ?? {};
            const hasNewTasks = Object.entries(mappings).some(
              ([maaId, selectedId]) => previousMappings[Number(maaId)] !== selectedId,
            );
            const selection = instanceTaskRunSelection[instanceId];
            const includedTaskIds = [...new Set(Object.values(mappings))];
            if (
              hasNewTasks &&
              (!selection || includedTaskIds.some((id) => !selection.includedTaskIds.includes(id)))
            ) {
              instanceTaskRunSelection[instanceId] = {
                weekday: new Date().getDay(),
                includedTaskIds,
                excludedByWeeklyScheduleIds: [],
              };
            }

            instancePendingTaskIds[instanceId] = trs.pendingTaskIds ?? [];
            instanceCurrentTaskIndex[instanceId] = trs.currentTaskIndex ?? 0;

            // 映射 overall_status → instanceTaskStatus
            if (skipRunning) {
              const existing = currentState.instanceTaskStatus[instanceId];
              if (existing) {
                taskStatus[instanceId] = existing;
              }
            } else if (state.isRunning) {
              taskStatus[instanceId] = 'Running';
            } else if (trs.overallStatus === 'Succeeded') {
              taskStatus[instanceId] = 'Succeeded';
            } else if (trs.overallStatus === 'Failed') {
              taskStatus[instanceId] = 'Failed';
            }
          }
        }

        return {
          instances: updatedInstances,
          instanceConnectionStatus: connectionStatus,
          instanceResourceLoaded: resourceLoaded,
          instanceTaskStatus: taskStatus,
          instanceTaskRunStatus,
          instanceTaskRunSelection,
          maaTaskIdMapping,
          instancePendingTaskIds,
          instanceCurrentTaskIndex,
          cachedAdbDevices: states.cachedAdbDevices,
          cachedWin32Windows: states.cachedWin32Windows,
          cachedWlrootsSockets: states.cachedWlrootsSockets,
          cachedGamescopeInstances: states.cachedGamescopeInstances,
        };
      }),

    // 截图流状态
    instanceScreenshotStreaming: {},
    setInstanceScreenshotStreaming: (instanceId, streaming) =>
      set((state) => ({
        instanceScreenshotStreaming: {
          ...state.instanceScreenshotStreaming,
          [instanceId]: streaming,
        },
      })),

    // 右侧面板折叠状态
    sidePanelExpanded: true,
    setSidePanelExpanded: (expanded) => {
      set({ sidePanelExpanded: expanded });
      if (!isTauri()) patchWebUILayout({ sidePanelExpanded: expanded });
    },
    toggleSidePanelExpanded: () => {
      set((state) => ({ sidePanelExpanded: !state.sidePanelExpanded }));
      if (!isTauri()) patchWebUILayout({ sidePanelExpanded: get().sidePanelExpanded });
    },

    // 右侧面板宽度和折叠状态
    rightPanelWidth: 320,
    rightPanelCollapsed: false,
    setRightPanelWidth: (width) => {
      set({ rightPanelWidth: width });
      if (!isTauri()) patchWebUILayout({ rightPanelWidth: width });
    },
    setRightPanelCollapsed: (collapsed) => {
      set({ rightPanelCollapsed: collapsed });
      if (!isTauri()) patchWebUILayout({ rightPanelCollapsed: collapsed });
    },

    // 添加任务面板高度
    addTaskPanelHeight: defaultAddTaskPanelHeight,
    setAddTaskPanelHeight: (height) => {
      const clamped = clampAddTaskPanelHeight(height);
      set({ addTaskPanelHeight: clamped });
      if (!isTauri()) patchWebUILayout({ addTaskPanelHeight: clamped });
    },

    // 卡片展开状态
    connectionPanelExpanded: true,
    screenshotPanelExpanded: true,
    setConnectionPanelExpanded: (expanded) => {
      set({ connectionPanelExpanded: expanded });
      if (!isTauri()) patchWebUILayout({ connectionPanelExpanded: expanded });
    },
    setScreenshotPanelExpanded: (expanded) => {
      set({ screenshotPanelExpanded: expanded });
      if (!isTauri()) patchWebUILayout({ screenshotPanelExpanded: expanded });
    },

    // 中控台视图模式
    dashboardView: false,
    setDashboardView: (enabled) => set({ dashboardView: enabled }),
    toggleDashboardView: () => set((state) => ({ dashboardView: !state.dashboardView })),

    // 窗口大小
    windowSize: defaultWindowSize,
    setWindowSize: (size) => {
      set({ windowSize: size });
      if (!isTauri()) patchWebUILayout({ windowSize: size });
    },

    // 窗口位置
    windowPosition: undefined,
    setWindowPosition: (position) => {
      set({ windowPosition: position });
      if (!isTauri()) patchWebUILayout({ windowPosition: position });
    },

    // MirrorChyan 更新设置
    mirrorChyanSettings: defaultMirrorChyanSettings,
    setMirrorChyanCdk: (cdk) =>
      set((state) => ({
        mirrorChyanSettings: { ...state.mirrorChyanSettings, cdk },
      })),
    setMirrorChyanChannel: (channel) =>
      set((state) => ({
        mirrorChyanSettings: { ...state.mirrorChyanSettings, channel },
      })),

    // 代理设置
    proxySettings: undefined,
    setProxySettings: (settings) => set({ proxySettings: settings }),

    // 任务选项预览显示设置
    showOptionPreview: true,
    setShowOptionPreview: (show) => {
      set({ showOptionPreview: show });
      if (!isTauri()) patchWebUILayout({ showOptionPreview: show });
    },

    // 实时截图帧率设置
    screenshotFrameRate: defaultScreenshotFrameRate,
    setScreenshotFrameRate: (rate) => {
      set({ screenshotFrameRate: rate });
      if (!isTauri()) patchWebUILayout({ screenshotFrameRate: rate });
    },

    // Welcome 弹窗显示记录
    welcomeShownHash: '',
    setWelcomeShownHash: (hash) => set({ welcomeShownHash: hash }),

    // 开发模式
    devMode: false,
    setDevMode: (devMode) => set({ devMode }),

    // 通信兼容模式
    tcpCompatMode: false,
    setTcpCompatMode: (enabled) => set({ tcpCompatMode: enabled }),

    // 局域网访问（Web UI 绑定 0.0.0.0，需重启生效）
    allowLanAccess: false,
    setAllowLanAccess: (enabled) => set({ allowLanAccess: enabled }),

    // Web 服务器启用开关（默认 true，需重启生效）
    webServerEnabled: true,
    setWebServerEnabled: (enabled) => set({ webServerEnabled: enabled }),

    // Web 服务器端口（默认 12701，需重启生效）
    webServerPort: 12701,
    setWebServerPort: (port) => set({ webServerPort: port }),

    // 后端真实 OS/架构（运行时从后端获取，不持久化；用于控制器平台过滤、更新资产匹配等）
    backendOS: '',
    backendArch: '',
    setBackendOS: (os, arch) => set({ backendOS: os, backendArch: arch }),

    // 是否为开机自启动模式
    isAutoStartMode: false,
    setIsAutoStartMode: (mode) => set({ isAutoStartMode: mode }),

    // 启动后自动执行的实例 ID
    autoStartInstanceId: undefined,
    setAutoStartInstanceId: (id) =>
      set({
        autoStartInstanceId: id,
        // 用户重新选择配置时，清除"被删除"的提示标记
        autoStartRemovedInstanceName: undefined,
      }),

    // 被删除的自动执行实例名称（用于提示用户）
    autoStartRemovedInstanceName: undefined,
    setAutoStartRemovedInstanceName: (name) => set({ autoStartRemovedInstanceName: name }),

    // 手动启动时是否也自动执行
    autoRunOnLaunch: false,
    setAutoRunOnLaunch: (enabled) => set({ autoRunOnLaunch: enabled }),

    // 托盘设置
    minimizeToTray: false,
    setMinimizeToTray: async (enabled) => {
      set({ minimizeToTray: enabled });
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_minimize_to_tray', { enabled });
      } catch (err) {
        loggers.app.error('设置托盘选项失败:', err);
      }
    },

    // 新用户引导
    onboardingCompleted: false,
    setOnboardingCompleted: (completed) => set({ onboardingCompleted: completed }),

    // 前置动作连接延迟（默认 5 秒）
    preActionConnectDelaySec: 5,

    // 更新检查状态
    updateInfo: null,
    updateCheckLoading: false,
    showUpdateDialog: false,
    setUpdateInfo: (info) => set({ updateInfo: info }),
    setUpdateCheckLoading: (loading) => set({ updateCheckLoading: loading }),
    setShowUpdateDialog: (show) => set({ showUpdateDialog: show }),

    // 下载状态
    downloadStatus: 'idle',
    downloadProgress: null,
    downloadSavePath: null,
    slowDownloadSince: null,
    // 每次状态变化都重置慢速计时：'downloading' 表示新一轮下载开始，其余状态表示下载已结束
    setDownloadStatus: (status) => set({ downloadStatus: status, slowDownloadSince: null }),
    // 要求 downloadedSize > 0 才起算：下载开始前先写入的那条 speed 为 0 的占位进度，
    // 以及 Rust 建连/重定向期间（进度事件还没开始推送）都不应计入慢速时长
    setDownloadProgress: (progress) =>
      set((state) => ({
        downloadProgress: progress,
        slowDownloadSince:
          progress && progress.downloadedSize > 0 && progress.speed < SLOW_DOWNLOAD_SPEED_BPS
            ? (state.slowDownloadSince ?? Date.now())
            : null,
      })),
    setDownloadSavePath: (path) => set({ downloadSavePath: path }),
    resetDownloadState: () =>
      set({
        downloadStatus: 'idle',
        downloadProgress: null,
        downloadSavePath: null,
        slowDownloadSince: null,
      }),

    // 安装状态
    showInstallConfirmModal: false,
    installStatus: 'idle',
    installError: null,
    justUpdatedInfo: null,
    setShowInstallConfirmModal: (show) =>
      set({
        showInstallConfirmModal: show,
        // 打开模态框时自动关闭更新气泡
        ...(show && { showUpdateDialog: false }),
      }),
    setInstallStatus: (status) => set({ installStatus: status }),
    setInstallError: (error) => set({ installError: error }),
    setJustUpdatedInfo: (info) => set({ justUpdatedInfo: info }),
    autoInstallPending: false,
    setAutoInstallPending: (pending) => set({ autoInstallPending: pending }),
    resetInstallState: () =>
      set({
        installStatus: 'idle',
        installError: null,
        autoInstallPending: false,
      }),

    // 最近关闭的实例
    recentlyClosed: [],

    reopenRecentlyClosed: (id) => {
      const state = get();
      const closedInstance = state.recentlyClosed.find((i) => i.id === id);
      if (!closedInstance) return null;

      const pi = state.projectInterface;

      const newId = generateId();
      const newInstance: Instance = {
        id: newId,
        name: closedInstance.name,
        controllerId: closedInstance.controllerId,
        resourceId: closedInstance.resourceId,
        controllerName: closedInstance.controllerName,
        resourceName: closedInstance.resourceName,
        savedDevice: closedInstance.savedDevice,
        selectedTasks: closedInstance.tasks.map((t) => ({
          id: generateId(),
          taskName: t.taskName,
          customName: t.customName,
          enabled: t.enabled,
          enabledByController: t.enabledByController ? { ...t.enabledByController } : undefined,
          weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
          optionValues: restoreOptionValuesFromConfig(t.optionValues, pi, pi?.name),
          expanded: t.expanded ?? false,
          collapsedOptions: t.collapsedOptions ? { ...t.collapsedOptions } : undefined,
        })),
        isRunning: false,
        schedulePolicies: normalizeSchedulePolicies(closedInstance),
        preActions: migratePreActions(closedInstance),
      };

      // 恢复选中的控制器和资源状态
      const newSelectedController = { ...state.selectedController };
      const newSelectedResource = { ...state.selectedResource };
      if (closedInstance.controllerName) {
        newSelectedController[newId] = closedInstance.controllerName;
      }
      if (closedInstance.resourceName) {
        newSelectedResource[newId] = closedInstance.resourceName;
      }

      set({
        instances: [...state.instances, newInstance],
        activeInstanceId: newId,
        recentlyClosed: state.recentlyClosed.filter((i) => i.id !== id),
        selectedController: newSelectedController,
        selectedResource: newSelectedResource,
      });

      return newId;
    },

    removeFromRecentlyClosed: (id) =>
      set((state) => ({
        recentlyClosed: state.recentlyClosed.filter((i) => i.id !== id),
      })),

    clearRecentlyClosed: () => set({ recentlyClosed: [] }),

    // 任务运行状态（只读缓存，由 restoreBackendStates 填充）
    instanceTaskRunStatus: {},
    instanceTaskRunSelection: {},
    setTaskRunSelection: (instanceId, selection) =>
      set((state) => ({
        instanceTaskRunSelection: { ...state.instanceTaskRunSelection, [instanceId]: selection },
      })),
    maaTaskIdMapping: {},
    instancePendingTaskIds: {},
    instanceCurrentTaskIndex: {},

    findSelectedTaskIdByMaaTaskId: (instanceId, maaTaskId) => {
      const state = get();
      const mapping = state.maaTaskIdMapping[instanceId];
      return mapping?.[maaTaskId] ?? null;
    },

    findMaaTaskIdBySelectedTaskId: (instanceId, selectedTaskId) => {
      const mapping = get().maaTaskIdMapping[instanceId];
      if (!mapping) return null;
      for (const [maaTaskIdStr, taskId] of Object.entries(mapping)) {
        if (taskId === selectedTaskId) {
          return Number(maaTaskIdStr);
        }
      }
      return null;
    },

    clearTaskRunStatus: (instanceId) => {
      set((state) => ({
        instanceTaskRunSelection: Object.fromEntries(
          Object.entries(state.instanceTaskRunSelection).filter(([id]) => id !== instanceId),
        ),
        instanceTaskRunStatus: Object.fromEntries(
          Object.entries(state.instanceTaskRunStatus).filter(([id]) => id !== instanceId),
        ),
        maaTaskIdMapping: Object.fromEntries(
          Object.entries(state.maaTaskIdMapping).filter(([id]) => id !== instanceId),
        ),
        instancePendingTaskIds: Object.fromEntries(
          Object.entries(state.instancePendingTaskIds).filter(([id]) => id !== instanceId),
        ),
        instanceCurrentTaskIndex: Object.fromEntries(
          Object.entries(state.instanceCurrentTaskIndex).filter(([id]) => id !== instanceId),
        ),
      }));
    },

    clearControllerRuntimeState: (instanceId) => {
      get().clearLogs(instanceId);
      get().clearTaskRunStatus(instanceId);

      set((state) => {
        const trackedCtrlIds = state.instanceCtrlIds[instanceId] ?? [];
        const nextCtrlIdToName = { ...state.ctrlIdToName };
        const nextCtrlIdToType = { ...state.ctrlIdToType };

        for (const ctrlId of trackedCtrlIds) {
          delete nextCtrlIdToName[ctrlId];
          delete nextCtrlIdToType[ctrlId];
        }

        const { [instanceId]: _removedCtrlIds, ...restInstanceCtrlIds } = state.instanceCtrlIds;
        const { [instanceId]: _removedConnectionStatus, ...restConnectionStatus } =
          state.instanceConnectionStatus;
        const { [instanceId]: _removedResourceLoaded, ...restResourceLoaded } =
          state.instanceResourceLoaded;
        const { [instanceId]: _removedCurrentTaskId, ...restCurrentTaskId } =
          state.instanceCurrentTaskId;
        const { [instanceId]: _removedTaskStatus, ...restTaskStatus } = state.instanceTaskStatus;

        return {
          ctrlIdToName: nextCtrlIdToName,
          ctrlIdToType: nextCtrlIdToType,
          instanceCtrlIds: restInstanceCtrlIds,
          instanceConnectionStatus: restConnectionStatus,
          instanceResourceLoaded: restResourceLoaded,
          instanceCurrentTaskId: restCurrentTaskId,
          instanceTaskStatus: restTaskStatus,
          instanceScreenshotStreaming: Object.fromEntries(
            Object.entries(state.instanceScreenshotStreaming).filter(([id]) => id !== instanceId),
          ),
          scheduleExecutions: Object.fromEntries(
            Object.entries(state.scheduleExecutions).filter(([id]) => id !== instanceId),
          ),
        };
      });
    },

    // 定时执行状态
    scheduleExecutions: {},

    setScheduleExecution: (instanceId, info) =>
      set((state) => ({
        scheduleExecutions: info
          ? { ...state.scheduleExecutions, [instanceId]: info }
          : Object.fromEntries(
              Object.entries(state.scheduleExecutions).filter(([id]) => id !== instanceId),
            ),
      })),

    clearScheduleExecution: (instanceId) =>
      set((state) => ({
        scheduleExecutions: Object.fromEntries(
          Object.entries(state.scheduleExecutions).filter(([id]) => id !== instanceId),
        ),
      })),

    // 日志管理
    instanceLogs: {},

    addLog: (instanceId, log) =>
      set((state) => {
        const logs = state.instanceLogs[instanceId] || [];
        const now = new Date();
        const newLog: LogEntry = {
          id: generateId(),
          timestamp: now,
          ...log,
        };

        forwardLogToStdout(log.message);

        pushLogToBackend(instanceId, {
          id: newLog.id,
          timestamp: now.toISOString(),
          type: newLog.type,
          message: newLog.message,
          html: newLog.html,
        });

        const rawLimit = Number.isFinite(state.maxLogsPerInstance)
          ? state.maxLogsPerInstance
          : DEFAULT_MAX_LOGS_PER_INSTANCE;
        const limit = Math.min(10000, Math.max(100, Math.floor(rawLimit)));
        const updatedLogs = [...logs, newLog].slice(-limit);
        const nextLogs = {
          ...state.instanceLogs,
          [instanceId]: updatedLogs,
        };
        persistRuntimeLogs(nextLogs, state.maxLogsPerInstance);
        return {
          instanceLogs: nextLogs,
        };
      }),

    clearLogs: (instanceId) => {
      clearLogsOnBackend(instanceId);
      set((state) => {
        const nextLogs = {
          ...state.instanceLogs,
          [instanceId]: [],
        };
        persistRuntimeLogs(nextLogs, state.maxLogsPerInstance);
        return {
          instanceLogs: nextLogs,
        };
      });
    },

    // 回调 ID 与名称的映射
    ctrlIdToName: {},
    ctrlIdToType: {},
    instanceCtrlIds: {},
    resIdToName: {},
    resBatchInfo: {},
    taskIdToName: {},
    entryToTaskName: {},

    registerCtrlIdName: (instanceId, ctrlId, name, type) =>
      set((state) => ({
        ctrlIdToName: { ...state.ctrlIdToName, [ctrlId]: name },
        ctrlIdToType: { ...state.ctrlIdToType, [ctrlId]: type },
        instanceCtrlIds: {
          ...state.instanceCtrlIds,
          [instanceId]: Array.from(new Set([...(state.instanceCtrlIds[instanceId] ?? []), ctrlId])),
        },
      })),

    registerResIdName: (resId, name) =>
      set((state) => ({
        resIdToName: { ...state.resIdToName, [resId]: name },
      })),

    registerResBatch: (resIds) =>
      set((state) => {
        const newBatchInfo = { ...state.resBatchInfo };
        resIds.forEach((resId, index) => {
          newBatchInfo[resId] = {
            isFirst: index === 0,
            isLast: index === resIds.length - 1,
          };
        });
        return { resBatchInfo: newBatchInfo };
      }),

    registerTaskIdName: (taskId, name) =>
      set((state) => ({
        taskIdToName: { ...state.taskIdToName, [taskId]: name },
      })),

    registerEntryTaskName: (entry, name) =>
      set((state) => ({
        entryToTaskName: { ...state.entryToTaskName, [entry]: name },
      })),

    getCtrlName: (ctrlId) => get().ctrlIdToName[ctrlId],
    getCtrlType: (ctrlId) => get().ctrlIdToType[ctrlId],
    getResName: (resId) => get().resIdToName[resId],
    getResBatchInfo: (resId) => get().resBatchInfo[resId],
    getTaskName: (taskId) => get().taskIdToName[taskId],
    getTaskNameByEntry: (entry) => get().entryToTaskName[entry],
  })),
);

const _isWebUI = !isTauri();

// 生成配置用于保存
function generateConfig(): MxuConfig {
  const state = useAppStore.getState();
  const pi = state.projectInterface;
  const projectName = pi?.name;
  const persistTasks = (tasks: SavedTask[]): SavedTask[] =>
    tasks.map((t) => ({
      ...t,
      optionValues: persistOptionValues(t.optionValues, pi, projectName),
    }));
  return {
    version: '1.0',
    instances: state.instances.map((inst) => ({
      id: inst.id,
      name: inst.name,
      controllerId: inst.controllerId,
      resourceId: inst.resourceId,
      controllerName: inst.controllerName,
      resourceName: inst.resourceName,
      savedDevice: inst.savedDevice,
      tasks: persistTasks(
        inst.selectedTasks.map((t) => ({
          id: t.id,
          taskName: t.taskName,
          customName: t.customName,
          enabled: t.enabled,
          enabledByController: cacheTaskEnabledForController(
            t.enabledByController,
            inst.controllerName,
            t.enabled,
          ),
          weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
          optionValues: t.optionValues,
          expanded: t.expanded,
          collapsedOptions: t.collapsedOptions,
        })),
      ),
      schedulePolicies: inst.schedulePolicies,
      preActions: inst.preActions,
    })),
    // WebUI 模式下保留后端原始的外观 & 布局设置，避免覆盖桌面端偏好
    ...(() => {
      const ba = _isWebUI ? getBackendAppearance() : undefined;
      const bl = _isWebUI ? getBackendLayout() : undefined;
      return {
        settings: {
          theme: ba?.theme ?? state.theme,
          accentColor: ba?.accentColor ?? state.accentColor,
          language: ba?.language ?? state.language,
          backgroundImage: ba?.backgroundImage ?? state.backgroundImage,
          backgroundOpacity: ba?.backgroundOpacity ?? state.backgroundOpacity,
          confirmBeforeDelete: state.confirmBeforeDelete,
          maxLogsPerInstance: state.maxLogsPerInstance,
          autoClearLogsOnLaunch: state.autoClearLogsOnLaunch,
          helpImproveSoftware: state.helpImproveSoftware,
          windowSize: bl?.windowSize ?? state.windowSize,
          windowPosition: bl?.windowPosition ?? state.windowPosition,
          showOptionPreview: bl?.showOptionPreview ?? state.showOptionPreview,
          sidePanelExpanded: bl?.sidePanelExpanded ?? state.sidePanelExpanded,
          rightPanelWidth: bl?.rightPanelWidth ?? state.rightPanelWidth,
          rightPanelCollapsed: bl?.rightPanelCollapsed ?? state.rightPanelCollapsed,
          addTaskPanelHeight: bl?.addTaskPanelHeight ?? state.addTaskPanelHeight,
          connectionPanelExpanded: bl?.connectionPanelExpanded ?? state.connectionPanelExpanded,
          screenshotPanelExpanded: bl?.screenshotPanelExpanded ?? state.screenshotPanelExpanded,
          screenshotFrameRate: bl?.screenshotFrameRate ?? state.screenshotFrameRate,
          mirrorChyan: {
            ...state.mirrorChyanSettings,
            cdk: '',
            cdkEncrypted: encryptCdk(state.mirrorChyanSettings.cdk, state.projectInterface?.name),
          },
          proxy: state.proxySettings,
          welcomeShownHash: state.welcomeShownHash,
          devMode: state.devMode,
          tcpCompatMode: state.tcpCompatMode,
          allowLanAccess: state.allowLanAccess,
          webServerEnabled: state.webServerEnabled,
          webServerPort: state.webServerPort,
          autoStartInstanceId: state.autoStartInstanceId,
          autoRunOnLaunch: state.autoRunOnLaunch,
          autoStartRemovedInstanceName: state.autoStartRemovedInstanceName,
          minimizeToTray: state.minimizeToTray,
          onboardingCompleted: state.onboardingCompleted,
          preActionConnectDelaySec: state.preActionConnectDelaySec,
          hotkeys: state.hotkeys,
        },
        customAccents: ba?.customAccents ?? state.customAccents,
      };
    })(),
    globalOptionValues: persistOptionValues(state.globalOptionValues, pi, projectName),
    recentlyClosed: state.recentlyClosed.map((rc) => ({
      ...rc,
      tasks: persistTasks(rc.tasks),
    })),
    interfaceTaskSnapshot: state.projectInterface?.task.map((t) => t.name) || [],
    newTaskNames: state.newTaskNames,
    lastActiveInstanceId: state.activeInstanceId || undefined,
    // 保存预设初始化标记
    presetInitialized: state.presetInitialized || undefined,
  };
}

// 防抖保存配置
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveConfig() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    const state = useAppStore.getState();
    // 仅在初始化完成后持久化，避免启动早期误覆盖用户配置
    if (!state.configPersistenceReady) return;
    // 保护性检查：必须已经识别到项目与数据目录
    if (!state.projectInterface?.name || !state.dataPath || state.dataPath === '.') return;

    const config = generateConfig();
    const projectName = state.projectInterface?.name;
    saveConfig(state.dataPath, config, projectName);
  }, 500);
}

// 订阅需要保存的状态变化
// WebUI 模式下外观 & 布局字段已独立存 localStorage，不参与 config 保存订阅
useAppStore.subscribe(
  (state) => ({
    instances: state.instances,
    activeInstanceId: state.activeInstanceId,
    globalOptionValues: state.globalOptionValues,
    ...(!_isWebUI && {
      theme: state.theme,
      accentColor: state.accentColor,
      language: state.language,
      customAccents: state.customAccents,
      windowSize: state.windowSize,
      windowPosition: state.windowPosition,
      showOptionPreview: state.showOptionPreview,
      sidePanelExpanded: state.sidePanelExpanded,
      rightPanelWidth: state.rightPanelWidth,
      rightPanelCollapsed: state.rightPanelCollapsed,
      addTaskPanelHeight: state.addTaskPanelHeight,
      connectionPanelExpanded: state.connectionPanelExpanded,
      screenshotPanelExpanded: state.screenshotPanelExpanded,
      screenshotFrameRate: state.screenshotFrameRate,
    }),
    confirmBeforeDelete: state.confirmBeforeDelete,
    maxLogsPerInstance: state.maxLogsPerInstance,
    autoClearLogsOnLaunch: state.autoClearLogsOnLaunch,
    helpImproveSoftware: state.helpImproveSoftware,
    mirrorChyanSettings: state.mirrorChyanSettings,
    proxySettings: state.proxySettings,
    welcomeShownHash: state.welcomeShownHash,
    devMode: state.devMode,
    tcpCompatMode: state.tcpCompatMode,
    allowLanAccess: state.allowLanAccess,
    webServerEnabled: state.webServerEnabled,
    webServerPort: state.webServerPort,
    autoStartInstanceId: state.autoStartInstanceId,
    autoRunOnLaunch: state.autoRunOnLaunch,
    autoStartRemovedInstanceName: state.autoStartRemovedInstanceName,
    minimizeToTray: state.minimizeToTray,
    onboardingCompleted: state.onboardingCompleted,
    hotkeys: state.hotkeys,
    recentlyClosed: state.recentlyClosed,
    newTaskNames: state.newTaskNames,
    presetInitialized: state.presetInitialized,
  }),
  () => {
    debouncedSaveConfig();
  },
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
);

/**
 * 立即将当前状态序列化为 MxuConfig（不触发防抖保存）。
 * 供 beforeunload 等需要同步获取快照的场景使用。
 * 返回 null 表示当前状态不满足保存条件。
 */
export function flushConfig(): MxuConfig | null {
  const state = useAppStore.getState();
  if (!state.configPersistenceReady) return null;
  if (!state.projectInterface?.name) return null;
  return generateConfig();
}

/**
 * 取消待执行的防抖保存并立即执行一次保存。
 * 供 beforeunload 等需要确保最新状态落盘的场景使用。
 */
export function flushSaveConfig(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  const state = useAppStore.getState();
  if (!state.configPersistenceReady) return;
  if (!state.projectInterface?.name || !state.dataPath || state.dataPath === '.') return;
  const config = generateConfig();
  const projectName = state.projectInterface.name;
  saveConfig(state.dataPath, config, projectName);
}
