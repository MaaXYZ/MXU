// MaaFramework 服务层
// 封装 Tauri 命令调用，提供前端友好的 API

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type {
  AdbDevice,
  Win32Window,
  GamescopeInstance,
  ControllerConfig,
  ConnectionStatus,
  TaskStatus,
  AgentConfig,
  TaskConfig,
  ControllerTelemetryInfo,
  InstanceRuntimeInfo,
} from '@/types/maa';
import { loggers } from '@/utils/logger';
import { redactSecretsInText } from '@/utils/passwordOptionValues';
import { isTauri } from '@/utils/paths';
import i18n from '@/i18n';
import { apiDelete, apiGet, apiPost, apiPut, getApiBase } from '@/utils/backendApi';
import * as wsService from '@/services/wsService';
import { useAppStore } from '@/stores/appStore';

const log = loggers.maa;

function localizeControllerError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MACOS_PERMISSIONS_REQUIRED')) {
    return new Error(i18n.t('controller.macosPermissionsRequired'));
  }
  if (message.includes('MACOS_UNSUPPORTED_PLATFORM')) {
    return new Error(i18n.t('controller.macosUnsupportedPlatform'));
  }
  if (message.includes('MACOS_MAAFW_VERSION_REQUIRED')) {
    return new Error(i18n.t('controller.macosVersionRequired'));
  }
  if (message.includes('MACOS_VERSION_DETECTION_FAILED')) {
    return new Error(i18n.t('controller.macosSystemVersionDetectionFailed'));
  }
  if (message.includes('MACOS_VERSION_REQUIRED')) {
    return new Error(i18n.t('controller.macosSystemVersionRequired'));
  }
  if (message.includes('LINUX_MAAFW_VERSION_REQUIRED')) {
    return new Error(i18n.t('controller.linuxVersionRequired'));
  }
  return error;
}

/**
 * 从后端获取最新缓存截图，转换为 base64 data URL（浏览器专用）
 *
 * 后端截图循环（ScreenshotService）负责驱动 post_screencap，此处仅读取缓存。
 */
async function fetchScreenshotDataUrl(instanceId: string): Promise<string> {
  const resp = await fetch(`${getApiBase()}/maa/instances/${instanceId}/screenshot`);
  if (!resp.ok) return '';
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('image/')) {
    const blob = await resp.blob();
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  }
  // fallback: JSON { dataUrl: string }
  const json = (await resp.json()) as { dataUrl?: string };
  return json.dataUrl ?? '';
}

async function syncMaaVersionToStore(version: string): Promise<void> {
  try {
    const { useAppStore } = await import('@/stores/appStore');
    useAppStore.getState().setMaaInitialized(true, version);
  } catch (err) {
    log.debug('同步 MaaFramework 版本到 store 失败:', err);
  }
}

/** MaaFramework 回调事件载荷 */
export interface MaaCallbackEvent {
  /** 消息类型，如 "Resource.Loading.Succeeded", "Controller.Action.Succeeded", "Tasker.Task.Succeeded" */
  message: string;
  /** 详细数据 JSON 字符串 */
  details: string;
}

/** 回调消息详情（通用字段） */
export interface MaaCallbackDetails {
  res_id?: number;
  ctrl_id?: number;
  task_id?: number;
  path?: string;
  type?: string;
  hash?: string;
  uuid?: string;
  action?: string;
  param?: unknown;
  entry?: string;
  name?: string;
}

export interface SelfStopRequestedEvent {
  instanceId: string;
}

