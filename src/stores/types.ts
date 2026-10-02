import type {
  ProjectInterface,
  Instance,
  OptionValue,
  SavedDeviceInfo,
  ActionConfig,
} from '@/types/interface';
import type {
  MxuConfig,
  WindowSize,
  WindowPosition,
  UpdateChannel,
  MirrorChyanSettings,
  ProxySettings,
  RecentlyClosedInstance,
  ScreenshotFrameRate,
  HotkeySettings,
} from '@/types/config';
import type {
  ConnectionStatus,
  TaskStatus,
  AdbDevice,
  Win32Window,
  GamescopeInstance,
} from '@/types/maa';
import type { AccentColor, CustomAccent } from '@/themes';

/** 单个任务的运行状态 */
export type TaskRunStatus = 'idle' | 'pending' | 'running' | 'succeeded' | 'failed';

/** 日志条目类型 */
export type LogType = 'info' | 'success' | 'warning' | 'error' | 'agent' | 'focus';

/** 日志条目 */
export interface LogEntry {
  id: string;
  timestamp: Date;
  type: LogType;
  message: string;
  /** 可选的富文本 HTML 内容（用于 focus 消息） */
  html?: string;
}

export type Theme = 'light' | 'dark' | 'system';
export type Language = 'system' | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR';
export type PageView = 'main' | 'settings';

// 定时执行状态信息
export interface ScheduleExecutionInfo {
  policyName: string;
  startTime: number; // timestamp
}

// 更新信息类型
export interface UpdateInfo {
  hasUpdate: boolean;
  versionName: string;
  releaseNote: string;
  downloadUrl?: string;
  updateType?: 'incremental' | 'full';
  channel?: string;
  fileSize?: number;
  filename?: string;
  downloadSource?: 'mirrorchyan' | 'github';
  // MirrorChyan API 错误信息
  errorCode?: number;
  errorMessage?: string;
}

// 下载进度类型
export interface DownloadProgress {
  downloadedSize: number;
  totalSize: number;
  speed: number;
  progress: number; // 0-100
}

// 下载状态类型
export type DownloadStatus = 'idle' | 'downloading' | 'completed' | 'failed';

// 安装状态类型
export type InstallStatus = 'idle' | 'installing' | 'completed' | 'failed';

// 更新完成信息（重启后显示）
export interface JustUpdatedInfo {
  previousVersion: string;
  newVersion: string;
  releaseNote: string;
  channel?: string;
}

// 全局快捷键注册失败信息
export interface GlobalHotkeyError {
  /** 注册失败的快捷键组合（如 Ctrl+F12） */
  combo: string;
  /** 是否为按键被其他程序占用导致的冲突 */
  conflict: boolean;
  /** 原始错误信息 */
  message: string;
}

export interface AppState {
  // 配置持久化保护（防止启动早期空状态覆盖用户配置）
  configPersistenceReady: boolean;
  setConfigPersistenceReady: (ready: boolean) => void;

  // 主题和语言
  theme: Theme;
  accentColor: AccentColor;
  language: Language;
  backgroundImage?: string;
  backgroundOpacity: number;
  /** 删除等危险操作是否需要二次确认 */
  confirmBeforeDelete: boolean;
  /** 每个实例最多保留的日志条数（超出自动丢弃最旧的） */
  maxLogsPerInstance: number;
  autoClearLogsOnLaunch: boolean;
  /** 是否开启匿名遥测（帮助改进软件），默认 true；调试 / 开发版本强制关闭 */
  helpImproveSoftware: boolean;
  customAccents: CustomAccent[];
  setTheme: (theme: Theme) => void;
  setAccentColor: (accent: AccentColor) => void;
  setLanguage: (lang: Language) => void;
  setBackgroundImage: (path?: string) => void;
  setBackgroundOpacity: (opacity: number) => void;
  setConfirmBeforeDelete: (enabled: boolean) => void;
  setMaxLogsPerInstance: (value: number) => void;
  setAutoClearLogsOnLaunch: (enabled: boolean) => void;
  setHelpImproveSoftware: (enabled: boolean) => void;
  addCustomAccent: (accent: CustomAccent) => void;
  updateCustomAccent: (id: string, accent: CustomAccent) => void;
  removeCustomAccent: (id: string) => void;
  reorderCustomAccents: (oldIndex: number, newIndex: number) => void;

