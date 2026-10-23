import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckSquare,
  Square,
  ChevronsUpDown,
  ChevronsDownUp,
  Plus,
  Play,
  StopCircle,
  Loader2,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { isTaskCompatible } from '@/stores/helpers';
import { maaService } from '@/services/maaService';
import { buildTaskOptionSummary } from '@/services/telemetryService';
import { collectPasswordPlaintextsFromRunnableTasks } from '@/utils/passwordOptionValues';
import clsx from 'clsx';
import {
  loggers,
  generateTaskPipelineOverride,
  computeResourcePaths,
  requiresUnlockedWorkstation,
} from '@/utils';
import { getMxuSpecialTask } from '@/types/specialTasks';
import {
  isPretaskName,
  getPretaskItem,
  getPretaskItems,
  pretaskName,
  buildPretaskArgs,
  resolveCompatTaskDef,
} from '@/types/pretasks';
import type { TaskConfig, ControllerConfig, GamescopeInstance } from '@/types/maa';
import { normalizeAgentConfigs } from '@/types/interface';
import {
  buildDesktopWindowControllerConfig,
  buildLinuxControllerConfig,
  getDesktopWindowFilters,
  findMatchingAdbDevice,
  getLinuxDeviceName,
  getLinuxDiscoveryNeeds,
  isDesktopWindowControllerType,
} from '@/utils/controller';
import { buildPlayCoverControllerConfig } from '@/utils/playCoverController';
import { SchedulePanel } from './SchedulePanel';
import type {
  Instance,
  TaskItem,
  PretaskItem,
  ControllerItem,
  SavedDeviceInfo,
} from '@/types/interface';
import { resolveI18nText } from '@/services/contentResolver';
import { getInterfaceLangKey } from '@/i18n';
import { PermissionModal } from './toolbar/PermissionModal';
import { ScheduleButton } from './toolbar/ScheduleButton';
import {
  startGlobalCallbackListener,
  waitForResResult,
} from '@/components/connection/callbackCache';
import { scheduleService } from '@/services/scheduleService';
import { stopInstanceTasks } from '@/services/taskStopService';
import { taskStartService, type TaskStartOptions } from '@/services/taskStartService';
import { isTaskSelectedForRun, filterTasksForRun } from '@/utils/taskRunFilter';
import { isTauri } from '@/utils/paths';
import { onStateChanged } from '@/services/wsService';
import { buildPiEnvVars } from '@/utils/piEnv';
import {
  formatCheckboxCountViolation,
  validateInstanceCheckboxCounts,
} from '@/utils/checkboxOptionValidation';

const log = loggers.task;
const PRE_ACTION_CANCELLED_ERROR = 'MXU_PRE_ACTION_CANCELLED';

/**
 * 发现 Linux 控制器所需的全部设备并构建运行时配置。
 * savedDevice 存在时按保存值精确匹配，否则自动选择第一个。
 */
async function discoverLinuxControllerConfig(
  controller: ControllerItem,
  savedDevice: SavedDeviceInfo | undefined,
  labels: { portal: string; linux: string },
): Promise<{ config: ControllerConfig; deviceName: string } | null> {
  const needs = getLinuxDiscoveryNeeds(controller);

  let wlrPath: string | undefined;
  let gamescopeInstance: GamescopeInstance | undefined;

  if (needs.needWlrSocket) {
    const sockets = await maaService.findWlrootsSockets();
    const matched = savedDevice?.wlrSocketPath
      ? sockets.find((s) => s === savedDevice.wlrSocketPath)
      : sockets[0];
    if (!matched) {
      log.warn(
        `未找到 WlRoots socket${savedDevice?.wlrSocketPath ? ` (${savedDevice.wlrSocketPath})` : ''}`,
      );
      return null;
    }
    wlrPath = matched;
  }
  if (needs.needGamescopeNode || needs.needEisSocket) {
    const instances = await maaService.findGamescopeInstances();
    const eligible = instances.filter((inst) => {
      if (needs.needGamescopeNode && inst.pipewire_node_id === 0) return false;
      if (needs.needEisSocket && !inst.eis_socket_path) return false;
      return true;
    });
    const matched =
      savedDevice?.gamescopeDisplayNo !== undefined
        ? eligible.find((i) => i.display_no === savedDevice.gamescopeDisplayNo)
        : eligible[0];
    if (!matched) {
      log.warn(
        `未找到 gamescope 实例${savedDevice?.gamescopeDisplayNo !== undefined ? ` (gamescope-${savedDevice.gamescopeDisplayNo})` : ''}`,
      );
      return null;
    }
    gamescopeInstance = matched;
  }

  const config = buildLinuxControllerConfig(controller, {
    wlrSocketPath: wlrPath,
    pwNodeId: gamescopeInstance?.pipewire_node_id,
    eisSocketPath: gamescopeInstance?.eis_socket_path || undefined,
    uinputScreenWidth: savedDevice?.uinputScreenWidth,
    uinputScreenHeight: savedDevice?.uinputScreenHeight,
  });

  const deviceName = getLinuxDeviceName(
    controller,
    {
      wlrSocketPath: wlrPath,
      gamescopeDisplayNo: gamescopeInstance?.display_no,
    },
    labels,
  );

  return { config, deviceName };
}

interface ToolbarProps {
  showAddPanel: boolean;
  onToggleAddPanel: () => void;
  className?: string;
}

// 自动连接阶段
type AutoConnectPhase = 'idle' | 'searching' | 'connecting' | 'loading_resource';

