import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutGrid,
  Monitor,
  Play,
  Pause,
  RefreshCw,
  Download,
  Unplug,
  Maximize2,
  Copy,
  X,
  Wifi,
  WifiOff,
  CheckCircle,
  Loader2,
  StopCircle,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { buildTaskOptionSummary } from '@/services/telemetryService';
import { collectPasswordPlaintextsFromRunnableTasks } from '@/utils/passwordOptionValues';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { FrameRateSelector, getFrameInterval } from './FrameRateSelector';
import { resolveI18nText } from '@/services/contentResolver';
import { loggers, generateTaskPipelineOverride } from '@/utils';
import type { TaskConfig } from '@/types/maa';
import { normalizeAgentConfigs } from '@/types/interface';
import type { PretaskItem } from '@/types/interface';
import { getLinuxDeviceName } from '@/utils/controller';
import { getInterfaceLangKey } from '@/i18n';
import { getMxuSpecialTask } from '@/types/specialTasks';
import { isTaskCompatible } from '@/stores/helpers';
import { isPretaskName, getPretaskItem, buildPretaskArgs, buildPretaskDef } from '@/types/pretasks';
import { getWeekdayOf, filterTasksForRun, createTaskRunSelection } from '@/utils/taskRunFilter';
import { resolveTaskLabel } from '@/utils/taskLabel';
import { useCurrentWeekday } from '@/hooks/useCurrentWeekday';
import { startGlobalCallbackListener } from '@/components/connection/callbackCache';
import { stopInstanceTasks } from '@/services/taskStopService';
import { buildPiEnvVars } from '@/utils/piEnv';
import {
  formatCheckboxCountViolation,
  validateInstanceCheckboxCounts,
} from '@/utils/checkboxOptionValidation';

const log = loggers.ui;

interface InstanceCardProps {
  instanceId: string;
  instanceName: string;
  isActive: boolean;
  onSelect: () => void;
}