  // 当前页面
  currentPage: PageView;
  setCurrentPage: (page: PageView) => void;

  /** 进入设置页后需要自动滚动到的分区 id（如 'update'），由 SettingsPage 消费后清空 */
  settingsTargetSection: string | null;
  setSettingsTargetSection: (section: string | null) => void;

  // 调试选项（不落盘，每次启动默认关闭）
  saveDraw: boolean;
  setSaveDraw: (enabled: boolean) => void;

  // Interface 数据
  projectInterface: ProjectInterface | null;
  interfaceTranslations: Record<string, Record<string, string>>;
  basePath: string; // exe 所在目录（资源路径）
  dataPath: string; // 数据目录（Linux: $XDG_DATA_HOME/{项目名}，macOS: ~/Library/Application Support/MXU/，Windows 同 basePath）
  setProjectInterface: (pi: ProjectInterface) => void;
  setInterfaceTranslations: (lang: string, translations: Record<string, string>) => void;
  setBasePath: (path: string) => void;
  setDataPath: (path: string) => void;

  // 多开实例
  instances: Instance[];
  activeInstanceId: string | null;
  nextInstanceNumber: number;
  createInstance: (name?: string, exactName?: boolean) => string;
  removeInstance: (id: string) => void;
  setActiveInstance: (id: string) => void;
  updateInstance: (id: string, updates: Partial<Instance>) => void;
  renameInstance: (id: string, newName: string) => void;
  reorderInstances: (oldIndex: number, newIndex: number) => void;

  // 获取活动实例
  getActiveInstance: () => Instance | null;

  // 任务操作
  addTaskToInstance: (
    instanceId: string,
    task: { name: string; option?: string[]; description?: string },
    options?: { prepend?: boolean },
  ) => void;
  /** v2.3.0: 应用预设配置到实例 */
  applyPreset: (instanceId: string, presetName: string) => void;
  /** v2.3.0: 跳过预设选择（本次会话内该实例不再显示预设选择界面） */
  skipPreset: (instanceId: string) => void;
  /** v2.3.0: 记录本次会话中已跳过预设选择的实例 ID 集合（不持久化） */
  skippedPresetInstanceIds: Set<string>;
  /** v2.3.0: 是否已完成预设初始化（首次启动自动建立预设 tab） */
  presetInitialized: boolean;
  setPresetInitialized: (value: boolean) => void;
  /** @deprecated 使用 addMxuSpecialTask 代替 */
  addSleepTaskToInstance: (instanceId: string, sleepTime?: number) => string;
  /** 添加 MXU 特殊任务到实例 */
  addMxuSpecialTask: (
    instanceId: string,
    taskName: string,
    initialValues?: Record<string, string>,
    taskOptions?: {
      enabled?: boolean;
      expanded?: boolean;
      customName?: string;
      /** 覆盖 switch 选项的初始值（key 为选项 key，value 为 boolean） */
      switchOverrides?: Record<string, boolean>;
    },
  ) => string;
  removeTaskFromInstance: (instanceId: string, taskId: string) => void;
  reorderTasks: (instanceId: string, oldIndex: number, newIndex: number) => void;
  toggleTaskEnabled: (instanceId: string, taskId: string) => void;
  setTaskRunOnce: (instanceId: string, taskId: string, runOnce: boolean) => void;
  clearAllTaskRunOnce: (instanceId: string) => void;
  toggleTaskExpanded: (instanceId: string, taskId: string) => void;
  toggleOptionCollapsed: (instanceId: string, taskId: string, optionKey: string) => void;
  setTaskOptionValue: (
    instanceId: string,
    taskId: string,
    optionKey: string,
    value: OptionValue,
  ) => void;
  /** 全局任务设置值（对应 interface.global_option），跨实例/配置共享 */
  globalOptionValues: Record<string, OptionValue>;
  setGlobalOptionValue: (optionKey: string, value: OptionValue) => void;
  selectAllTasks: (instanceId: string, enabled: boolean) => void;
  collapseAllTasks: (instanceId: string, expanded: boolean) => void;
  renameTask: (instanceId: string, taskId: string, newName: string) => void;