export function Toolbar({ showAddPanel, onToggleAddPanel, className }: ToolbarProps) {
  const { t } = useTranslation();
  const {
    getActiveInstance,
    selectAllTasks,
    collapseAllTasks,
    updateInstance,
    projectInterface,
    basePath,
    instanceConnectionStatus,
    instanceResourceLoaded,
    setInstanceCurrentTaskId,
    setInstanceTaskStatus,
    setInstanceConnectionStatus,
    setInstanceResourceLoaded,
    selectedController,
    selectedResource,
    // 定时执行状态
    scheduleExecutions,
    setScheduleExecution,
    clearScheduleExecution,
    // 回调 ID 映射
    registerCtrlIdName,
    registerResIdName,
    registerResBatch,
    registerTaskIdName,
    registerEntryTaskName,
    // 日志
    addLog,
    // 添加任务面板
    setShowAddTaskPanel,
    // 国际化
    interfaceTranslations,
    language,
    // 调试设置
    tcpCompatMode,
    // MaaFramework 版本
    maaVersion,
  } = useAppStore();

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);

  // 自动连接状态
  const [autoConnectPhase, setAutoConnectPhase] = useState<AutoConnectPhase>('idle');
  const [autoConnectError, setAutoConnectError] = useState<string | null>(null);

  // 权限提示弹窗状态
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [isRestartingAsAdmin, setIsRestartingAsAdmin] = useState(false);
  const [preActionControlledInstanceId, setPreActionControlledInstanceId] = useState<string | null>(
    null,
  );
  const preActionControlledInstanceIdRef = useRef<string | null>(null);
  const preActionStopRequestedRef = useRef(false);
  const lastStartCancelledRef = useRef(false);
  const startingRef = useRef(false);

  const instance = getActiveInstance();
  const tasks = instance?.selectedTasks || [];
  const anyExpanded = tasks.some((t) => t.expanded);

  // 获取当前语言的翻译
  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  const instanceId = instance?.id || '';
  const isPreActionControlledInstance =
    Boolean(instanceId) && preActionControlledInstanceId === instanceId;
  const isStartStopRunning = Boolean(instance?.isRunning) || isPreActionControlledInstance;

  // 检查是否有保存的设备和资源配置（用于权限检查等）
  const currentControllerName =
    selectedController[instanceId] ||
    instance?.controllerName ||
    projectInterface?.controller[0]?.name;
  const currentResourceName =
    selectedResource[instanceId] || instance?.resourceName || projectInterface?.resource[0]?.name;
  const currentController = projectInterface?.controller.find(
    (c) => c.name === currentControllerName,
  );

  // 全选状态仅考虑兼容当前控制器/资源的任务
  const allEnabled = useMemo(() => {
    if (tasks.length === 0) return false;
    const compatibleTasks = tasks.filter((t) => {
      const taskDef = projectInterface?.task.find((td) => td.name === t.taskName);
      return isTaskCompatible(taskDef, currentControllerName, currentResourceName);
    });
    return compatibleTasks.length > 0 && compatibleTasks.every((t) => t.enabled);
  }, [tasks, projectInterface, currentControllerName, currentResourceName]);

  // 只要有启用的任务就可以运行（连接和资源加载会在 startTasksForInstance 中自动处理）
  const canRun = tasks.some(isTaskSelectedForRun);

  const handleSelectAll = () => {
    if (!instance) return;
    selectAllTasks(instance.id, !allEnabled);
  };

  const handleCollapseAll = () => {
    if (!instance) return;
    collapseAllTasks(instance.id, !anyExpanded);
  };

  /**
   * 初始化 MaaFramework
   */
  const ensureMaaInitialized = async () => {
    try {
      await maaService.getVersion();
      return true;
    } catch {
      await maaService.init();
      return true;
    }
  };

  const beginPreActionControl = useCallback(async (targetInstanceId: string) => {
    await maaService.setPreActionStop(targetInstanceId, false);
    preActionControlledInstanceIdRef.current = targetInstanceId;
    preActionStopRequestedRef.current = false;
    setPreActionControlledInstanceId(targetInstanceId);
  }, []);

  const endPreActionControl = useCallback(async (targetInstanceId: string) => {
    if (preActionControlledInstanceIdRef.current === targetInstanceId) {
      preActionControlledInstanceIdRef.current = null;
      preActionStopRequestedRef.current = false;
      setPreActionControlledInstanceId((current) =>
        current === targetInstanceId ? null : current,
      );
    }
    try {
      await maaService.setPreActionStop(targetInstanceId, false);
    } catch (err) {
      log.warn('清理前置程序停止标记失败:', err);
    }
  }, []);

  const throwIfPreActionStopped = useCallback((targetInstanceId: string) => {
    if (
      preActionControlledInstanceIdRef.current === targetInstanceId &&
      preActionStopRequestedRef.current
    ) {
      throw new Error(PRE_ACTION_CANCELLED_ERROR);
    }
  }, []);

  const waitWithStopCheck = useCallback(
    async (totalMs: number, targetInstanceId: string) => {
      const intervalMs = 100;
      let elapsed = 0;
      while (elapsed < totalMs) {
        throwIfPreActionStopped(targetInstanceId);
        const sleepMs = Math.min(intervalMs, totalMs - elapsed);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        elapsed += sleepMs;
      }
      throwIfPreActionStopped(targetInstanceId);
    },
    [throwIfPreActionStopped],
  );

  /**
   * 统一任务启动入口 - 供手动启动、定时启动、快捷键启动等场景复用
   * @param targetInstance 目标实例
   * @param options 启动选项
   * @returns 是否成功启动
   */
  const startTasksForInstance = useCallback(
    async (targetInstance: Instance, options?: TaskStartOptions): Promise<boolean> => {
      const { schedulePolicyName, onPhaseChange, startFromTaskId, singleTaskId } = options || {};
      const targetId = targetInstance.id;
      const targetTasks = targetInstance.selectedTasks || [];
      lastStartCancelledRef.current = false;

      const failStart = (reason: string): false => {
        const message = `${t('taskList.autoConnect.startFailed')}: ${reason}`;
        log.warn(`实例 ${targetInstance.name}: ${message}`);
        addLog(targetId, { type: 'error', message });
        onPhaseChange?.('idle');
        return false;
      };

      const tasksToRun = filterTasksForRun(targetTasks, { startFromTaskId, singleTaskId });
      if (tasksToRun.length === 0) {
        if (singleTaskId || startFromTaskId) {
          return failStart(t('taskList.autoConnect.taskNotFound'));
        }
        return failStart(t('dashboard.noEnabledTasks'));
      }

      // 检查是否正在运行
      if (targetInstance.isRunning || preActionControlledInstanceIdRef.current === targetId) {
        return failStart(t('taskList.autoConnect.alreadyRunning'));
      }

      // 获取控制器和资源配置：必须按 targetInstance 解析，定时任务启动的实例可能不是当前标签页
      const controllerName =
        selectedController[targetId] ||
        targetInstance.controllerName ||
        projectInterface?.controller[0]?.name;
      const resourceName =
        selectedResource[targetId] ||
        targetInstance.resourceName ||
        projectInterface?.resource[0]?.name;

      // 过滤掉不兼容当前控制器/资源的任务
      const compatibleTasks = tasksToRun.filter((t) => {
        const taskDef = resolveCompatTaskDef(projectInterface, t.taskName);
        return isTaskCompatible(taskDef, controllerName, resourceName);
      });

      // 如果有任务因不兼容被跳过，记录警告
      const compatibleTaskIds = new Set(compatibleTasks.map((t) => t.id));
      const skippedTasks = tasksToRun.filter((t) => !compatibleTaskIds.has(t.id));
      if (skippedTasks.length > 0) {
        log.warn(
          `实例 ${targetInstance.name}: ${t('taskList.tasksSkippedDueToIncompatibility', { count: skippedTasks.length })}`,
        );
        // 向用户显示跳过任务的警告
        addLog(targetId, {
          type: 'warning',
          message: t('taskList.tasksSkippedDueToIncompatibility', { count: skippedTasks.length }),
        });
        skippedTasks.forEach((task) => {
          const taskDef = resolveCompatTaskDef(projectInterface, task.taskName);
          const taskLabel = taskDef?.label
            ? resolveI18nText(taskDef.label, translations)
            : task.taskName;

          // 检查是控制器不兼容还是资源不兼容
          const isControllerIncompatible =
            taskDef?.controller &&
            taskDef.controller.length > 0 &&
            controllerName &&
            !taskDef.controller.includes(controllerName);

          const isResourceIncompatible =
            taskDef?.resource &&
            taskDef.resource.length > 0 &&
            resourceName &&
            !taskDef.resource.includes(resourceName);

          if (isControllerIncompatible) {
            log.warn(`  - ${t('taskList.taskSkippedController', { taskName: taskLabel })}`);
          }
          if (isResourceIncompatible) {
            log.warn(`  - ${t('taskList.taskSkippedResource', { taskName: taskLabel })}`);
          }
        });
      }

      // 如果所有启用的任务都被过滤掉了，则无法启动
      if (compatibleTasks.length === 0) {
        return failStart(t('taskList.noCompatibleTasks'));
      }

      const checkboxViolations = validateInstanceCheckboxCounts(
        compatibleTasks,
        projectInterface,
        controllerName,
        resourceName,
        useAppStore.getState().globalOptionValues,
      );
      if (checkboxViolations.length > 0) {
        for (const violation of checkboxViolations) {
          const message = formatCheckboxCountViolation(
            violation,
            compatibleTasks,
            projectInterface,
            translations,
            t,
          );
          log.warn(`实例 ${targetInstance.name}: ${message}`);
          addLog(targetId, { type: 'error', message });
        }
        return false;
      }

      const controller = projectInterface?.controller.find((c) => c.name === controllerName);
      const resource = projectInterface?.resource.find((r) => r.name === resourceName);
      const savedDevice = targetInstance.savedDevice;

      // 检查是否有保存的设备配置
      const hasSavedDevice = Boolean(
        savedDevice &&
        (savedDevice.adbDeviceName ||
          savedDevice.windowName ||
          savedDevice.wlrSocketPath ||
          savedDevice.playcoverAddress),
      );
      if (!controller) {
        return failStart(t('errors.controllerNotFound'));
      }

      // 只有依赖 Windows 交互式桌面的实际控制器才受锁屏限制。
      // ADB、Linux 和 PlayCover 均可在锁屏时运行。
      if (
        requiresUnlockedWorkstation(controller.type) &&
        (await maaService.isWorkstationLocked())
      ) {
        return failStart(t('taskList.autoConnect.workstationLocked'));
      }

      const canUseSavedDevice = hasSavedDevice && savedDevice;

      let isTargetConnected = instanceConnectionStatus[targetId] === 'Connected';
      const isTargetResourceLoaded = instanceResourceLoaded[targetId] || false;

      // 判断是否可以运行：已连接+资源已加载、有保存设备+资源、或有控制器+资源（自动搜索）
      const canStartTask =
        (isTargetConnected && isTargetResourceLoaded) ||
        (hasSavedDevice && resource) ||
        (controller && resource);

      if (!canStartTask) {
        return failStart(t('taskList.autoConnect.needConfig'));
      }

      try {
        let needsReconnect = false;
        let shouldDelayAfterAdbConnected = false;

        // v2.7.0: 连接 Controller 前执行 pretask（如游戏设置），先于前置程序运行，
        // 确保诸如注册表写入等操作在应用被前置程序启动之前完成。
        // pretask 以伪任务形式存在于任务列表中，此处从已启用的兼容任务中筛出，
        // 并按协议以顶层 pretask 的声明顺序执行，与任务列表中的排列无关。
        const pretaskOrder = getPretaskItems(projectInterface).map((item) => pretaskName(item));
        const enabledPretasks = compatibleTasks
          .filter((task) => isPretaskName(task.taskName))
          .map((task) => ({ task, item: getPretaskItem(projectInterface, task.taskName) }))
          .filter((p): p is { task: (typeof compatibleTasks)[0]; item: PretaskItem } => !!p.item)
          .sort(
            (a, b) => pretaskOrder.indexOf(a.task.taskName) - pretaskOrder.indexOf(b.task.taskName),
          );

        if (enabledPretasks.length > 0) {
          await beginPreActionControl(targetId);
          try {
            for (const { task, item } of enabledPretasks) {
              const args = buildPretaskArgs(
                item,
                task.optionValues ?? {},
                projectInterface,
                controllerName,
                resourceName,
              );
              const displayName =
                resolveI18nText(item.label, translations) || item.name || item.exec;

              log.info(`实例 ${targetInstance.name}: 执行预任务:`, item.exec, args);
              addLog(targetId, {
                type: 'info',
                message: t('action.pretaskStarting', { name: displayName }),
              });

              throwIfPreActionStopped(targetId);
              const exitCode = await maaService.runPretask(targetId, item.exec, args, basePath);
              throwIfPreActionStopped(targetId);

              if (exitCode !== 0) {
                log.warn(`实例 ${targetInstance.name}: 预任务退出码非零:`, exitCode);
                addLog(targetId, {
                  type: 'warning',
                  message: t('action.pretaskExitCode', { code: exitCode }),
                });
              } else {
                addLog(targetId, {
                  type: 'success',
                  message: t('action.pretaskCompleted', { name: displayName }),
                });
              }
            }
          } catch (err) {
            if ((err instanceof Error ? err.message : String(err)) === PRE_ACTION_CANCELLED_ERROR) {
              // 取消由外层统一处理，finally 会清理前置控制状态
              throw err;
            }
            log.error(`实例 ${targetInstance.name}: 预任务执行失败:`, err);
            addLog(targetId, {
              type: 'error',
              message: t('action.pretaskFailed', { error: String(err) }),
            });
          } finally {
            await endPreActionControl(targetId);
          }
        }

        // 收集所有启用且有程序路径的前置程序，按列表顺序执行
        const allPreActions = (targetInstance.preActions ?? []).filter(
          (a) => a.enabled && a.program.trim(),
        );
        let preActionControlStarted = false;
        let preActionExecuted = false;

        if (allPreActions.length > 0) {
          preActionControlStarted = true;
          await beginPreActionControl(targetId);

          try {
            for (const preAction of allPreActions) {
              const programPath = preAction.program.trim();
              const processName = programPath.split(/[/\\]/).pop() || programPath;

              // 检查是否应跳过已运行的前置程序
              if (preAction.skipIfRunning) {
                if (await maaService.isProcessRunning(programPath)) {
                  log.info(`实例 ${targetInstance.name}: 前置程序已在运行，跳过执行:`, processName);
                  addLog(targetId, {
                    type: 'info',
                    message: t('action.preActionSkipped', { name: processName }),
                  });
                  continue;
                }
              }

              log.info(`实例 ${targetInstance.name}: 执行前置动作:`, programPath);
              addLog(targetId, {
                type: 'info',
                message: t('action.preActionStartingNamed', { name: processName }),
              });

              throwIfPreActionStopped(targetId);
              const exitCode = await maaService.runAction(
                targetId,
                programPath,
                preAction.args,
                basePath,
                preAction.waitForExit ?? true,
                preAction.useCmd ?? false,
              );
              throwIfPreActionStopped(targetId);
              preActionExecuted = true;
              needsReconnect = true;

              if (exitCode !== 0) {
                log.warn(`实例 ${targetInstance.name}: 前置动作退出码非零:`, exitCode);
                addLog(targetId, {
                  type: 'warning',
                  message: t('action.preActionExitCode', { code: exitCode }),
                });
              } else {
                addLog(targetId, {
                  type: 'success',
                  message: t('action.preActionCompletedNamed', { name: processName }),
                });
              }
            }

            // 所有前置程序执行完毕后，等待设备/窗口就绪再连接
            const shouldWaitAfterPreActions = preActionExecuted && !!controller;
            if (shouldWaitAfterPreActions && controller) {
              const controllerType = controller.type;
              const isWindowType = isDesktopWindowControllerType(controllerType);
              log.info(`实例 ${targetInstance.name}: 等待${isWindowType ? '窗口' : '设备'}就绪...`);
              if (isWindowType) {
                addLog(targetId, {
                  type: 'info',
                  message: savedDevice?.windowName
                    ? t('action.waitingForWindowNamed', { name: savedDevice.windowName })
                    : t('action.waitingForAnyWindow'),
                });
              } else {
                addLog(targetId, {
                  type: 'info',
                  message: savedDevice?.adbDeviceName
                    ? t('action.waitingForDeviceNamed', { name: savedDevice.adbDeviceName })
                    : t('action.waitingForAnyDevice'),
                });
              }
              let deviceFound = false;
              let attempts = 0;
              const maxAttempts = 300;

              while (!deviceFound && attempts < maxAttempts) {
                throwIfPreActionStopped(targetId);
                try {
                  if (controllerType === 'Adb') {
                    const devices = await maaService.findAdbDevices();
                    if (savedDevice?.adbDeviceName) {
                      deviceFound = !!findMatchingAdbDevice(devices, savedDevice);
                    } else {
                      deviceFound = devices.length > 0;
                    }
                  } else if (isDesktopWindowControllerType(controllerType)) {
                    const { classRegex, titleRegex } = getDesktopWindowFilters(controller);
                    const windows = await maaService.findWin32Windows(classRegex, titleRegex);
                    if (savedDevice?.windowName) {
                      deviceFound = windows.some((w) => w.window_name === savedDevice.windowName);
                    } else {
                      deviceFound = windows.length > 0;
                    }
                  } else if (controllerType === 'WlRoots') {
                    const sockets = await maaService.findWlrootsSockets();
                    if (savedDevice?.wlrSocketPath) {
                      deviceFound = sockets.includes(savedDevice.wlrSocketPath);
                    } else {
                      deviceFound = sockets.length > 0;
                    }
                  } else {
                    deviceFound = true;
                  }
                } catch (searchErr) {
                  log.warn(
                    `实例 ${targetInstance.name}: ${isWindowType ? '窗口' : '设备'}搜索出错:`,
                    searchErr,
                  );
                }

                if (!deviceFound) {
                  attempts++;
                  await waitWithStopCheck(1000, targetId);
                }
              }

              if (deviceFound) {
                log.info(`实例 ${targetInstance.name}: ${isWindowType ? '窗口' : '设备'}已就绪`);
                addLog(targetId, {
                  type: 'success',
                  message: isWindowType ? t('action.windowReady') : t('action.deviceReady'),
                });
                if (
                  !savedDevice?.windowName &&
                  !savedDevice?.adbDeviceName &&
                  !savedDevice?.wlrSocketPath &&
                  !savedDevice?.playcoverAddress
                ) {
                  try {
                    if (controllerType === 'Adb') {
                      const devices = await maaService.findAdbDevices();
                      if (devices.length > 0) {
                        addLog(targetId, {
                          type: 'info',
                          message: t('taskList.autoConnect.autoSelectedDevice', {
                            name: devices[0].name || devices[0].address,
                          }),
                        });
                      }
                    } else if (isDesktopWindowControllerType(controllerType)) {
                      const { classRegex, titleRegex } = getDesktopWindowFilters(controller);
                      const windows = await maaService.findWin32Windows(classRegex, titleRegex);
                      if (windows.length > 0) {
                        addLog(targetId, {
                          type: 'info',
                          message: t('taskList.autoConnect.autoSelectedWindow', {
                            name: windows[0].window_name || windows[0].class_name,
                          }),
                        });
                      }
                    } else if (controllerType === 'WlRoots') {
                      const sockets = await maaService.findWlrootsSockets();
                      if (sockets.length > 0) {
                        addLog(targetId, {
                          type: 'info',
                          message: t('taskList.autoConnect.autoSelectedDevice', {
                            name: sockets[0],
                          }),
                        });
                      }
                    }
                  } catch {
                    // 忽略二次搜索错误
                  }
                }

                // 设备/窗口已就绪，先等待稳定再连接
                const settleSec = useAppStore.getState().preActionConnectDelaySec ?? 5;
                if (settleSec > 0) {
                  log.info(
                    `实例 ${targetInstance.name}: ${isWindowType ? '窗口' : '设备'}已就绪，等待 ${settleSec} 秒稳定后连接...`,
                  );
                  await waitWithStopCheck(settleSec * 1000, targetId);
                }
                // 连接成功后再等待，避免”连接前固定等待”导致时序不稳定
                shouldDelayAfterAdbConnected = true;
              } else {
                log.warn(`实例 ${targetInstance.name}: 等待${isWindowType ? '窗口' : '设备'}超时`);
                addLog(targetId, {
                  type: 'warning',
                  message: isWindowType
                    ? t('action.windowWaitTimeout')
                    : t('action.deviceWaitTimeout'),
                });
              }
            }
          } catch (err) {
            if ((err instanceof Error ? err.message : String(err)) === PRE_ACTION_CANCELLED_ERROR) {
              throw err;
            }
            log.error(`实例 ${targetInstance.name}: 前置动作执行失败:`, err);
            addLog(targetId, {
              type: 'error',
              message: t('action.preActionFailed', { error: String(err) }),
            });
          } finally {
            if (preActionControlStarted) {
              await endPreActionControl(targetId);
            }
          }
        }

        // 前置程序重启了应用，旧连接已失效，重置连接状态以强制重新连接
        if (needsReconnect && isTargetConnected) {
          log.info(`实例 ${targetInstance.name}: 前置程序已重启应用，重置连接状态以重新连接`);
          setInstanceConnectionStatus(targetId, 'Disconnected');
        }

        // 查询后端真实连接状态，纠正前端可能过时的缓存
        if (isTargetConnected && !needsReconnect) {
          const backendState = await maaService.getInstanceState(targetId);
          if (!backendState || backendState.connectionStatus !== 'Connected') {
            log.warn(
              `实例 ${targetInstance.name}: 后端${backendState ? '连接已断开' : '实例不存在'}，但前端缓存为已连接，强制重新连接`,
            );
            setInstanceConnectionStatus(targetId, 'Disconnected');
            isTargetConnected = false;
          }
        }

        // 如果未连接（或需要重连），尝试自动连接
        if (!isTargetConnected || needsReconnect) {
          const controllerType = controller?.type;

          await ensureMaaInitialized();
          await maaService.createInstance(targetId).catch((err) => {
            log.warn('创建实例失败（可能已存在）:', err);
          });

          let config: ControllerConfig | null = null;
          let deviceName = '';
          let targetType: 'device' | 'window' = 'device';

          if (canUseSavedDevice && savedDevice && controllerType) {
            // 有保存的设备配置，地址优先匹配，兼容旧配置按名称匹配
            log.info(`实例 ${targetInstance.name}: 自动连接已保存的设备...`);
            onPhaseChange?.('searching');

            if (controllerType === 'Adb' && savedDevice.adbDeviceName) {
              const devices = await maaService.findAdbDevices();
              const matchedDevice = findMatchingAdbDevice(devices, savedDevice);
              if (!matchedDevice) {
                return failStart(
                  t('taskList.autoConnect.deviceNotFound', { name: savedDevice.adbDeviceName }),
                );
              }
              config = {
                type: 'Adb',
                adb_path: matchedDevice.adb_path,
                address: matchedDevice.address,
                screencap_methods: matchedDevice.screencap_methods,
                input_methods: matchedDevice.input_methods,
                config: matchedDevice.config,
                display_short_side: controller.display_short_side,
              };
              deviceName = matchedDevice.name || matchedDevice.address;
              targetType = 'device';
            } else if (isDesktopWindowControllerType(controllerType) && savedDevice.windowName) {
              const { classRegex, titleRegex } = getDesktopWindowFilters(controller);
              const windows = await maaService.findWin32Windows(classRegex, titleRegex);
              const matchedWindow = windows.find((w) => w.window_name === savedDevice.windowName);
              if (!matchedWindow) {
                return failStart(
                  t('taskList.autoConnect.windowNotFound', { name: savedDevice.windowName }),
                );
              }
              config = buildDesktopWindowControllerConfig(controller, matchedWindow.handle);
              deviceName = matchedWindow.window_name || matchedWindow.class_name;
              targetType = 'window';
            } else if (controllerType === 'WlRoots' && savedDevice.wlrSocketPath) {
              const sockets = await maaService.findWlrootsSockets();
              if (!sockets.includes(savedDevice.wlrSocketPath)) {
                return failStart(
                  t('taskList.autoConnect.deviceNotFound', { name: savedDevice.wlrSocketPath }),
                );
              }
              config = {
                type: 'WlRoots',
                wlr_socket_path: savedDevice.wlrSocketPath,
                use_win32_vk_code: controller.wlroots?.use_win32_vk_code ?? false,
              };
              deviceName = savedDevice.wlrSocketPath;
              targetType = 'device';
            } else if (controllerType === 'PlayCover' && savedDevice.playcoverAddress) {
              config = buildPlayCoverControllerConfig(
                savedDevice.playcoverAddress,
                controller.playcover?.uuid,
                controller.display_short_side,
              );
              deviceName = savedDevice.playcoverAddress;
              targetType = 'device';
            } else if (controllerType === 'Linux') {
              const found = await discoverLinuxControllerConfig(controller, savedDevice, {
                portal: t('controller.portal'),
                linux: t('controller.linux'),
              });
              if (!found) {
                return failStart(t('taskList.autoConnect.noDeviceFound'));
              }
              config = found.config;
              deviceName = found.deviceName;
              targetType = 'device';
            }
          } else if (controllerType) {
            // 没有保存的设备配置，自动搜索并连接第一个结果
            log.info(`实例 ${targetInstance.name}: 自动搜索设备并连接...`);
            onPhaseChange?.('searching');

            if (controllerType === 'Adb') {
              const devices = await maaService.findAdbDevices();
              if (devices.length === 0) {
                return failStart(t('taskList.autoConnect.noDeviceFound'));
              }
              const firstDevice = devices[0];
              log.info(`实例 ${targetInstance.name}: 自动选择设备: ${firstDevice.name}`);
              // 没有保存过设备，给出首次自动匹配提示
              addLog(targetId, {
                type: 'info',
                message: t('taskList.autoConnect.autoSelectedDevice', {
                  name: firstDevice.name || firstDevice.address,
                }),
              });
              config = {
                type: 'Adb',
                adb_path: firstDevice.adb_path,
                address: firstDevice.address,
                screencap_methods: firstDevice.screencap_methods,
                input_methods: firstDevice.input_methods,
                config: firstDevice.config,
                display_short_side: controller.display_short_side,
              };
              deviceName = firstDevice.name || firstDevice.address;
              targetType = 'device';
            } else if (isDesktopWindowControllerType(controllerType)) {
              const { classRegex, titleRegex } = getDesktopWindowFilters(controller);
              const windows = await maaService.findWin32Windows(classRegex, titleRegex);
              if (windows.length === 0) {
                return failStart(t('taskList.autoConnect.noWindowFound'));
              }
              const firstWindow = windows[0];
              log.info(`实例 ${targetInstance.name}: 自动选择窗口: ${firstWindow.window_name}`);
              // 没有保存过设备，给出首次自动匹配提示
              addLog(targetId, {
                type: 'info',
                message: t('taskList.autoConnect.autoSelectedWindow', {
                  name: firstWindow.window_name || firstWindow.class_name,
                }),
              });
              config = buildDesktopWindowControllerConfig(controller, firstWindow.handle);
              deviceName = firstWindow.window_name || firstWindow.class_name;
              targetType = 'window';
            } else if (controllerType === 'WlRoots') {
              const sockets = await maaService.findWlrootsSockets();
              if (sockets.length === 0) {
                return failStart(t('taskList.autoConnect.noDeviceFound'));
              }
              const firstSocket = sockets[0];
              log.info(`实例 ${targetInstance.name}: 自动选择 WlRoots socket: ${firstSocket}`);
              addLog(targetId, {
                type: 'info',
                message: t('taskList.autoConnect.autoSelectedDevice', {
                  name: firstSocket,
                }),
              });
              config = {
                type: 'WlRoots',
                wlr_socket_path: firstSocket,
                use_win32_vk_code: controller.wlroots?.use_win32_vk_code ?? false,
              };
              deviceName = firstSocket;
              targetType = 'device';
            } else if (controllerType === 'PlayCover') {
              // PlayCover 没有搜索功能，无法自动连接
              return failStart(t('taskList.autoConnect.needConfig'));
            } else if (controllerType === 'Linux') {
              const found = await discoverLinuxControllerConfig(controller, undefined, {
                portal: t('controller.portal'),
                linux: t('controller.linux'),
              });
              if (!found) {
                return failStart(t('taskList.autoConnect.noDeviceFound'));
              }
              config = found.config;
              deviceName = found.deviceName;
              targetType = 'device';
              log.info(`实例 ${targetInstance.name}: 自动选择 Linux 设备: ${found.deviceName}`);
              addLog(targetId, {
                type: 'info',
                message: t('taskList.autoConnect.autoSelectedDevice', {
                  name: found.deviceName,
                }),
              });
            }
          }

          if (!config) {
            return failStart(t('taskList.autoConnect.needConfig'));
          }

          onPhaseChange?.('connecting');

          const maxRetries = 3;
          let connectResult = false;

          for (let retry = 0; retry < maxRetries && !connectResult; retry++) {
            if (retry > 0) {
              throwIfPreActionStopped(targetId);
              log.info(`实例 ${targetInstance.name}: 连接失败，第 ${retry} 次重试...`);
              addLog(targetId, {
                type: 'info',
                message: t('taskList.autoConnect.retryConnect', { attempt: retry }),
              });
              await waitWithStopCheck(2000, targetId);
            }

            // 提前注册回调收集器，await 完成后再发起连接，避免竞态
            const collectedCallbacks: Array<{ message: string; details: { ctrl_id?: number } }> =
              [];
            const unsubscribe = await maaService.onCallback((message, details) => {
              if (
                message === 'Controller.Action.Succeeded' ||
                message === 'Controller.Action.Failed'
              ) {
                collectedCallbacks.push({ message, details });
              }
            });

            let ctrlId: number;
            try {
              ctrlId = await maaService.connectController(targetId, config);
            } catch (err) {
              unsubscribe();
              throw err;
            }

            // 注册 ctrl_id 与设备名/类型的映射
            registerCtrlIdName(targetId, ctrlId, deviceName, targetType);

            // 等待连接完成（同时监听 maa-callback 和 state-changed 两条路径）
            connectResult = await new Promise<boolean>((resolve) => {
              let resolved = false;

              const handleSuccess = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                unsubscribe();
                unlistenCb?.();
                unlistenState?.();
                setInstanceConnectionStatus(targetId, 'Connected');
                resolve(true);
              };

              const handleFailure = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                unsubscribe();
                unlistenCb?.();
                unlistenState?.();
                resolve(false);
              };

              const timeout = setTimeout(() => {
                if (!resolved) {
                  log.warn(`实例 ${targetInstance.name}: 连接超时`);
                  handleFailure();
                }
              }, 30000);

              // 路径 1：继续监听新的 maa-callback（Controller.Action.Succeeded/Failed）
              let unlistenCb: (() => void) | undefined;
              // 路径 2：监听 state-changed（兜底：后端已广播 connected 但 Action.Succeeded 可能因竞态丢失）
              // Tauri 桌面端走 app.emit() → listen()，WebSocket 端走 wsService
              let unlistenState: (() => void) | undefined;

              // 检查已收集的回调（注册监听器在 connectController 之前已完成）
              const match = collectedCallbacks.find((cb) => cb.details.ctrl_id === ctrlId);
              if (match) {
                if (match.message === 'Controller.Action.Succeeded') {
                  handleSuccess();
                } else {
                  handleFailure();
                }
                return;
              }

              maaService
                .onCallback((message, details) => {
                  if (resolved) return;
                  if (details.ctrl_id !== ctrlId) return;
                  if (message === 'Controller.Action.Succeeded') {
                    handleSuccess();
                  } else if (message === 'Controller.Action.Failed') {
                    handleFailure();
                  }
                })
                .then((cb) => {
                  if (!resolved) {
                    unlistenCb = cb;
                  } else {
                    cb();
                  }
                })
                .catch((err) => {
                  log.error(`实例 ${targetInstance.name}: 注册 maa-callback 监听失败:`, err);
                  handleFailure();
                });
              const handleStateChanged = (instanceId: string, kind: string) => {
                if (resolved) return;
                if (instanceId === targetId && kind === 'connected') {
                  log.info(`实例 ${targetInstance.name}: 通过 state-changed 兜底判定连接成功`);
                  handleSuccess();
                }
              };

              if (isTauri()) {
                import('@tauri-apps/api/event')
                  .then(({ listen }) =>
                    listen<{ instance_id: string; kind: string }>('state-changed', (event) =>
                      handleStateChanged(event.payload.instance_id, event.payload.kind),
                    ),
                  )
                  .then((dispose) => {
                    if (resolved) dispose();
                    else unlistenState = dispose;
                  })
                  .catch((err) => {
                    log.warn('注册 state-changed 监听失败:', err);
                  });
              } else {
                unlistenState = onStateChanged(handleStateChanged);
              }
            });
          }

          if (!connectResult) {
            return failStart(t('taskList.autoConnect.connectFailed'));
          }

          if (shouldDelayAfterAdbConnected) {
            const delaySec = useAppStore.getState().preActionConnectDelaySec ?? 5;
            if (delaySec > 0) {
              log.info(`实例 ${targetInstance.name}: 连接成功，等待 ${delaySec} 秒后继续...`);
              addLog(targetId, {
                type: 'info',
                message: t('action.preActionConnectDelay', { seconds: delaySec }),
              });
              await waitWithStopCheck(delaySec * 1000, targetId);
            }
          }
        }

        // 查询后端真实状态，纠正前端可能过时的缓存
        const backendState = await maaService.getInstanceState(targetId);
        if (backendState && !backendState.resourceLoaded && instanceResourceLoaded[targetId]) {
          log.warn(
            `实例 ${targetInstance.name}: 后端资源未加载，但前端缓存为已加载，重置缓存并强制重载`,
          );
          setInstanceResourceLoaded(targetId, false);
        }
        const isResourceReallyLoaded = backendState
          ? backendState.resourceLoaded
          : (instanceResourceLoaded[targetId] ?? false);

        // 如果资源未加载，尝试自动加载
        if (!isResourceReallyLoaded && resource) {
          log.info(`实例 ${targetInstance.name}: 加载资源...`);
          onPhaseChange?.('loading_resource');

          // 计算完整的资源路径（包括 controller.attach_resource_path）
          const resourcePaths = computeResourcePaths(resource, controller, basePath);

          const resIds = await maaService.loadResource(targetId, resourcePaths);

          // 注册 res_id 与资源名的映射
          const resDisplayName = resolveI18nText(resource.label, translations) || resource.name;
          registerResBatch(resIds);
          resIds.forEach((resId) => {
            registerResIdName(resId, resDisplayName);
          });

          // 等待资源加载完成（通过 callbackCache 缓存机制，避免竞态丢失回调）
          const results = await Promise.all(resIds.map((resId) => waitForResResult(resId, 60000)));
          const loadResult = results.every((r) => r === 'succeeded');
          if (loadResult) {
            setInstanceResourceLoaded(targetId, true);
          }

          if (!loadResult) {
            return failStart(t('taskList.autoConnect.resourceFailed'));
          }
        }

        onPhaseChange?.('idle');

        // 构建可运行任务列表（排除无法找到定义的任务）
        // 这确保了 taskConfigs、taskIds 和 runnableTasks 的索引对齐
        interface RunnableTask {
          taskName: string;
          selectedTask: (typeof compatibleTasks)[0];
          taskDef: NonNullable<ReturnType<typeof getMxuSpecialTask>>['taskDef'] | TaskItem;
          specialTask: ReturnType<typeof getMxuSpecialTask>;
        }
        const runnableTasks: RunnableTask[] = [];
        for (const selectedTask of compatibleTasks) {
          // pretask 不进入 Tasker 队列，已在连接 Controller 前单独执行
          if (isPretaskName(selectedTask.taskName)) {
            continue;
          }
          const specialTask = getMxuSpecialTask(selectedTask.taskName);
          const taskDef =
            specialTask?.taskDef ||
            projectInterface?.task.find((t) => t.name === selectedTask.taskName);
          if (!taskDef) {
            log.warn(`跳过任务 ${selectedTask.taskName}: 未找到任务定义`);
            continue;
          }
          runnableTasks.push({
            taskName: selectedTask.taskName,
            selectedTask,
            taskDef,
            specialTask,
          });
        }

        if (runnableTasks.length === 0) {
          return failStart(t('taskList.autoConnect.noRunnableTasks'));
        }

        log.info(`实例 ${targetInstance.name}: 开始执行任务, 数量: ${runnableTasks.length}`);

        const taskConfigs: TaskConfig[] = runnableTasks.map(
          ({ selectedTask, taskDef, specialTask }) => {
            const taskDisplayName =
              selectedTask.customName ||
              (specialTask && taskDef.label
                ? t(taskDef.label)
                : resolveI18nText(taskDef.label, translations)) ||
              selectedTask.taskName;
            registerEntryTaskName(taskDef.entry, taskDisplayName);

            return {
              entry: taskDef.entry,
              pipeline_override: generateTaskPipelineOverride(
                selectedTask,
                projectInterface,
                controllerName,
                resourceName,
                useAppStore.getState().globalOptionValues,
              ),
              selected_task_id: selectedTask.id,
              task_name: taskDef.name,
              options: buildTaskOptionSummary(
                selectedTask,
                taskDef.option,
                specialTask?.optionDefs ?? projectInterface?.option,
              ),
            };
          },
        );

        // 准备 Agent 配置（支持单个或多个 Agent）
        const agentConfigs = normalizeAgentConfigs(projectInterface?.agent);

        // PI v2.5.0: 构建 Agent 子进程环境变量
        const piEnvs = agentConfigs?.length
          ? buildPiEnvVars({
              projectInterface,
              controllerName,
              resourceName,
              translations,
              language,
              maaVersion,
            })
          : undefined;

        updateInstance(targetId, { isRunning: true });
        setInstanceTaskStatus(targetId, 'Running');
        setShowAddTaskPanel(false);

        // 如果是定时执行，记录状态
        if (schedulePolicyName) {
          setScheduleExecution(targetId, {
            policyName: schedulePolicyName,
            startTime: Date.now(),
          });
        }

        // 任务可能在 startTasks 返回前就瞬时结束，先启动全局回调缓存再提交。
        await startGlobalCallbackListener();

        const startedTaskIds = await maaService.startTasks(
          targetId,
          taskConfigs,
          agentConfigs,
          basePath,
          tcpCompatMode,
          piEnvs,
          {
            name: controllerName,
            type: controller.type,
          },
          collectPasswordPlaintextsFromRunnableTasks(
            runnableTasks,
            useAppStore.getState().globalOptionValues,
            projectInterface?.option ?? {},
          ),
        );

        startedTaskIds.forEach((maaTaskId, index) => {
          const runnable = runnableTasks[index];
          if (!runnable) {
            return;
          }
          const { selectedTask, taskDef, specialTask } = runnable;
          const taskDisplayName =
            selectedTask.customName ||
            (specialTask && taskDef.label
              ? t(taskDef.label)
              : resolveI18nText(taskDef.label, translations)) ||
            selectedTask.taskName;
          registerTaskIdName(maaTaskId, taskDisplayName);
        });

        log.info(`实例 ${targetInstance.name}: 任务已提交, task_ids:`, startedTaskIds);

        // 开始任务时折叠所有任务
        collapseAllTasks(targetId, false);

        return true;
      } catch (err) {
        log.error(`实例 ${targetInstance.name}: 任务启动异常:`, err);

        const errMsg = err instanceof Error ? err.message : String(err);
        const cancelled = errMsg === PRE_ACTION_CANCELLED_ERROR;
        if (!cancelled) {
          const localizedErrMsg = errMsg
            .replace('UINPUT_SCREEN_SIZE_REQUIRED', t('controller.uinputDimensionsRequired'))
            .replace(
              ' [[hint:spawn_file_not_found]]',
              ` ${t('taskList.autoConnect.agentSpawnHintFileNotFound')}`,
            )
            .replace(
              ' [[hint:spawn_app_control]]',
              ` ${t('taskList.autoConnect.agentSpawnHintAppControl')}`,
            );
          addLog(targetId, {
            type: 'error',
            message: `${t('taskList.autoConnect.startFailed')}: ${localizedErrMsg}`,
          });
        }

        const failedAgentConfigs = normalizeAgentConfigs(projectInterface?.agent);
        if (failedAgentConfigs && failedAgentConfigs.length > 0) {
          for (let i = 0; i < failedAgentConfigs.length; i++) {
            const agentCfg = failedAgentConfigs[i];
            const args = agentCfg.child_args?.join(' ') ?? '';
            const cmd = args ? `${agentCfg.child_exec} ${args}` : agentCfg.child_exec;
            addLog(targetId, {
              type: 'warning',
              message: t('taskList.autoConnect.agentStartParams', {
                index: i + 1,
                cmd,
                cwd: basePath,
              }),
            });
          }
          try {
            await maaService.stopAgent(targetId);
          } catch {
            // 忽略停止 agent 的错误
          }
        }

        updateInstance(targetId, { isRunning: false });
        setInstanceTaskStatus(targetId, cancelled ? null : 'Failed');
        setInstanceCurrentTaskId(targetId, null);
        clearScheduleExecution(targetId);
        if (cancelled) {
          lastStartCancelledRef.current = true;
          setIsStopping(false);
        }

        return false;
      }
    },
    [
      projectInterface,
      basePath,
      selectedController,
      selectedResource,
      instanceConnectionStatus,
      instanceResourceLoaded,
      setInstanceConnectionStatus,
      setInstanceResourceLoaded,
      updateInstance,
      setInstanceTaskStatus,
      setInstanceCurrentTaskId,
      setScheduleExecution,
      clearScheduleExecution,
      setShowAddTaskPanel,
      addLog,
      t,
      beginPreActionControl,
      endPreActionControl,
      throwIfPreActionStopped,
      waitWithStopCheck,
    ],
  );

  // 调度服务：使用 ref 保持回调始终指向最新闭包
  const scheduleTriggerRef = useRef<typeof startTasksForInstance>(startTasksForInstance);
  scheduleTriggerRef.current = startTasksForInstance;

  useEffect(() => {
    taskStartService.setHandler((instance, options) => startTasksForInstance(instance, options));
    return () => taskStartService.setHandler(null);
  }, [startTasksForInstance]);

  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!isTauri()) return;

    scheduleService.setTriggerCallback(async (inst, policyName, slotLabel) => {
      const currentT = tRef.current;
      const currentAddLog = addLogRef.current;

      currentAddLog(inst.id, {
        type: 'info',
        message: currentT('logs.messages.scheduleStarting', {
          policy: policyName,
          time: slotLabel,
        }),
      });

      const started = await scheduleTriggerRef.current(inst, {
        schedulePolicyName: policyName,
      });

      if (started) {
        log.info(`定时任务启动成功: 实例 "${inst.name}"`);
      } else {
        log.warn(`定时任务启动失败或跳过: 实例 "${inst.name}"`);
      }

      return started;
    });

    scheduleService.start();

    return () => {
      scheduleService.stop();
      scheduleService.setTriggerCallback(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 检查当前控制器是否需要管理员权限
   * @returns 如果需要权限且当前不是管理员返回 true
   */
  const checkPermissionRequired = async (): Promise<boolean> => {
    // 检查当前控制器是否设置了 permission_required
    if (!currentController?.permission_required) {
      return false;
    }

    // 检查当前进程是否已经是管理员
    const isElevated = await maaService.isElevated();
    if (isElevated) {
      log.info('当前已是管理员权限');
      return false;
    }

    log.info('控制器需要管理员权限，但当前不是管理员');
    return true;
  };

  /**
   * 处理以管理员身份重启
   */
  const handleRestartAsAdmin = async () => {
    setIsRestartingAsAdmin(true);
    try {
      await maaService.restartAsAdmin();
      // 成功的话进程会退出，不会执行到这里
    } catch (err) {
      log.error('以管理员身份重启失败:', err);
      setIsRestartingAsAdmin(false);
    }
  };

  /**
   * 停止任务的统一流程：复用公共 stop helper，保持各入口行为一致
   * handleStartStop 和 handleStopTasks 共用此逻辑以保持行为一致。
   */
  const performStop = async (targetInstanceId: string): Promise<boolean> => {
    if (isStopping) return false;
    setIsStopping(true);
    let keepStoppingForPreAction = false;
    try {
      if (preActionControlledInstanceIdRef.current === targetInstanceId) {
        preActionStopRequestedRef.current = true;
        try {
          await maaService.setPreActionStop(targetInstanceId, true);
          keepStoppingForPreAction = true;
        } catch (err) {
          preActionStopRequestedRef.current = false;
          log.error('发送前置程序停止请求失败:', err);
          throw err;
        }
        // 前置程序仅收到停止请求，尚未完成整个任务的停止。
        return false;
      }
      const stopped = await stopInstanceTasks(targetInstanceId);
      if (!stopped) {
        log.warn('等待任务停止超时，保留运行状态以避免 UI 与实际不一致');
      }
      return stopped;
    } finally {
      if (!keepStoppingForPreAction) {
        setIsStopping(false);
      }
    }
  };

  const handleStartStop = async () => {
    if (!instance) return;

    if (isStartStopRunning) {
      // 停止任务
      try {
        await performStop(instance.id);
      } catch (err) {
        log.error('停止任务失败:', err);
      }
    } else {
      // 启动任务
      if (!canRun) {
        log.warn('无法运行任务：没有启用的任务');
        return;
      }

      // isStarting 是 state，disabled 要等重新渲染才生效，挡不住同一 tick 内的连点
      if (startingRef.current) return;
      startingRef.current = true;

      try {
        // 检查是否需要管理员权限
        const needsElevation = await checkPermissionRequired();
        if (needsElevation) {
          setShowPermissionModal(true);
          return;
        }

        setIsStarting(true);
        setAutoConnectError(null);

        try {
          // 调用统一入口启动任务，传入进度回调以更新 UI 状态
          const success = await startTasksForInstance(instance, {
            onPhaseChange: setAutoConnectPhase,
          });

          if (!success && !lastStartCancelledRef.current) {
            throw new Error(t('taskList.autoConnect.startFailed'));
          }
        } catch (err) {
          log.error('任务启动异常:', err);
          setAutoConnectError(err instanceof Error ? err.message : String(err));
          setAutoConnectPhase('idle');
        } finally {
          setIsStarting(false);
        }
      } catch (err) {
        log.error('启动前检查异常:', err);
      } finally {
        startingRef.current = false;
      }
    }
  };

  const hotkeyStartingRef = useRef(false);

  // 监听来自 App 的全局快捷键事件：F10 开始任务，F11 结束任务
  useEffect(() => {
    const handleStartTasks = async (evt: Event) => {
      const detail = (evt as CustomEvent | undefined)?.detail as
        | { source?: string; combo?: string; onSettled?: (started: boolean) => void }
        | undefined;
      const isHotkey = detail?.source === 'hotkey' || detail?.source === 'global-hotkey';
      let settled = false;
      const notifySettled = (started: boolean) => {
        if (settled) return;
        settled = true;
        detail?.onSettled?.(started);
      };

      if (hotkeyStartingRef.current) {
        notifySettled(false);
        return;
      }
      const currentInstance = useAppStore.getState().getActiveInstance();
      if (!currentInstance) {
        notifySettled(false);
        return;
      }

      const combo = detail?.combo || '';
      if (isHotkey) {
        addLog(currentInstance.id, {
          type: 'info',
          message: t('logs.messages.hotkeyDetected', {
            combo,
            action: t('logs.messages.hotkeyActionStart'),
          }),
        });
      }

      // 直接使用从 store 获取的最新 instance，避免闭包捕获旧的 selectedTasks
      hotkeyStartingRef.current = true;
      try {
        const success = await startTasksForInstance(currentInstance, {
          onPhaseChange: setAutoConnectPhase,
        });
        if (isHotkey && success) {
          addLog(currentInstance.id, {
            type: 'success',
            message: t('logs.messages.hotkeyStartSuccess'),
          });
        }
        notifySettled(success);
      } finally {
        hotkeyStartingRef.current = false;
        notifySettled(false);
      }
    };

    const handleStopTasks = async (evt: Event) => {
      const storeState = useAppStore.getState();
      const runningInstance =
        storeState.instances.find((i) => i.isRunning) ||
        (preActionControlledInstanceIdRef.current
          ? storeState.instances.find((i) => i.id === preActionControlledInstanceIdRef.current)
          : undefined);
      if (!runningInstance) return;
      if (isStopping) return;

      const detail = (evt as CustomEvent | undefined)?.detail as
        | { source?: string; combo?: string }
        | undefined;
      const combo = detail?.combo || '';
      addLog(runningInstance.id, {
        type: 'info',
        message: t('logs.messages.hotkeyDetected', {
          combo,
          action: t('logs.messages.hotkeyActionStop'),
        }),
      });

      try {
        const stopped = await performStop(runningInstance.id);

        if (stopped) {
          addLog(runningInstance.id, {
            type: 'success',
            message: t('logs.messages.hotkeyStopSuccess'),
          });
        } else {
          addLog(runningInstance.id, {
            type: 'warning',
            message: t('logs.messages.hotkeyStopPending'),
          });
        }
      } catch (err) {
        log.error('停止任务失败:', err);
        addLog(runningInstance.id, {
          type: 'error',
          message: t('logs.messages.hotkeyStopFailed'),
        });
      }
    };

    document.addEventListener('mxu-start-tasks', handleStartTasks);
    document.addEventListener('mxu-stop-tasks', handleStopTasks);

    return () => {
      document.removeEventListener('mxu-start-tasks', handleStartTasks);
      document.removeEventListener('mxu-stop-tasks', handleStopTasks);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.id, instance?.isRunning, isStopping]);

  // canRun 只检查是否有启用的任务；运行中时按钮用于停止，不应禁用
  const isDisabled = (tasks.length === 0 || !canRun) && !isStartStopRunning;

  // 获取启动按钮的文本
  const getStartButtonText = () => {
    if (isStarting) {
      switch (autoConnectPhase) {
        case 'searching':
          return t('taskList.autoConnect.searching');
        case 'connecting':
          return t('taskList.autoConnect.connecting');
        case 'loading_resource':
          return t('taskList.autoConnect.loadingResource');
        default:
          return t('taskList.startingTasks');
      }
    }
    return t('taskList.startTasks');
  };

  // 获取按钮的 title 提示
  const getButtonTitle = () => {
    if (autoConnectError) {
      return autoConnectError;
    }
    return undefined;
  };

  return (
    <div
      className={clsx(
        'flex items-center justify-between px-3 py-2 bg-bg-secondary border-t border-border',
        className,
      )}
    >
      {/* 左侧工具按钮 */}
      <div className="flex items-center gap-1">
        {/* 全选/取消全选 */}
        <button
          onClick={handleSelectAll}
          disabled={tasks.length === 0}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            tasks.length === 0
              ? 'text-text-muted cursor-not-allowed'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          title={allEnabled ? t('taskList.deselectAll') : t('taskList.selectAll')}
        >
          {allEnabled ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          <span className="hidden sm:inline">
            {allEnabled ? t('taskList.deselectAll') : t('taskList.selectAll')}
          </span>
        </button>

        {/* 展开/折叠 */}
        <button
          onClick={handleCollapseAll}
          disabled={tasks.length === 0}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            tasks.length === 0
              ? 'text-text-muted cursor-not-allowed'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          title={anyExpanded ? t('taskList.collapseAll') : t('taskList.expandAll')}
        >
          {anyExpanded ? (
            <ChevronsDownUp className="w-4 h-4" />
          ) : (
            <ChevronsUpDown className="w-4 h-4" />
          )}
          <span className="hidden sm:inline">
            {anyExpanded ? t('taskList.collapseAll') : t('taskList.expandAll')}
          </span>
        </button>

        {/* 添加任务 */}
        <button
          id="add-task-button"
          onClick={onToggleAddPanel}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            showAddPanel
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          title={t('taskList.addTask')}
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{t('taskList.addTask')}</span>
        </button>
      </div>

      {/* 右侧执行按钮组 */}
      <div className="flex items-center gap-2 relative">
        {/* 定时执行按钮和状态气泡 */}
        <ScheduleButton
          enabledCount={instance?.schedulePolicies?.filter((p) => p.enabled).length || 0}
          scheduleExecution={instance ? scheduleExecutions[instance.id] : null}
          showPanel={showSchedulePanel}
          onToggle={() => setShowSchedulePanel(!showSchedulePanel)}
        />

        {/* 定时执行面板 */}
        {showSchedulePanel && instance && (
          <SchedulePanel instanceId={instance.id} onClose={() => setShowSchedulePanel(false)} />
        )}

        {/* 权限提示弹窗 */}
        <PermissionModal
          isOpen={showPermissionModal}
          isRestarting={isRestartingAsAdmin}
          onCancel={() => setShowPermissionModal(false)}
          onRestart={handleRestartAsAdmin}
        />

        {/* 开始/停止按钮 */}
        <button
          data-role="start-stop-button"
          onClick={handleStartStop}
          disabled={isDisabled || isStopping || (isStarting && !isStartStopRunning)}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            isStopping
              ? 'bg-warning text-white'
              : isStartStopRunning
                ? 'bg-error hover:bg-error/90 text-white'
                : isStarting
                  ? 'bg-success text-white'
                  : isDisabled
                    ? 'bg-bg-active text-text-tertiary cursor-not-allowed'
                    : 'bg-accent hover:bg-accent-hover text-white',
          )}
          title={getButtonTitle()}
        >
          {isStopping ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('taskList.stoppingTasks')}</span>
            </>
          ) : isStartStopRunning ? (
            <>
              <StopCircle className="w-4 h-4" />
              <span>{t('taskList.stopTasks')}</span>
            </>
          ) : isStarting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{getStartButtonText()}</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              <span>{t('taskList.startTasks')}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