/** MaaFramework 服务 */
export const maaService = {
  /**
   * 初始化 MaaFramework
   * @param libDir MaaFramework 库目录（可选，默认从 exe 目录/maafw 加载）
   * @returns 版本号
   */
  async init(libDir?: string): Promise<string> {
    log.info('初始化 MaaFramework, libDir:', libDir || '(默认)');

    if (!isTauri()) {
      // 浏览器模式：查询后端是否已初始化，直接复用 Tauri WebView 的初始化结果
      const result = await apiGet<{ initialized: boolean; version: string | null }>(
        '/maa/initialized',
      );
      const version = result.version ?? '';
      if (result.initialized) {
        await syncMaaVersionToStore(version || 'unknown');
        log.info('MaaFramework 已初始化 (HTTP)，版本:', version || '(未知)');
      } else {
        log.warn('MaaFramework 后端尚未初始化');
      }
      return version;
    }

    const version = await invoke<string>('maa_init', { libDir: libDir || null });
    await syncMaaVersionToStore(version);
    log.info('MaaFramework 版本:', version);
    return version;
  },

  /**
   * 设置资源目录
   * @param resourceDir 资源目录路径
   */
  async setResourceDir(resourceDir: string): Promise<void> {
    if (!isTauri()) return;
    log.info('设置资源目录:', resourceDir);
    await invoke('maa_set_resource_dir', { resourceDir });
    log.info('设置资源目录成功');
  },

  /**
   * 获取 MaaFramework 版本
   */
  async getVersion(): Promise<string> {
    log.debug('获取 MaaFramework 版本...');
    if (!isTauri()) {
      const result = await apiGet<{ initialized: boolean; version: string | null }>(
        '/maa/initialized',
      );
      const version = result.version ?? '';
      if (version) await syncMaaVersionToStore(version);
      return version;
    }
    const version = await invoke<string>('maa_get_version');
    await syncMaaVersionToStore(version);
    log.info('MaaFramework 版本:', version);
    return version;
  },

  /**
   * 检查 MaaFramework 版本是否满足最小要求
   */
  async checkVersion(): Promise<{ current: string; minimum: string; is_compatible: boolean }> {
    log.debug('检查 MaaFramework 版本...');
    if (!isTauri()) {
      // 浏览器模式：从已初始化信息推断版本（后端已完成版本校验）
      const result = await apiGet<{ initialized: boolean; version: string | null }>(
        '/maa/initialized',
      );
      return {
        current: result.version ?? '',
        minimum: '',
        is_compatible: result.initialized,
      };
    }
    const result = await invoke<{ current: string; minimum: string; is_compatible: boolean }>(
      'maa_check_version',
    );
    log.info('版本检查结果:', result);
    return result;
  },

  /**
   * 查找 ADB 设备
   */
  async findAdbDevices(): Promise<AdbDevice[]> {
    log.info('搜索 ADB 设备...');
    const devices = isTauri()
      ? await invoke<AdbDevice[]>('maa_find_adb_devices')
      : await apiGet<AdbDevice[]>('/maa/devices');
    log.info('找到 ADB 设备:', devices.length, '个');
    devices.forEach((device, i) => {
      log.debug(
        `  设备[${i}]: name=${device.name}, address=${device.address}, adb_path=${device.adb_path}`,
      );
    });
    return devices;
  },

  /**
   * 查找桌面窗口（Win32/macOS）
   * @param classRegex 窗口类名正则表达式（仅 Win32/Gamepad，可选）
   * @param windowRegex 窗口标题正则表达式（可选）
   */
  async findWin32Windows(classRegex?: string, windowRegex?: string): Promise<Win32Window[]> {
    try {
      log.info(
        '搜索桌面窗口, classRegex:',
        classRegex || '(无)',
        ', windowRegex:',
        windowRegex || '(无)',
      );
      let windows: Win32Window[];
      if (isTauri()) {
        windows = await invoke<Win32Window[]>('maa_find_win32_windows', {
          classRegex: classRegex || null,
          windowRegex: windowRegex || null,
        });
      } else {
        const params = new URLSearchParams();
        if (classRegex) params.set('class_regex', classRegex);
        if (windowRegex) params.set('window_regex', windowRegex);
        const query = params.toString();
        windows = await apiGet<Win32Window[]>(`/maa/windows${query ? `?${query}` : ''}`);
      }
      log.info('找到桌面窗口:', windows.length, '个');
      windows.forEach((win, i) => {
        log.debug(
          `  窗口[${i}]: handle=${win.handle}, class=${win.class_name}, name=${win.window_name}`,
        );
      });
      return windows;
    } catch (err) {
      log.error('搜索桌面窗口失败:', err);
      throw localizeControllerError(err);
    }
  },

  /**
   * 查找 WlRoots 可用的 Wayland socket
   */
  async findWlrootsSockets(): Promise<string[]> {
    log.info('搜索 WlRoots socket...');
    const sockets = isTauri()
      ? await invoke<string[]>('maa_find_wlroots_sockets')
      : await apiGet<string[]>('/maa/wlroots-sockets');
    log.info('找到 WlRoots socket:', sockets.length, '个');
    sockets.forEach((socket, i) => {
      log.debug(`  socket[${i}]: ${socket}`);
    });
    return sockets;
  },

  /**
   * 查找 gamescope 实例（同一 display 上的截图节点 + libei 输入 socket）
   */
  async findGamescopeInstances(): Promise<GamescopeInstance[]> {
    log.info('搜索 gamescope 实例...');
    const instances = isTauri()
      ? await invoke<GamescopeInstance[]>('maa_find_gamescope_instances')
      : await apiGet<GamescopeInstance[]>('/maa/gamescope-instances');
    log.info('找到 gamescope 实例:', instances.length, '个');
    instances.forEach((inst, i) => {
      log.debug(
        `  实例[${i}]: display_no=${inst.display_no}, pipewire_node_id=${inst.pipewire_node_id}, eis_socket_path=${inst.eis_socket_path}`,
      );
    });
    return instances;
  },

  /**
   * 创建实例
   * @param instanceId 实例 ID
   */
  async createInstance(instanceId: string): Promise<void> {
    log.info('创建实例:', instanceId);
    if (!isTauri()) {
      await apiPut(`/maa/instances/${instanceId}`, {});
      log.info('创建实例成功 (HTTP):', instanceId);
      return;
    }
    await invoke('maa_create_instance', { instanceId });
    log.info('创建实例成功:', instanceId);
  },

  /**
   * 销毁实例
   * @param instanceId 实例 ID
   */
  async destroyInstance(instanceId: string): Promise<void> {
    log.info('销毁实例:', instanceId);
    if (!isTauri()) {
      await apiDelete(`/maa/instances/${instanceId}`);
      log.info('销毁实例成功 (HTTP):', instanceId);
      return;
    }
    await invoke('maa_destroy_instance', { instanceId });
    log.info('销毁实例成功:', instanceId);
  },

  /**
   * 连接控制器（异步，通过回调通知完成状态）
   * @param instanceId 实例 ID
   * @param config 控制器配置
   * @returns 连接请求 ID，通过监听 maa-callback 事件获取完成状态
   */
  async connectController(instanceId: string, config: ControllerConfig): Promise<number> {
    log.info('连接控制器, 实例:', instanceId, '类型:', config.type);
    log.debug('控制器配置:', config);

    try {
      if (!isTauri()) {
        log.info('浏览器环境，调用 HTTP API 连接控制器');
        const result = await apiPost<{ connId: number }>(
          `/maa/instances/${instanceId}/connect`,
          config,
        );
        return result.connId;
      }

      const ctrlId = await invoke<number>('maa_connect_controller', {
        instanceId,
        config,
      });
      log.info('控制器连接请求已发送, ctrlId:', ctrlId);
      return ctrlId;
    } catch (err) {
      log.error('控制器连接请求失败:', err);
      throw localizeControllerError(err);
    }
  },

  /**
   * 获取连接状态
   * @param instanceId 实例 ID
   */
  async getConnectionStatus(instanceId: string): Promise<ConnectionStatus> {
    if (!isTauri()) {
      const state = await this.getInstanceState(instanceId);
      return state?.connectionStatus ?? 'Disconnected';
    }
    log.debug('获取连接状态, 实例:', instanceId);
    const status = await invoke<ConnectionStatus>('maa_get_connection_status', { instanceId });
    log.debug('连接状态:', instanceId, '->', status);
    return status;
  },

  /**
   * 加载资源（异步，通过回调通知完成状态）
   * @param instanceId 实例 ID
   * @param paths 资源路径列表
   * @returns 资源加载请求 ID 列表，通过监听 maa-callback 事件获取完成状态
   */
  async loadResource(instanceId: string, paths: string[]): Promise<number[]> {
    const { inferenceDevice } = useAppStore.getState();
    log.info(
      '加载资源, 实例:',
      instanceId,
      ', 路径数:',
      paths.length,
      ', 推理设备:',
      inferenceDevice,
    );
    paths.forEach((path, i) => {
      log.debug(`  路径[${i}]: ${path}`);
    });
    if (!isTauri()) {
      const result = await apiPost<{ resIds: number[] }>(
        `/maa/instances/${instanceId}/resource/load`,
        { paths, inferenceDevice },
      );
      const resIds = result.resIds ?? [];
      log.info('资源加载请求已发送 (HTTP), resIds:', resIds);
      return resIds;
    }
    const resIds = await invoke<number[]>('maa_load_resource', {
      instanceId,
      paths,
      inferenceDevice,
    });
    log.info('资源加载请求已发送, resIds:', resIds);
    return resIds;
  },

  /**
   * 检查资源是否已加载
   * @param instanceId 实例 ID
   */
  async isResourceLoaded(instanceId: string): Promise<boolean> {
    if (!isTauri()) {
      const state = await this.getInstanceState(instanceId);
      return state?.resourceLoaded ?? false;
    }
    log.debug('检查资源是否已加载, 实例:', instanceId);
    const loaded = await invoke<boolean>('maa_is_resource_loaded', { instanceId });
    log.debug('资源加载状态:', instanceId, '->', loaded);
    return loaded;
  },

  /**
   * 获取已加载资源的 hash（用于完整性校验）
   * @param instanceId 实例 ID
   * @returns hash 字符串；资源未加载或后端获取失败时返回 null
   */
  async getResourceHash(instanceId: string): Promise<string | null> {
    if (!isTauri()) return null;
    log.debug('获取资源 hash, 实例:', instanceId);
    const hash = await invoke<string | null>('maa_get_resource_hash', { instanceId });
    log.debug('资源 hash:', instanceId, '->', hash);
    return hash;
  },

  /**
   * 销毁资源（用于切换资源时重新创建）
   * @param instanceId 实例 ID
   */
  async destroyResource(instanceId: string): Promise<void> {
    if (!isTauri()) return;
    log.info('销毁资源, 实例:', instanceId);
    await invoke('maa_destroy_resource', { instanceId });
    log.info('销毁资源成功:', instanceId);
  },

  /**
   * 运行任务
   * @param instanceId 实例 ID
   * @param entry 任务入口
   * @param pipelineOverride Pipeline 覆盖 JSON
   * @param selectedTaskId 对应的前端任务 ID（用于后端跟踪任务状态）
   * @returns 任务 ID
   */
  async runTask(
    instanceId: string,
    entry: string,
    pipelineOverride: string = '{}',
    selectedTaskId?: string,
  ): Promise<number> {
    log.info(
      '运行任务, 实例:',
      instanceId,
      ', 入口:',
      entry,
      ', pipelineOverride:',
      pipelineOverride,
    );
    if (!isTauri()) {
      const result = await apiPost<{ taskIds: number[] }>(
        `/maa/instances/${instanceId}/tasks/run`,
        [{ entry, pipeline_override: pipelineOverride, selected_task_id: selectedTaskId }],
      );
      const taskId = result.taskIds[0] ?? 0;
      log.info('任务已提交 (HTTP), taskId:', taskId);
      return taskId;
    }
    const taskId = await invoke<number>('maa_run_task', {
      instanceId,
      entry,
      pipelineOverride,
      selectedTaskId: selectedTaskId ?? null,
    });
    log.info('任务已提交, taskId:', taskId);
    return taskId;
  },

  /**
   * 获取任务状态
   * @param instanceId 实例 ID
   * @param taskId 任务 ID
   */
  async getTaskStatus(instanceId: string, taskId: number): Promise<TaskStatus> {
    if (!isTauri()) return 'Pending';
    log.debug('获取任务状态, 实例:', instanceId, ', taskId:', taskId);
    const status = await invoke<TaskStatus>('maa_get_task_status', { instanceId, taskId });
    log.debug('任务状态:', taskId, '->', status);
    return status;
  },

  /**
   * 停止任务
   * @param instanceId 实例 ID
   */
  async stopTask(instanceId: string): Promise<void> {
    log.info('停止任务, 实例:', instanceId);
    if (!isTauri()) {
      await apiPost(`/maa/instances/${instanceId}/tasks/stop`);
      log.info('停止任务请求已发送 (HTTP)');
      return;
    }
    await invoke('maa_stop_task', { instanceId });
    log.info('停止任务请求已发送');
  },

  /**
   * 覆盖已提交任务的 Pipeline 配置（用于运行中修改尚未执行的任务选项）
   * @param instanceId 实例 ID
   * @param taskId MAA 任务 ID
   * @param pipelineOverride Pipeline 覆盖 JSON
   * @returns 是否成功
   */
  async overridePipeline(
    instanceId: string,
    taskId: number,
    pipelineOverride: string,
  ): Promise<boolean> {
    log.info(
      '覆盖 Pipeline, 实例:',
      instanceId,
      ', taskId:',
      taskId,
      ', override:',
      pipelineOverride,
    );
    const success = isTauri()
      ? await invoke<boolean>('maa_override_pipeline', {
          instanceId,
          taskId,
          pipelineOverride,
        })
      : (
          await apiPost<{ success: boolean }>(
            `/maa/instances/${instanceId}/tasks/${taskId}/pipeline`,
            {
              pipelineOverride,
            },
          )
        ).success;
    log.info('覆盖 Pipeline 结果:', success);
    return success;
  },

  /**
   * 检查是否正在运行
   * @param instanceId 实例 ID
   */
  async isRunning(instanceId: string): Promise<boolean> {
    if (!isTauri()) {
      const state = await this.getInstanceState(instanceId);
      return state?.isRunning ?? false;
    }
    const running = await invoke<boolean>('maa_is_running', { instanceId });
    return running;
  },

  /**
   * 发起点击请求
   * @param instanceId 实例 ID
   * @param x X 坐标（设备原始分辨率）
   * @param y Y 坐标（设备原始分辨率）
   * @returns 点击请求 ID
   */
  async postClick(instanceId: string, x: number, y: number): Promise<number> {
    if (!isTauri()) {
      const result = await apiPost<{ clickId: number }>(`/maa/instances/${instanceId}/click`, {
        x,
        y,
      });
      return result.clickId;
    }
    return await invoke<number>('maa_post_click', { instanceId, x, y });
  },

  /**
   * 发起截图请求（异步，通过回调通知完成状态）
   * @param instanceId 实例 ID
   * @returns 截图请求 ID（Tauri）或 0（浏览器，实际截图异步进行并写入缓存）
   */
  async postScreencap(instanceId: string): Promise<number> {
    if (!isTauri()) {
      // 浏览器模式：截图由后端 ScreenshotService 统一驱动，此处无需额外触发
      return 0;
    }
    const screencapId = await invoke<number>('maa_post_screencap', { instanceId });
    return screencapId;
  },

  /**
   * 获取缓存的截图
   * @param instanceId 实例 ID
   * @returns base64 编码的图像 data URL
   */
  async getCachedImage(instanceId: string): Promise<string> {
    if (!isTauri()) {
      // 浏览器模式：后端截图循环已在运行，直接读取最新缓存
      return fetchScreenshotDataUrl(instanceId).catch(() => '');
    }
    return await invoke<string>('maa_get_cached_image', { instanceId });
  },

  /**
   * 订阅实例的实时截图（后端统一驱动截图循环）
   *
   * 多个客户端可同时订阅同一实例，后端按最快订阅者的帧率驱动唯一截图循环。
   * 订阅后应调用 getCachedImage 获取截图，无需手动调用 postScreencap。
   *
   * @param instanceId 实例 ID
   * @param subscriberId 订阅者唯一标识（同一 ID 重复调用会更新 intervalMs）
   * @param intervalMs 期望的截图间隔（毫秒）
   */
  async screenshotSubscribe(
    instanceId: string,
    subscriberId: string,
    intervalMs: number,
  ): Promise<void> {
    if (!isTauri()) {
      await apiPost(`/maa/instances/${instanceId}/screenshot/subscribe`, {
        subscriber_id: subscriberId,
        interval_ms: intervalMs,
      });
      return;
    }
    await invoke('maa_screenshot_subscribe', { instanceId, subscriberId, intervalMs });
  },

  /**
   * 取消实例的实时截图订阅
   *
   * @param instanceId 实例 ID
   * @param subscriberId 订阅时使用的唯一标识
   */
  async screenshotUnsubscribe(instanceId: string, subscriberId: string): Promise<void> {
    if (!isTauri()) {
      await apiPost(`/maa/instances/${instanceId}/screenshot/unsubscribe`, {
        subscriber_id: subscriberId,
      });
      return;
    }
    await invoke('maa_screenshot_unsubscribe', { instanceId, subscriberId });
  },

  /**
   * 启动任务（支持 Agent）
   * @param instanceId 实例 ID
   * @param tasks 任务列表
   * @param agentConfigs Agent 配置列表（可选，支持多个 Agent）
   * @param cwd 工作目录（Agent 子进程的 CWD）
   * @param tcpCompatMode 通信兼容模式（强制使用 TCP）
   * @param piEnvs PI v2.5.0 环境变量（Agent 子进程注入）
   * @param controllerInfo 当前 controller 的名称与类型（仅用于遥测埋点）
   * @returns 任务 ID 列表
   */
  async startTasks(
    instanceId: string,
    tasks: TaskConfig[],
    agentConfigs?: AgentConfig[],
    cwd?: string,
    tcpCompatMode?: boolean,
    piEnvs?: Record<string, string>,
    controllerInfo?: ControllerTelemetryInfo,
    logRedactSecrets?: string[],
  ): Promise<number[]> {
    log.info('启动任务, 实例:', instanceId, ', 任务数:', tasks.length, ', cwd:', cwd || '.');
    tasks.forEach((task, i) => {
      const override =
        logRedactSecrets && logRedactSecrets.length > 0
          ? redactSecretsInText(task.pipeline_override, logRedactSecrets)
          : task.pipeline_override;
      log.debug(`  任务[${i}]: entry=${task.entry}, pipelineOverride=${override}`);
    });
    if (agentConfigs && agentConfigs.length > 0) {
      log.info(
        'Agent 配置:',
        JSON.stringify(agentConfigs),
        ', 数量:',
        agentConfigs.length,
        ', tcpCompatMode:',
        tcpCompatMode,
      );
    }
    if (!isTauri()) {
      const result = await apiPost<{ taskIds: number[] }>(
        `/maa/instances/${instanceId}/tasks/start`,
        {
          tasks,
          agent_configs: agentConfigs && agentConfigs.length > 0 ? agentConfigs : null,
          cwd: cwd || null,
          tcp_compat_mode: tcpCompatMode || false,
          pi_envs: agentConfigs && agentConfigs.length > 0 && piEnvs ? piEnvs : null,
          controller_info: controllerInfo ?? null,
        },
      );
      log.info('任务已提交 (HTTP), taskIds:', result.taskIds);
      return result.taskIds;
    }
    const hasAgent = (agentConfigs?.length ?? 0) > 0;
    const taskIds = await invoke<number[]>('maa_start_tasks', {
      instanceId,
      tasks,
      agentConfigs: hasAgent ? agentConfigs : null,
      cwd: cwd || '.',
      tcpCompatMode: tcpCompatMode || false,
      piEnvs: hasAgent && piEnvs ? piEnvs : null,
      controllerInfo: controllerInfo ?? null,
    });
    log.info('任务已提交, taskIds:', taskIds);
    return taskIds;
  },

  /**
   * 停止 Agent 并断开连接
   * @param instanceId 实例 ID
   */
  async stopAgent(instanceId: string): Promise<void> {
    log.info('停止 Agent, 实例:', instanceId);
    if (!isTauri()) {
      await apiPost(`/maa/instances/${instanceId}/agent/stop`, {});
      log.info('停止 Agent 成功 (HTTP)');
      return;
    }
    await invoke('maa_stop_agent', { instanceId });
    log.info('停止 Agent 成功');
  },

  /**
   * 监听 MaaFramework 回调事件
   * @param callback 回调函数，接收消息类型和详情
   * @returns 取消监听的函数
   *
   * 常见消息类型：
   * - Resource.Loading.Starting/Succeeded/Failed - 资源加载状态，details 包含 res_id
   * - Controller.Action.Starting/Succeeded/Failed - 控制器动作状态，details 包含 ctrl_id
   * - Tasker.Task.Starting/Succeeded/Failed - 任务执行状态，details 包含 task_id
   * - Node.Recognition.Starting/Succeeded/Failed - 节点识别状态
   * - Node.Action.Starting/Succeeded/Failed - 节点动作状态
   */
  async onCallback(
    callback: (message: string, details: MaaCallbackDetails) => void,
  ): Promise<UnlistenFn> {
    if (!isTauri()) {
      // 浏览器环境：通过 WebSocket 接收 maa-callback 事件
      return wsService.onMaaCallback((message, details) => {
        try {
          const parsedDetails = JSON.parse(details) as MaaCallbackDetails;
          callback(message, parsedDetails);
        } catch {
          log.warn('Failed to parse WS callback details:', details);
          callback(message, {});
        }
      });
    }

    return await listen<MaaCallbackEvent>('maa-callback', (event) => {
      const { message, details } = event.payload;

      try {
        const parsedDetails = JSON.parse(details) as MaaCallbackDetails;
        callback(message, parsedDetails);
      } catch {
        log.warn('Failed to parse callback details:', details);
        callback(message, {});
      }
    });
  },

  async onSelfStopRequested(
    callback: (payload: SelfStopRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    if (!isTauri()) {
      return () => {};
    }

    return await listen<SelfStopRequestedEvent>('mxu-self-stop-requested', (event) => {
      void callback(event.payload);
    });
  },

  /**
   * 等待单个操作完成的一次性回调（适用于截图等需要立即获取结果的场景）
   * 注意：此函数会阻塞调用者直到回调到达，适合在非 UI 线程或循环中使用
   * @param idField 要匹配的 ID 字段名（ctrl_id）
   * @param id 要等待的 ID 值
   * @param timeout 超时时间（毫秒），默认 10000
   * @returns 是否成功
   */
  async waitForScreencap(id: number, timeout: number = 10000): Promise<boolean> {
    if (!isTauri()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    }

    let resolved = false;
    const unlisten = await this.onCallback((message, details) => {
      if (details.ctrl_id !== id) return;

      if (message === 'Controller.Action.Succeeded') {
        if (!resolved) {
          resolved = true;
          settle(true);
        }
      } else if (message === 'Controller.Action.Failed') {
        if (!resolved) {
          resolved = true;
          settle(false);
        }
      }
    });

    let settle!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.warn(`截图等待超时, ctrl_id=${id}`);
        settle(false);
      }
    }, timeout);

    return promise.finally(() => {
      clearTimeout(timeoutId);
      unlisten();
    });
  },

  /**
   * 获取单个实例的运行时状态（通过 Maa API 实时查询）
   * @param instanceId 实例 ID
   */
  async getInstanceState(instanceId: string): Promise<InstanceRuntimeInfo | null> {
    if (!isTauri()) {
      try {
        const allStates = await this.getAllStates();
        if (!allStates) return null;
        const state = allStates.instances[instanceId];
        if (!state) return null;
        return {
          connectionStatus: state.connected ? 'Connected' : 'Disconnected',
          resourceLoaded: state.resourceLoaded,
          isRunning: state.isRunning,
          currentTaskId: null,
        };
      } catch {
        return null;
      }
    }
    try {
      const state = await invoke<{
        connected: boolean;
        resource_loaded: boolean;
        tasker_inited: boolean;
        is_running: boolean;
      }>('maa_get_instance_state', { instanceId });
      return {
        connectionStatus: state.connected ? 'Connected' : 'Disconnected',
        resourceLoaded: state.resource_loaded,
        isRunning: state.is_running,
        currentTaskId: null,
      };
    } catch {
      return null;
    }
  },

  /**
   * 获取所有实例的状态快照（通过 Maa API 实时查询，用于启动时恢复状态）
   */
  async getAllStates(): Promise<{
    instances: Record<
      string,
      {
        connected: boolean;
        resourceLoaded: boolean;
        taskerInited: boolean;
        isRunning: boolean;
        taskRunState: {
          statuses: Record<string, string>;
          mappings: Record<string, string>;
          pendingTaskIds: number[];
          currentTaskIndex: number;
          overallStatus: string | null;
        };
      }
    >;
    cachedAdbDevices: AdbDevice[];
    cachedWin32Windows: Win32Window[];
    cachedWlrootsSockets: string[];
    cachedGamescopeInstances: GamescopeInstance[];
  } | null> {
    try {
      type RawTaskRunState = {
        statuses: Record<string, string>;
        mappings: Record<string, string>;
        pending_task_ids: number[];
        current_task_index: number;
        overall_status: string | null;
      };
      type RawInstanceState = {
        connected: boolean;
        resource_loaded: boolean;
        tasker_inited: boolean;
        is_running: boolean;
        task_run_state: RawTaskRunState;
      };
      type RawAllStates = {
        instances: Record<string, RawInstanceState>;
        cached_adb_devices: AdbDevice[];
        cached_win32_windows: Win32Window[];
        cached_wlroots_sockets: string[];
        cached_gamescope_instances: GamescopeInstance[];
      };

      // Tauri 环境：直接 invoke；浏览器环境：通过后端 HTTP API
      const states = isTauri()
        ? await invoke<RawAllStates>('maa_get_all_states')
        : await apiGet<RawAllStates>('/maa/state');

      // 转换字段名（snake_case -> camelCase）
      const instances: Record<
        string,
        {
          connected: boolean;
          resourceLoaded: boolean;
          taskerInited: boolean;
          isRunning: boolean;
          taskRunState: {
            statuses: Record<string, string>;
            mappings: Record<string, string>;
            pendingTaskIds: number[];
            currentTaskIndex: number;
            overallStatus: string | null;
          };
        }
      > = {};

      for (const [id, state] of Object.entries(states.instances)) {
        const trs = state.task_run_state ?? {};
        instances[id] = {
          connected: state.connected,
          resourceLoaded: state.resource_loaded,
          taskerInited: state.tasker_inited,
          isRunning: state.is_running,
          taskRunState: {
            statuses: trs.statuses ?? {},
            mappings: trs.mappings ?? {},
            pendingTaskIds: trs.pending_task_ids ?? [],
            currentTaskIndex: trs.current_task_index ?? 0,
            overallStatus: trs.overall_status ?? null,
          },
        };
      }

      return {
        instances,
        cachedAdbDevices: states.cached_adb_devices,
        cachedWin32Windows: states.cached_win32_windows,
        cachedWlrootsSockets: states.cached_wlroots_sockets,
        cachedGamescopeInstances: states.cached_gamescope_instances,
      };
    } catch (err) {
      log.error('获取所有状态失败:', err);
      return null;
    }
  },

  /**
   * 获取缓存的 ADB 设备列表
   */
  async getCachedAdbDevices(): Promise<AdbDevice[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<AdbDevice[]>('maa_get_cached_adb_devices');
    } catch {
      return [];
    }
  },

  /**
   * 获取缓存的 Win32 窗口列表
   */
  async getCachedWin32Windows(): Promise<Win32Window[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<Win32Window[]>('maa_get_cached_win32_windows');
    } catch {
      return [];
    }
  },

  /**
   * 获取缓存的 WlRoots socket 列表
   */
  async getCachedWlrootsSockets(): Promise<string[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<string[]>('maa_get_cached_wlroots_sockets');
    } catch {
      return [];
    }
  },

  /**
   * 检查当前进程是否以管理员权限运行
   */
  async isElevated(): Promise<boolean> {
    try {
      if (isTauri()) {
        return await invoke<boolean>('is_elevated');
      }
      const resp = await apiGet<{ elevated: boolean }>('/system/is-elevated');
      return resp.elevated;
    } catch {
      return false;
    }
  },

  /**
   * 检查当前电脑是否处于锁屏状态（仅 Tauri + Windows 生效）
   * 检测异常或非 Tauri 环境按未锁屏处理，避免误拦截任务启动
   */
  async isWorkstationLocked(): Promise<boolean> {
    try {
      if (isTauri()) {
        return await invoke<boolean>('is_workstation_locked');
      }
      return false;
    } catch (err) {
      log.warn('检测锁屏状态失败，按未锁屏处理:', err);
      return false;
    }
  },

  /**
   * 以管理员权限重启应用
   * @returns 如果成功启动新进程会退出当前进程，否则返回错误信息
   */
  async restartAsAdmin(): Promise<void> {
    if (!isTauri()) {
      await apiPost('/system/restart-as-admin');
      return;
    }
    await invoke('restart_as_admin');
  },

  /**
   * 设置保存调试图像
   * @param enabled 是否启用
   */
  async setSaveDraw(enabled: boolean): Promise<boolean> {
    if (!isTauri()) return false;
    log.info('设置保存调试图像:', enabled);
    try {
      const result = await invoke<boolean>('maa_set_save_draw', { enabled });
      log.info('设置保存调试图像成功:', enabled);
      return result;
    } catch (err) {
      log.error('设置保存调试图像失败:', err);
      throw err;
    }
  },

  /**
   * Run pre-action
   * @param program 程序路径
   * @param args 附加参数
   * @param cwd 工作目录（可选）
   * @param waitForExit 是否等待进程退出（默认 true）
   * @param useCmd 是否通过 cmd /c 启动（仅 Windows，默认 false）
   * @returns 程序退出码（不等待时返回 0）
   */
  async runAction(
    instanceId: string,
    program: string,
    args: string,
    cwd?: string,
    waitForExit: boolean = true,
    useCmd: boolean = false,
  ): Promise<number> {
    if (!isTauri()) {
      throw new Error('此功能仅在 Tauri 环境中可用');
    }
    log.info('执行动作:', program, args, '等待:', waitForExit, '使用cmd:', useCmd);
    try {
      const exitCode = await invoke<number>('run_action', {
        instanceId,
        program,
        args,
        cwd: cwd || null,
        waitForExit,
        useCmd,
      });
      log.info('动作执行完成, 退出码:', exitCode);
      return exitCode;
    } catch (err) {
      log.error('动作执行失败:', err);
      throw err;
    }
  },

  async setPreActionStop(instanceId: string, stop: boolean): Promise<void> {
    if (!isTauri()) return;
    await invoke('set_pre_action_stop', { instanceId, stop });
  },

  /**
   * 执行 PI v2.7.0 pretask 外部程序（连接 Controller 前调用）。
   * args 以数组形式直传后端，保留 option 序列化生成的 JSON 参数。
   */
  async runPretask(
    instanceId: string,
    program: string,
    args: string[],
    cwd?: string,
  ): Promise<number> {
    if (!isTauri()) {
      throw new Error('此功能仅在 Tauri 环境中可用');
    }
    log.info('执行预任务:', program, args);
    const exitCode = await invoke<number>('run_pretask', {
      instanceId,
      program,
      args,
      cwd: cwd || null,
    });
    log.info('预任务执行完成, 退出码:', exitCode);
    return exitCode;
  },

  /**
   * 检查指定程序是否正在运行（通过完整路径比较）
   * @param program 程序的绝对路径
   * @returns 是否正在运行
   */
  async isProcessRunning(program: string): Promise<boolean> {
    if (!isTauri()) {
      return false;
    }
    try {
      const running = await invoke<boolean>('is_process_running', { program });
      log.info('进程检查:', program, '运行中:', running);
      return running;
    } catch (err) {
      log.error('进程检查失败:', err);
      return false;
    }
  },

  /**
   * 根据窗口句柄获取对应进程的可执行文件路径（仅 Windows）
   */
  async getProcessPathFromHwnd(hwnd: number): Promise<string> {
    if (!isTauri()) {
      return '';
    }
    try {
      return await invoke<string>('get_process_path_from_hwnd', { hwnd });
    } catch (err) {
      log.warn('获取窗口进程路径失败:', err);
      return '';
    }
  },
};

export default maaService;