  // 任务右键菜单操作
  duplicateTask: (instanceId: string, taskId: string) => void;
  moveTaskUp: (instanceId: string, taskId: string) => void;
  moveTaskDown: (instanceId: string, taskId: string) => void;
  moveTaskToTop: (instanceId: string, taskId: string) => void;
  moveTaskToBottom: (instanceId: string, taskId: string) => void;

  // 实例右键菜单操作
  duplicateInstance: (instanceId: string) => string;

  // 全局 UI 状态
  showAddTaskPanel: boolean;
  setShowAddTaskPanel: (show: boolean) => void;

  // 最近添加的任务 ID（用于自动滚动和展开）
  lastAddedTaskId: string | null;
  clearLastAddedTaskId: () => void;

  // 正在播放入场动画的任务 ID 列表
  animatingTaskIds: string[];
  removeAnimatingTaskId: (taskId: string) => void;

  // 标签页动画状态
  animatingTabIds: string[];
  closingTabIds: string[];
  removeAnimatingTabId: (tabId: string) => void;
  startTabCloseAnimation: (tabId: string) => void;

  // 新增任务名称列表
  newTaskNames: string[];
  setNewTaskNames: (names: string[]) => void;
  removeNewTaskName: (name: string) => void;
  clearNewTaskNames: () => void;

  // 国际化文本解析
  resolveI18nText: (text: string | undefined, lang: string) => string;

  // 配置导入
  importConfig: (config: MxuConfig) => void;

  // MaaFramework 状态
  maaInitialized: boolean;
  maaVersion: string | null;
  setMaaInitialized: (initialized: boolean, version?: string) => void;

  // 实例运行时状态
  instanceConnectionStatus: Record<string, ConnectionStatus>;
  instanceResourceLoaded: Record<string, boolean>;
  instanceCurrentTaskId: Record<string, number | null>;
  instanceTaskStatus: Record<string, TaskStatus | null>;

  setInstanceConnectionStatus: (instanceId: string, status: ConnectionStatus) => void;
  setInstanceResourceLoaded: (instanceId: string, loaded: boolean) => void;
  setInstanceCurrentTaskId: (instanceId: string, taskId: number | null) => void;
  setInstanceTaskStatus: (instanceId: string, status: TaskStatus | null) => void;

  // 选中的控制器和资源
  selectedController: Record<string, string>;
  selectedResource: Record<string, string>;
  setSelectedController: (instanceId: string, controllerName: string) => void;
  setSelectedResource: (instanceId: string, resourceName: string) => void;

  // 设备信息保存
  setInstanceSavedDevice: (instanceId: string, savedDevice: SavedDeviceInfo) => void;

  addPreAction: (
    instanceId: string,
    action: ActionConfig,
    dedup?: { field: 'program'; value: string },
  ) => boolean;
  updatePreAction: (instanceId: string, actionId: string, updates: Partial<ActionConfig>) => void;
  removePreAction: (instanceId: string, actionId: string) => void;
  reorderPreActions: (instanceId: string, oldIndex: number, newIndex: number) => void;
  renamePreAction: (instanceId: string, actionId: string, name: string) => void;
  duplicatePreAction: (instanceId: string, actionId: string) => void;

  // 设备列表缓存
  cachedAdbDevices: AdbDevice[];
  cachedWin32Windows: Win32Window[];
  cachedWlrootsSockets: string[];
  cachedGamescopeInstances: GamescopeInstance[];
  setCachedAdbDevices: (devices: AdbDevice[]) => void;
  setCachedWin32Windows: (windows: Win32Window[]) => void;
  setCachedWlrootsSockets: (sockets: string[]) => void;
  setCachedGamescopeInstances: (instances: GamescopeInstance[]) => void;

  // 从后端恢复 MAA 运行时状态
  restoreBackendStates: (
    states: {
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
    },
    options?: { skipRunningState?: boolean },
  ) => void;

  // 截图流状态
  instanceScreenshotStreaming: Record<string, boolean>;
  setInstanceScreenshotStreaming: (instanceId: string, streaming: boolean) => void;

  // 右侧面板折叠状态
  sidePanelExpanded: boolean;
  setSidePanelExpanded: (expanded: boolean) => void;
  toggleSidePanelExpanded: () => void;