function InstanceCard({ instanceId, instanceName, isActive, onSelect }: InstanceCardProps) {
  const { t } = useTranslation();
  const {
    instances,
    instanceConnectionStatus,
    instanceTaskStatus,
    instanceScreenshotStreaming,
    setInstanceScreenshotStreaming,
    setInstanceConnectionStatus,
    projectInterface,
    selectedController,
    selectedResource,
    interfaceTranslations,
    language,
    instanceTaskRunStatus,
    instanceResourceLoaded,
    resolveI18nText: storeResolveI18nText,
    // 任务控制相关
    updateInstance,
    setInstanceTaskStatus,
    setTaskRunSelection,
    setInstanceCurrentTaskId,
    clearScheduleExecution,
    basePath,
    registerTaskIdName,
    registerEntryTaskName,
    screenshotFrameRate,
    setShowAddTaskPanel,
    addLog,
    tcpCompatMode,
    maaVersion,
  } = useAppStore();

  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const streamingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const frameIntervalRef = useRef(getFrameInterval(screenshotFrameRate));

  // 帧率配置变化时更新帧间隔
  useEffect(() => {
    frameIntervalRef.current = getFrameInterval(screenshotFrameRate);
  }, [screenshotFrameRate]);

  const connectionStatus = instanceConnectionStatus[instanceId];
  const taskStatus = instanceTaskStatus[instanceId];
  const isStreaming = instanceScreenshotStreaming[instanceId] ?? false;
  const isConnected = connectionStatus === 'Connected';
  const isResourceLoaded = instanceResourceLoaded[instanceId] || false;

  // 获取当前实例
  const instance = instances.find((i) => i.id === instanceId);
  const isRunning = instance?.isRunning || false;
  const tasks = instance?.selectedTasks || [];
  // 周计划：只有已勾选、且今天未被周计划跳过的任务参与运行。
  // 本视图的启动流程是独立实现（不走 Toolbar.startTasksForInstance），
  // 因此这里必须自行过滤，否则周计划在 Dashboard 视图下会失效。
  const todayWeekday = useCurrentWeekday();
  const runPreview = filterTasksForRun(tasks, todayWeekday);
  const canRun = isConnected && isResourceLoaded && runPreview.tasks.length > 0;

  // 获取当前控制器和资源名（用于 pipeline override 生成）
  const currentControllerName =
    selectedController[instanceId] || projectInterface?.controller[0]?.name;
  const currentResourceName = selectedResource[instanceId] || projectInterface?.resource[0]?.name;

  // 获取连接状态信息
  const getStatusInfo = useCallback(() => {
    const controllers = projectInterface?.controller || [];
    const resources = projectInterface?.resource || [];
    const currentControllerName = selectedController[instanceId] || controllers[0]?.name;
    const currentResourceName = selectedResource[instanceId] || resources[0]?.name;
    const currentController = controllers.find((c) => c.name === currentControllerName);
    const currentResource = resources.find((r) => r.name === currentResourceName);

    // 获取设备名称
    const savedDevice = instance?.savedDevice;
    let deviceName = '';
    if (savedDevice?.adbDeviceName) {
      deviceName = savedDevice.adbDeviceName;
    } else if (savedDevice?.windowName) {
      deviceName = savedDevice.windowName;
    } else if (currentController?.type === 'Linux' && savedDevice) {
      // Linux：按当前配置输出实际使用的设备（portal/uinput 等忽略残留的 gamescope-<n>）
      deviceName = getLinuxDeviceName(
        currentController,
        {
          wlrSocketPath: savedDevice.wlrSocketPath,
          gamescopeDisplayNo: savedDevice.gamescopeDisplayNo,
        },
        { portal: t('controller.portal'), linux: t('controller.linux') },
      );
    } else if (savedDevice?.wlrSocketPath) {
      deviceName = savedDevice.wlrSocketPath;
    } else if (savedDevice?.playcoverAddress) {
      deviceName = savedDevice.playcoverAddress;
    }

    const controllerLabel = currentController
      ? resolveI18nText(currentController.label, translations) || currentController.name
      : '';
    const resourceLabel = currentResource
      ? resolveI18nText(currentResource.label, translations) || currentResource.name
      : '';

    return { controllerLabel, resourceLabel, deviceName };
  }, [projectInterface, selectedController, selectedResource, instance, instanceId, translations]);

  const statusInfo = getStatusInfo();

  // 获取当前正在运行的任务名称
  const getRunningTaskName = useCallback(() => {
    if (!instance?.isRunning) return null;

    const taskRunStatus = instanceTaskRunStatus[instanceId];
    if (!taskRunStatus) return null;

    // 找到状态为 running 的任务
    const runningTaskId = Object.entries(taskRunStatus).find(
      ([, status]) => status === 'running',
    )?.[0];

    if (!runningTaskId) return null;

    // 找到对应的 selectedTask
    const selectedTask = instance.selectedTasks.find((t) => t.id === runningTaskId);
    if (!selectedTask) return null;

    // 如果有自定义名称，使用自定义名称
    if (selectedTask.customName) return selectedTask.customName;

    // 否则从 projectInterface 获取任务的显示名称
    const taskDef = projectInterface?.task.find((t) => t.name === selectedTask.taskName);
    if (taskDef) {
      return storeResolveI18nText(taskDef.label, langKey) || taskDef.name;
    }

    return selectedTask.taskName;
  }, [
    instance,
    instanceId,
    instanceTaskRunStatus,
    projectInterface,
    storeResolveI18nText,
    langKey,
  ]);

  const runningTaskName = getRunningTaskName();

  // 启动/停止任务
  const handleStartStop = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      if (!instance) return;

      if (isRunning) {
        // 停止任务
        try {
          log.info(`[${instanceName}] 停止任务...`);
          setIsStopping(true);
          const stopped = await stopInstanceTasks(instanceId);
          if (!stopped) {
            log.warn(`[${instanceName}] 等待任务停止超时，保留当前运行状态`);
          }
        } catch (err) {
          log.error(`[${instanceName}] 停止任务失败:`, err);
        } finally {
          setIsStopping(false);
        }
      } else {
        // 启动任务
        if (!isConnected || !isResourceLoaded) return;

        // 以点击启动时刻和最新任务列表构建快照，运行中跨天不再改变本批任务。
        const runWeekday = getWeekdayOf();
        const runTasks =
          useAppStore.getState().instances.find((item) => item.id === instanceId)?.selectedTasks ||
          [];
        const runSelection = filterTasksForRun(runTasks, runWeekday);
        const enabledTasks = runSelection.tasks;
        setTaskRunSelection(instanceId, createTaskRunSelection(runSelection, runWeekday));

        // 周计划：记录本次被跳过的任务，避免"任务莫名没跑"
        runSelection.skippedByWeeklySchedule.forEach((task) => {
          addLog(instanceId, {
            type: 'info',
            message: t('taskList.taskSkippedByWeeklySchedule', {
              taskName: resolveTaskLabel(task, projectInterface, translations, t),
            }),
          });
        });

        if (enabledTasks.length === 0) return;

        setIsStarting(true);

        try {
          const compatibleEnabledTasks = enabledTasks.filter((task) => {
            const specialTask = getMxuSpecialTask(task.taskName);
            const pretask = isPretaskName(task.taskName)
              ? getPretaskItem(projectInterface, task.taskName)
              : undefined;
            const taskDef =
              specialTask?.taskDef ||
              (pretask ? buildPretaskDef(pretask) : undefined) ||
              projectInterface?.task.find((item) => item.name === task.taskName);
            return isTaskCompatible(taskDef, currentControllerName, currentResourceName);
          });
          const checkboxViolations = validateInstanceCheckboxCounts(
            compatibleEnabledTasks,
            projectInterface,
            currentControllerName,
            currentResourceName,
            useAppStore.getState().globalOptionValues,
          );
          if (checkboxViolations.length > 0) {
            for (const violation of checkboxViolations) {
              const message = formatCheckboxCountViolation(
                violation,
                compatibleEnabledTasks,
                projectInterface,
                translations,
                t,
              );
              log.warn(`[${instanceName}] ${message}`);
              addLog(instanceId, { type: 'error', message });
            }
            setIsStarting(false);
            return;
          }

          // v2.7.0: 连接 Controller 前执行 pretask（如游戏设置）
          // pretask 以伪任务形式存在于任务列表中，此处从已启用任务中筛出。
          const enabledPretasks = enabledTasks
            .filter((task) => isPretaskName(task.taskName))
            .map((task) => ({ task, item: getPretaskItem(projectInterface, task.taskName) }))
            .filter((p): p is { task: (typeof enabledTasks)[0]; item: PretaskItem } => !!p.item)
            .filter(({ item }) =>
              isTaskCompatible(buildPretaskDef(item), currentControllerName, currentResourceName),
            );
          for (const { task, item } of enabledPretasks) {
            const args = buildPretaskArgs(
              item,
              task.optionValues ?? {},
              projectInterface,
              currentControllerName,
              currentResourceName,
            );
            log.info(`[${instanceName}] 执行预任务:`, item.exec, args);
            try {
              const exitCode = await maaService.runPretask(instanceId, item.exec, args, basePath);
              if (exitCode !== 0) {
                log.warn(`[${instanceName}] 预任务退出码非零: ${exitCode}`);
              }
            } catch (err) {
              log.error(`[${instanceName}] 预任务执行失败:`, err);
            }
          }

          const runnableTasks = enabledTasks
            .map((selectedTask) => {
              // pretask 不进入 Tasker 队列，已在连接 Controller 前单独执行
              if (isPretaskName(selectedTask.taskName)) return null;
              const specialTask = getMxuSpecialTask(selectedTask.taskName);
              const taskDef =
                specialTask?.taskDef ||
                projectInterface?.task.find((t) => t.name === selectedTask.taskName);
              if (!taskDef) return null;
              return {
                taskName: selectedTask.taskName,
                selectedTask,
                taskDef,
                specialTask,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

          log.info(`[${instanceName}] 开始执行任务, 数量: ${runnableTasks.length}`);

          if (runnableTasks.length === 0) {
            log.warn(`[${instanceName}] 没有可执行的任务`);
            setIsStarting(false);
            return;
          }

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
                  currentControllerName,
                  currentResourceName,
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
                controllerName: currentControllerName,
                resourceName: currentResourceName,
                translations,
                language,
                maaVersion,
              })
            : undefined;

          updateInstance(instanceId, { isRunning: true });
          setInstanceTaskStatus(instanceId, 'Running');
          setShowAddTaskPanel(false);

          // 任务可能在 startTasks 返回前就瞬时结束，先启动全局回调缓存再提交。
          await startGlobalCallbackListener();

          const startedTaskIds = await maaService.startTasks(
            instanceId,
            taskConfigs,
            agentConfigs,
            basePath,
            tcpCompatMode,
            piEnvs,
            {
              name: currentControllerName,
              type: projectInterface?.controller.find((c) => c.name === currentControllerName)
                ?.type,
            },
            collectPasswordPlaintextsFromRunnableTasks(
              runnableTasks,
              useAppStore.getState().globalOptionValues,
              projectInterface?.option ?? {},
            ),
          );

          startedTaskIds.forEach((maaTaskId, index) => {
            const runnable = runnableTasks[index];
            if (!runnable) return;
            const { selectedTask, taskDef, specialTask } = runnable;
            const taskDisplayName =
              selectedTask.customName ||
              (specialTask && taskDef.label
                ? t(taskDef.label)
                : resolveI18nText(taskDef.label, translations)) ||
              selectedTask.taskName;
            registerTaskIdName(maaTaskId, taskDisplayName);
          });

          log.info(`[${instanceName}] 任务已提交, task_ids:`, startedTaskIds);

          setIsStarting(false);
        } catch (err) {
          log.error(`[${instanceName}] 任务启动异常:`, err);
          const failedAgentConfigs = normalizeAgentConfigs(projectInterface?.agent);
          if (failedAgentConfigs && failedAgentConfigs.length > 0) {
            try {
              await maaService.stopAgent(instanceId);
            } catch {
              // 忽略
            }
          }
          updateInstance(instanceId, { isRunning: false });
          setInstanceTaskStatus(instanceId, 'Failed');
          setInstanceCurrentTaskId(instanceId, null);
          clearScheduleExecution(instanceId);
          setIsStarting(false);
        }
      }
    },
    [
      instance,
      instanceId,
      instanceName,
      isRunning,
      isConnected,
      isResourceLoaded,
      projectInterface,
      basePath,
      updateInstance,
      setInstanceTaskStatus,
      setTaskRunSelection,
      setInstanceCurrentTaskId,
      clearScheduleExecution,
      registerTaskIdName,
      registerEntryTaskName,
      setShowAddTaskPanel,
      addLog,
      translations,
      tcpCompatMode,
    ],
  );

  // 获取最新缓存截图（后端截图循环负责更新缓存，前端无需主动触发 postScreencap）
  const captureFrame = useCallback(async (): Promise<string | null> => {
    if (!instanceId) return null;

    try {
      const imageData = await maaService.getCachedImage(instanceId);
      return imageData || null;
    } catch {
      return null;
    }
  }, [instanceId]);

  const loopRunningRef = useRef(false);

  const streamLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;

    try {
      let nextFrameTime = Date.now();

      while (streamingRef.current) {
        const now = Date.now();
        const sleepTime = nextFrameTime - now;
        if (sleepTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepTime));
        }

        const frameInterval = frameIntervalRef.current;
        if (frameInterval > 0) {
          nextFrameTime += frameInterval;
          if (nextFrameTime < Date.now()) {
            nextFrameTime = Date.now() + frameInterval;
          }
        } else {
          nextFrameTime = Date.now();
        }

        lastFrameTimeRef.current = Date.now();

        try {
          const imageData = await captureFrame();
          if (imageData && streamingRef.current) {
            setScreenshotUrl(imageData);
          }
        } catch {
          // 静默处理
        }
      }
    } finally {
      loopRunningRef.current = false;
    }
  }, [instanceId, captureFrame]);

  // 组件卸载时停止流
  useEffect(() => {
    return () => {
      streamingRef.current = false;
    };
  }, []);

  // 订阅/退订后端截图循环（确保全局只有一份 post_screencap 在运行）
  useEffect(() => {
    if (!instanceId || !isStreaming) return;

    const intervalMs = getFrameInterval(screenshotFrameRate);
    maaService
      .screenshotSubscribe(instanceId, `dashboard-${instanceId}`, intervalMs)
      .catch(() => {});

    return () => {
      maaService.screenshotUnsubscribe(instanceId, `dashboard-${instanceId}`).catch(() => {});
    };
  }, [instanceId, isStreaming, screenshotFrameRate]);

  // 响应 store 中 isStreaming 状态变化
  useEffect(() => {
    // 同步 ref 与 store 状态
    streamingRef.current = isStreaming;

    // 如果状态变为开启且已连接，启动流
    if (isStreaming && isConnected) {
      streamLoop();
    }
  }, [isStreaming, isConnected, streamLoop]);

  // 连接后自动开始截图流
  const prevConnectedRef = useRef(false);
  const hasAutoStartedRef = useRef(false);

  // 组件挂载或状态恢复后，如果已连接，自动启动截图流
  useEffect(() => {
    // 避免重复启动
    if (hasAutoStartedRef.current) return;

    if (isConnected && !isStreaming) {
      hasAutoStartedRef.current = true;
      streamingRef.current = true;
      setInstanceScreenshotStreaming(instanceId, true);
      streamLoop();
    }
  }, [isConnected, isStreaming, instanceId, setInstanceScreenshotStreaming, streamLoop]);

  // 连接状态变化时的处理（从未连接变为已连接时重新启动）
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;

    // 从未连接变为已连接时，重置自动启动标记并启动
    if (isConnected && !wasConnected && !isStreaming) {
      hasAutoStartedRef.current = true;
      streamingRef.current = true;
      setInstanceScreenshotStreaming(instanceId, true);
      streamLoop();
    }
  }, [isConnected, isStreaming, instanceId, setInstanceScreenshotStreaming, streamLoop]);

  // 全屏模式切换
  const toggleFullscreen = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      setIsFullscreen(!isFullscreen);
    },
    [isFullscreen],
  );

  // ESC 键退出全屏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    if (isFullscreen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  // 保存截图
  const saveScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;
    try {
      const link = document.createElement('a');
      link.href = screenshotUrl;
      link.download = `screenshot_${instanceName}_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch {
      // 静默处理
    }
  }, [screenshotUrl, instanceName]);

  // 复制截图到剪贴板
  const copyScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;
    try {
      const response = await fetch(screenshotUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      log.warn('复制截图失败:', err);
    }
  }, [screenshotUrl]);

  // 断开连接
  const disconnect = useCallback(async () => {
    try {
      await maaService.destroyInstance(instanceId);
      setInstanceConnectionStatus(instanceId, 'Disconnected');
      useAppStore.getState().setInstanceResourceLoaded(instanceId, false);
      setScreenshotUrl(null);
      streamingRef.current = false;
      setInstanceScreenshotStreaming(instanceId, false);
    } catch {
      // 静默处理
    }
  }, [instanceId, setInstanceConnectionStatus, setInstanceScreenshotStreaming]);

  // 强制刷新
  const forceRefresh = useCallback(async () => {
    const imageData = await captureFrame();
    if (imageData) {
      setScreenshotUrl(imageData);
    }
  }, [captureFrame]);

  // 右键菜单（复用首页截图面板的菜单结构）
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const menuItems: MenuItem[] = [
        {
          id: 'stream',
          label: isStreaming ? t('contextMenu.stopStream') : t('contextMenu.startStream'),
          icon: isStreaming ? Pause : Play,
          disabled: !isConnected,
          onClick: () => {
            if (!instanceId || !isConnected) return;
            if (isStreaming) {
              streamingRef.current = false;
              setInstanceScreenshotStreaming(instanceId, false);
            } else {
              streamingRef.current = true;
              setInstanceScreenshotStreaming(instanceId, true);
              streamLoop();
            }
          },
        },
        {
          id: 'refresh',
          label: t('contextMenu.forceRefresh'),
          icon: RefreshCw,
          disabled: !isConnected,
          onClick: forceRefresh,
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'fullscreen',
          label: t('contextMenu.fullscreen'),
          icon: Maximize2,
          disabled: !screenshotUrl,
          onClick: () => setIsFullscreen(true),
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'save',
          label: t('contextMenu.saveScreenshot'),
          icon: Download,
          disabled: !screenshotUrl,
          onClick: saveScreenshot,
        },
        {
          id: 'copy',
          label: t('contextMenu.copyScreenshot'),
          icon: Copy,
          disabled: !screenshotUrl,
          onClick: copyScreenshot,
        },
        { id: 'divider-3', label: '', divider: true },
        {
          id: 'disconnect',
          label: t('contextMenu.disconnect'),
          icon: Unplug,
          disabled: !isConnected,
          danger: true,
          onClick: disconnect,
        },
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      instanceId,
      isConnected,
      isStreaming,
      screenshotUrl,
      setInstanceScreenshotStreaming,
      streamLoop,
      forceRefresh,
      saveScreenshot,
      copyScreenshot,
      disconnect,
      showMenu,
    ],
  );

  return (
    <div
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      className={clsx(
        'group relative bg-bg-secondary rounded-xl border-2 overflow-hidden cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-lg',
        isActive ? 'border-accent shadow-md' : 'border-border hover:border-accent/50',
      )}
    >
      {/* 截图区域 */}
      <div className="aspect-video bg-bg-tertiary relative overflow-hidden">
        {screenshotUrl ? (
          <>
            <img src={screenshotUrl} alt="Screenshot" className="w-full h-full object-contain" />
            {/* 流状态指示器 */}
            {isStreaming && (
              <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-success/80 rounded text-white text-xs">
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                LIVE
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-text-muted">
            <Monitor className="w-8 h-8 opacity-30 mb-1" />
            <span className="text-xs">
              {isConnected ? t('screenshot.noScreenshot') : t('screenshot.connectFirst')}
            </span>
          </div>
        )}

        {/* 任务控制按钮 */}
        {isConnected && (
          <button
            onClick={handleStartStop}
            disabled={isStarting || isStopping || (!canRun && !isRunning)}
            className={clsx(
              'absolute bottom-2 right-2 p-1.5 rounded-md transition-all',
              isStarting || isStopping
                ? 'bg-yellow-500/80 text-white'
                : isRunning
                  ? 'bg-red-500/80 hover:bg-red-600/80 text-white'
                  : canRun
                    ? 'bg-success/80 hover:bg-success text-white'
                    : 'bg-black/30 text-white/50 cursor-not-allowed',
              'opacity-0 group-hover:opacity-100',
            )}
            title={
              isStarting
                ? t('taskList.startingTasks')
                : isStopping
                  ? t('taskList.stoppingTasks')
                  : isRunning
                    ? t('taskList.stopTasks')
                    : canRun
                      ? t('taskList.startTasks')
                      : runPreview.skippedByWeeklySchedule.length > 0
                        ? t('taskList.allTasksSkippedByWeeklySchedule')
                        : t('dashboard.noEnabledTasks')
            }
          >
            {isStarting || isStopping ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : isRunning ? (
              <StopCircle className="w-3 h-3" />
            ) : (
              <Play className="w-3 h-3" />
            )}
          </button>
        )}
      </div>

      {/* 实例信息栏 */}
      <div className="px-3 py-2 border-t border-border">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：实例名称 + 控制器/设备信息 */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span
              className={clsx(
                'font-medium truncate flex-shrink-0',
                isActive ? 'text-accent' : 'text-text-primary',
              )}
            >
              {instanceName}
            </span>
            {/* 控制器/设备信息标签 */}
            {(statusInfo.controllerLabel || statusInfo.deviceName) && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-xs truncate min-w-0">
                {isConnected ? (
                  <Wifi className="w-3 h-3 text-success flex-shrink-0" />
                ) : (
                  <WifiOff className="w-3 h-3 text-text-muted flex-shrink-0" />
                )}
                <span className="truncate">
                  {statusInfo.deviceName || statusInfo.controllerLabel}
                </span>
              </div>
            )}
            {/* 资源信息标签 - 单独显示以增加间距 */}
            {statusInfo.resourceLabel && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-xs truncate min-w-0">
                <CheckCircle className="w-3 h-3 text-success flex-shrink-0" />
                <span className="truncate">{statusInfo.resourceLabel}</span>
              </div>
            )}
          </div>

          {/* 右侧：状态按钮（类似"开始任务"按钮样式） */}
          <div
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex-shrink-0',
              isRunning || taskStatus === 'Running'
                ? 'bg-success text-white'
                : taskStatus === 'Failed'
                  ? 'bg-error text-white'
                  : taskStatus === 'Succeeded'
                    ? 'bg-accent text-white'
                    : isConnected
                      ? 'bg-bg-tertiary text-text-secondary'
                      : 'bg-bg-active text-text-tertiary',
            )}
          >
            {isRunning || taskStatus === 'Running' ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="truncate max-w-[80px]">
                  {runningTaskName || t('dashboard.running')}
                </span>
              </>
            ) : taskStatus === 'Failed' ? (
              <>
                <StopCircle className="w-3 h-3" />
                <span>{t('dashboard.failed')}</span>
              </>
            ) : taskStatus === 'Succeeded' ? (
              <>
                <CheckCircle className="w-3 h-3" />
                <span>{t('dashboard.succeeded')}</span>
              </>
            ) : isConnected ? (
              <>
                <Play className="w-3 h-3" />
                <span>{t('controller.connected')}</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3" />
                <span>{t('controller.disconnected')}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 运行中动画边框 */}
      {taskStatus === 'Running' && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-0 rounded-xl border-2 border-green-500/50 animate-pulse" />
        </div>
      )}

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 全屏模态框 */}
      {isFullscreen && screenshotUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-8"
          onClick={toggleFullscreen}
        >
          {/* 卡片容器 */}
          <div
            className="mxu-overlay-surface relative bg-bg-secondary rounded-xl border border-border shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={handleContextMenu}
          >
            {/* 卡片标题栏 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary/50">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">{instanceName}</span>
                {/* 流模式指示器 */}
                {isStreaming && (
                  <div className="flex items-center gap-1 px-2 py-0.5 bg-success/90 rounded text-white text-xs ml-2">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    LIVE
                  </div>
                )}
              </div>
              <button
                onClick={toggleFullscreen}
                className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                title={t('screenshot.exitFullscreen')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 图片内容区 */}
            <div className="p-4 bg-bg-primary flex items-center justify-center overflow-auto">
              <img
                src={screenshotUrl}
                alt="Screenshot"
                className="max-w-full max-h-[calc(90vh-80px)] object-contain rounded-md"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface DashboardViewProps {
  onClose?: () => void;
}

export function DashboardView({ onClose }: DashboardViewProps) {
  const { t } = useTranslation();
  const { instances, activeInstanceId, setActiveInstance, toggleDashboardView } = useAppStore();

  // 实例网格对齐方式：left / center / right
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('center');
  // 实例网格缩放
  const [zoom, setZoom] = useState(1);

  const handleZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.min(1.5, Math.max(0.6, prev + delta));
      return Math.round(next * 100) / 100;
    });
  };

  const handleClose = onClose ?? toggleDashboardView;

  const handleSelectInstance = (instanceId: string) => {
    setActiveInstance(instanceId);
    handleClose();
  };

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
      {/* 实例网格 */}
      <div className="flex-1 overflow-auto p-6">
        {instances.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-muted">
            <p>{t('dashboard.noInstances')}</p>
          </div>
        ) : (
          <div
            className={clsx(
              'w-full flex',
              align === 'left' && 'justify-start',
              align === 'center' && 'justify-center',
              align === 'right' && 'justify-end',
            )}
          >
            <div
              className={clsx(
                'grid gap-4',
                instances.length === 1
                  ? 'grid-cols-1 max-w-2xl'
                  : instances.length === 2
                    ? 'grid-cols-2 max-w-4xl'
                    : instances.length <= 4
                      ? 'grid-cols-2 lg:grid-cols-2 max-w-5xl'
                      : 'grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
              )}
              style={
                {
                  transform: `scale(${zoom})`,
                  transformOrigin:
                    align === 'left' ? 'top left' : align === 'right' ? 'top right' : 'top center',
                } as CSSProperties
              }
            >
              {instances.map((instance) => (
                <InstanceCard
                  key={instance.id}
                  instanceId={instance.id}
                  instanceName={instance.name}
                  isActive={instance.id === activeInstanceId}
                  onSelect={() => handleSelectInstance(instance.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-bg-secondary">
        <div className="flex items-center gap-3">
          <LayoutGrid className="w-5 h-5 text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">{t('dashboard.title')}</h1>
          <span className="px-2 py-0.5 text-xs bg-accent/10 text-accent rounded-full">
            {instances.length} {t('dashboard.instances')}
          </span>
        </div>

        {/* 中间：排列 + 缩放（放在底部中间区域） */}
        <div className="flex items-center justify-center gap-4">
          {/* 对齐方式切换 */}
          <div className="flex items-center gap-1 bg-bg-tertiary rounded-md px-1.5 py-1">
            <button
              type="button"
              onClick={() => setAlign('left')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'left' ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignLeft')}
            >
              <AlignLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setAlign('center')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'center'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignCenter')}
            >
              <AlignCenter className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setAlign('right')}
              className={clsx(
                'p-1.5 rounded-md text-xs flex items-center justify-center',
                align === 'right'
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
              title={t('dashboard.alignRight')}
            >
              <AlignRight className="w-4 h-4" />
            </button>
          </div>

          {/* 缩放调整 */}
          <div className="flex items-center gap-1 bg-bg-tertiary rounded-md px-1.5 py-1">
            <button
              type="button"
              onClick={() => handleZoom(-0.1)}
              className="p-1.5 rounded-md text-xs flex items-center justify-center text-text-secondary hover:bg-bg-hover"
              title={t('dashboard.zoomOut')}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="px-1 text-xs text-text-secondary w-10 text-center select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoom(0.1)}
              className="p-1.5 rounded-md text-xs flex items-center justify-center text-text-secondary hover:bg-bg-hover"
              title={t('dashboard.zoomIn')}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 右侧：帧率 + 退出按钮 */}
        <div className="flex items-center gap-4">
          <FrameRateSelector compact />
          <button
            onClick={handleClose}
            className="px-3 py-1.5 text-sm bg-bg-hover hover:bg-bg-active text-text-secondary rounded-lg transition-colors"
          >
            {t('dashboard.exit')}
          </button>
        </div>
      </div>
    </div>
  );
}