  // 右侧面板宽度和折叠状态
  rightPanelWidth: number;
  rightPanelCollapsed: boolean;
  setRightPanelWidth: (width: number) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;

  // 添加任务面板高度
  addTaskPanelHeight: number;
  setAddTaskPanelHeight: (height: number) => void;

  // 卡片展开状态
  connectionPanelExpanded: boolean;
  screenshotPanelExpanded: boolean;
  setConnectionPanelExpanded: (expanded: boolean) => void;
  setScreenshotPanelExpanded: (expanded: boolean) => void;

  // 中控台视图模式
  dashboardView: boolean;
  setDashboardView: (enabled: boolean) => void;
  toggleDashboardView: () => void;

  // 窗口大小
  windowSize: WindowSize;
  setWindowSize: (size: WindowSize) => void;

  // 窗口位置
  windowPosition: WindowPosition | undefined;
  setWindowPosition: (position: WindowPosition | undefined) => void;

  // MirrorChyan 更新设置
  mirrorChyanSettings: MirrorChyanSettings;
  setMirrorChyanCdk: (cdk: string) => void;
  setMirrorChyanChannel: (channel: UpdateChannel) => void;

  // 代理设置
  proxySettings: ProxySettings | undefined;
  setProxySettings: (settings: ProxySettings | undefined) => void;

  // 快捷键设置
  hotkeys: HotkeySettings;
  setHotkeys: (hotkeys: HotkeySettings) => void;

  // 全局快捷键注册失败信息（不落盘，仅本次运行）
  globalHotkeyError: GlobalHotkeyError | null;
  setGlobalHotkeyError: (err: GlobalHotkeyError | null) => void;

  // 任务选项预览显示设置
  showOptionPreview: boolean;
  setShowOptionPreview: (show: boolean) => void;

  // 实时截图帧率设置
  screenshotFrameRate: ScreenshotFrameRate;
  setScreenshotFrameRate: (rate: ScreenshotFrameRate) => void;

  // Welcome 弹窗显示记录
  welcomeShownHash: string;
  setWelcomeShownHash: (hash: string) => void;

  // 开发模式
  devMode: boolean;
  setDevMode: (devMode: boolean) => void;

  // 通信兼容模式
  tcpCompatMode: boolean;
  setTcpCompatMode: (enabled: boolean) => void;

  /** Web 服务器是否启用（默认 true，重启生效） */
  webServerEnabled: boolean;
  setWebServerEnabled: (enabled: boolean) => void;

  /** Web UI 允许局域网访问（绑定 0.0.0.0，重启生效） */
  allowLanAccess: boolean;
  setAllowLanAccess: (enabled: boolean) => void;

  /** Web 服务器监听端口（默认 12701，重启生效） */
  webServerPort: number;
  setWebServerPort: (port: number) => void;

  /** 后端真实 OS（运行时从后端获取，'' = 未知；用于控制器平台过滤、更新资产匹配等，不持久化） */
  backendOS: string;
  backendArch: string;
  setBackendOS: (os: string, arch: string) => void;

  // 托盘设置
  minimizeToTray: boolean;
  setMinimizeToTray: (enabled: boolean) => void;

  // 是否为开机自启动模式（无人值守，跳过阻塞式弹窗）
  isAutoStartMode: boolean;
  setIsAutoStartMode: (mode: boolean) => void;

  // 启动后自动执行的实例 ID
  autoStartInstanceId: string | undefined;
  setAutoStartInstanceId: (id: string | undefined) => void;

  // 被删除的自动执行实例名称（用于提示用户）
  autoStartRemovedInstanceName: string | undefined;
  setAutoStartRemovedInstanceName: (name: string | undefined) => void;

  // 手动启动时是否也自动执行
  autoRunOnLaunch: boolean;
  setAutoRunOnLaunch: (enabled: boolean) => void;

  // 新用户引导
  onboardingCompleted: boolean;
  setOnboardingCompleted: (completed: boolean) => void;

  /** 前置动作轮询设备就绪后、连接前的额外延迟秒数（默认 5，仅通过编辑 mxu.json 修改） */
  preActionConnectDelaySec: number;

  // 更新检查状态
  updateInfo: UpdateInfo | null;
  updateCheckLoading: boolean;
  showUpdateDialog: boolean;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setUpdateCheckLoading: (loading: boolean) => void;
  setShowUpdateDialog: (show: boolean) => void;

  // 下载状态
  downloadStatus: DownloadStatus;
  downloadProgress: DownloadProgress | null;
  downloadSavePath: string | null;
  /** 下载速度持续低于阈值的起始时间戳，速度回升或下载结束时置为 null */
  slowDownloadSince: number | null;
  setDownloadStatus: (status: DownloadStatus) => void;
  setDownloadProgress: (progress: DownloadProgress | null) => void;
  setDownloadSavePath: (path: string | null) => void;
  resetDownloadState: () => void;

  // 安装状态
  showInstallConfirmModal: boolean;
  installStatus: InstallStatus;
  installError: string | null;
  justUpdatedInfo: JustUpdatedInfo | null;
  /** 自动安装待执行标记（由 tryAutoInstallUpdate 设置，InstallConfirmModal 消费） */
  autoInstallPending: boolean;
  setShowInstallConfirmModal: (show: boolean) => void;
  setInstallStatus: (status: InstallStatus) => void;
  setInstallError: (error: string | null) => void;
  setJustUpdatedInfo: (info: JustUpdatedInfo | null) => void;
  setAutoInstallPending: (pending: boolean) => void;
  resetInstallState: () => void;

  // 最近关闭的实例
  recentlyClosed: RecentlyClosedInstance[];
  reopenRecentlyClosed: (id: string) => string | null;
  removeFromRecentlyClosed: (id: string) => void;
  clearRecentlyClosed: () => void;

  // 任务运行状态（只读缓存，由 restoreBackendStates 从后端填充）
  instanceTaskRunStatus: Record<string, Record<string, TaskRunStatus>>;
  maaTaskIdMapping: Record<string, Record<number, string>>;
  instancePendingTaskIds: Record<string, number[]>;
  instanceCurrentTaskIndex: Record<string, number>;
  /** 通过 maaTaskId 反查 selectedTaskId（用于日志模块） */
  findSelectedTaskIdByMaaTaskId: (instanceId: string, maaTaskId: number) => string | null;
  /** 通过 selectedTaskId 反查 maaTaskId（用于 pipeline override） */
  findMaaTaskIdBySelectedTaskId: (instanceId: string, selectedTaskId: string) => number | null;
  /** 清空指定实例的本地任务运行状态缓存 */
  clearTaskRunStatus: (instanceId: string) => void;

  // 定时执行状态
  scheduleExecutions: Record<string, ScheduleExecutionInfo>;
  setScheduleExecution: (instanceId: string, info: ScheduleExecutionInfo | null) => void;
  clearScheduleExecution: (instanceId: string) => void;

  // 日志管理
  instanceLogs: Record<string, LogEntry[]>;
  addLog: (instanceId: string, log: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: (instanceId: string) => void;
  clearControllerRuntimeState: (instanceId: string) => void;

  // 回调 ID 与名称的映射
  ctrlIdToName: Record<number, string>;
  ctrlIdToType: Record<number, 'device' | 'window'>;
  instanceCtrlIds: Record<string, number[]>;
  resIdToName: Record<number, string>;
  resBatchInfo: Record<number, { isFirst: boolean; isLast: boolean }>;
  taskIdToName: Record<number, string>;
  entryToTaskName: Record<string, string>;
  registerCtrlIdName: (
    instanceId: string,
    ctrlId: number,
    name: string,
    type: 'device' | 'window',
  ) => void;
  registerResIdName: (resId: number, name: string) => void;
  registerResBatch: (resIds: number[]) => void;
  registerTaskIdName: (taskId: number, name: string) => void;
  registerEntryTaskName: (entry: string, name: string) => void;
  getCtrlName: (ctrlId: number) => string | undefined;
  getCtrlType: (ctrlId: number) => 'device' | 'window' | undefined;
  getResName: (resId: number) => string | undefined;
  getResBatchInfo: (resId: number) => { isFirst: boolean; isLast: boolean } | undefined;
  getTaskName: (taskId: number) => string | undefined;
  getTaskNameByEntry: (entry: string) => string | undefined;
}
