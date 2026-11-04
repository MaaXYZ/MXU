// MXU 配置文件结构 (mxu.json)

import type { ActionConfig, OptionValue } from './interface';
import type { AccentColor, CustomAccent } from '@/themes/types';

export const DEFAULT_MAX_LOGS_PER_INSTANCE = 500;

// 定时执行策略
export interface SchedulePolicy {
  id: string;
  name: string; // 策略名称
  enabled: boolean; // 是否启用
  weekdays: number[]; // 重复日期 (0-6, 0=周日)
  times: string[]; // 开始时间点 ("HH:mm"，已排序去重)
}

// 保存的任务配置
export interface SavedTask {
  id: string;
  taskName: string; // 对应 interface 中的 task.name
  customName?: string; // 用户自定义名称
  enabled: boolean;
  /**
   * 周计划：仅在选中的星期几参与运行（0-6，0=周日）。
   * 缺省或空数组表示未启用周计划。旧配置中不存在，向后兼容。
   */
  weeklySchedule?: number[];
  /** 各控制器独立的勾选状态（旧配置中不存在时按 enabled 初始化） */
  enabledByController?: Record<string, boolean>;
  optionValues: Record<string, OptionValue>;
  /** 任务卡片是否展开；缺省 = 收起，向后兼容 */
  expanded?: boolean;
  /** 各选项的子选项折叠状态（optionKey → 是否折叠）；缺省 = 展开，向后兼容 */
  collapsedOptions?: Record<string, boolean>;
}

// 保存的设备信息
export interface SavedDeviceInfo {
  // ADB 设备：保存设备名称
  adbDeviceName?: string;
  // ADB 设备：保存设备地址（新配置优先，旧配置仍可按名称匹配）
  adbDeviceAddress?: string;
  // Win32/MacOS/Gamepad：保存窗口名称
  windowName?: string;
  // WlRoots：保存 Wayland socket 路径
  wlrSocketPath?: string;
  // PlayCover：保存地址
  playcoverAddress?: string;
  /** Win32 连接窗口对应的进程可执行文件路径 */
  connectedProgramPath?: string;
}

/** 旧版单个前置程序配置（不含 id，用于向后兼容读取） */
export interface LegacyActionConfig {
  enabled: boolean;
  program: string;
  args: string;
  waitForExit: boolean;
  skipIfRunning: boolean;
  useCmd: boolean;
}

// 保存的实例配置
export interface SavedInstance {
  id: string;
  name: string;
  controllerId?: string;
  resourceId?: string;
  // 保存的控制器和资源名称
  controllerName?: string;
  resourceName?: string;
  // 保存的设备信息，用于自动重连
  savedDevice?: SavedDeviceInfo;
  tasks: SavedTask[];
  // 定时执行策略列表
  schedulePolicies?: SchedulePolicy[];
  preActions?: ActionConfig[];
  /** @deprecated 旧版单前置程序字段，仅用于向后兼容读取 */
  preAction?: LegacyActionConfig;
}

// 窗口大小配置
export interface WindowSize {
  width: number;
  height: number;
}

// 窗口位置配置
export interface WindowPosition {
  x: number;
  y: number;
}

// 最近关闭的实例记录
export interface RecentlyClosedInstance {
  id: string; // 原实例 ID
  name: string; // 实例名称
  closedAt: number; // 关闭时间戳
  controllerId?: string;
  resourceId?: string;
  controllerName?: string;
  resourceName?: string;
  savedDevice?: SavedDeviceInfo;
  tasks: SavedTask[]; // 保存的任务配置
  schedulePolicies?: SchedulePolicy[]; // 定时执行策略
  preActions?: ActionConfig[];
  /** @deprecated 旧版单前置程序字段，仅用于向后兼容读取 */
  preAction?: LegacyActionConfig;
}

// MirrorChyan 更新频道
export type UpdateChannel = 'stable' | 'beta';

// 截图帧率类型
export type ScreenshotFrameRate = 'unlimited' | '5' | '1' | '0.2' | '0.033';

// MirrorChyan 设置
export interface MirrorChyanSettings {
  cdk: string; // MirrorChyan CDK（内存中为明文，仅用于运行时）
  cdkEncrypted?: string; // 加密后的 CDK（持久化用，XOR + Base64）
  channel: UpdateChannel; // 更新频道：stable(正式版) / beta(公测版)
  githubPat?: string; // GitHub Personal Access Token（支持 classic 和 fine-grained）
}

// 代理设置
export interface ProxySettings {
  url: string; // 代理地址，格式：http://host:port 或 socks5://host:port
}

// 快捷键设置
export interface HotkeySettings {
  /** 开始任务快捷键（例如：F10） */
  startTasks: string;
  /** 结束任务快捷键（例如：F11） */
  stopTasks: string;
  /** 全局快捷键（窗口失焦时也生效） */
  globalEnabled?: boolean;
}

// 应用设置
export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor?: AccentColor; // 强调色
  language: 'system' | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR';
  backgroundImage?: string; // 背景图片路径
  backgroundOpacity?: number; // 背景图片不透明度 (0-100)
  /** 删除等危险操作是否需要二次确认 */
  confirmBeforeDelete?: boolean;
  /** 每个实例最多保留的日志条数（超出自动丢弃最旧的） */
  maxLogsPerInstance?: number;
  autoClearLogsOnLaunch?: boolean;
  windowSize?: WindowSize;
  windowPosition?: WindowPosition; // 窗口位置
  mirrorChyan?: MirrorChyanSettings;
  proxy?: ProxySettings; // 代理设置
  showOptionPreview?: boolean; // 是否在任务列表显示选项预览
  sidePanelExpanded?: boolean; // 右侧面板是否展开（连接+截图）
  connectionPanelExpanded?: boolean; // 连接设置卡片是否展开
  screenshotPanelExpanded?: boolean; // 实时截图卡片是否展开
  screenshotFrameRate?: ScreenshotFrameRate; // 实时截图帧率
  welcomeShownHash?: string; // 已显示过的 welcome 内容 hash，用于判断内容变化时重新弹窗
  rightPanelWidth?: number; // 右侧面板宽度
  rightPanelCollapsed?: boolean; // 右侧面板是否折叠
  addTaskPanelHeight?: number; // 添加任务面板高度
  devMode?: boolean; // 开发模式，启用后允许 F5 刷新 UI
  onboardingCompleted?: boolean; // 新用户引导是否已完成
  hotkeys?: HotkeySettings; // 快捷键设置
  tcpCompatMode?: boolean; // 通信兼容模式，强制使用 TCP 而非 IPC
  webServerEnabled?: boolean; // Web 服务器是否启用（默认 true，重启生效）
  allowLanAccess?: boolean; // Web UI 允许局域网访问（绑定 0.0.0.0，重启生效）
  webServerPort?: number; // Web 服务器监听端口（默认 12701，重启生效）
  minimizeToTray?: boolean; // 关闭时最小化到托盘（默认 false）
  autoStartInstanceId?: string; // 启动后自动执行的实例 ID（为空或 undefined 表示不自动执行）
  autoRunOnLaunch?: boolean; // 非开机自启动的手动启动场景下，是否也自动执行选定的实例（默认 false）
  autoStartRemovedInstanceName?: string; // 被删除的自动执行配置名称（用于提示用户）
  /** 前置动作轮询设备就绪后、连接前的额外延迟秒数（默认 5，仅通过编辑 mxu.json 修改） */
  preActionConnectDelaySec?: number;
  /** 是否开启匿名遥测（帮助改进软件），默认 true；调试 / 开发版本强制关闭 */
  helpImproveSoftware?: boolean;
}

// MXU 配置文件完整结构
export interface MxuConfig {
  version: string;
  instances: SavedInstance[];
  settings: AppSettings;
  /** 全局任务设置值：用于 interface.global_option 对应的 option */
  globalOptionValues?: Record<string, OptionValue>;
  recentlyClosed?: RecentlyClosedInstance[]; // 最近关闭的实例列表（最多30条）
  interfaceTaskSnapshot?: string[]; // 保存时 interface.json 中的任务名列表快照，用于检测新增任务
  newTaskNames?: string[]; // 用户尚未查看的新增任务名称列表
  /** 自定义强调色列表 */
  customAccents?: CustomAccent[];
  /** 最后激活的实例 ID */
  lastActiveInstanceId?: string;
  /** 是否已完成预设初始化（首次启动自动创建预设 tab） */
  presetInitialized?: boolean;
}

// 默认窗口大小
export const defaultWindowSize: WindowSize = {
  width: 1000,
  height: 618,
};

// 默认 MirrorChyan 设置
export const defaultMirrorChyanSettings: MirrorChyanSettings = {
  cdk: '',
  channel: 'stable',
};

// 默认截图帧率
export const defaultScreenshotFrameRate: ScreenshotFrameRate = '1';

// 添加任务面板高度约束
export const addTaskPanelHeightMin = 100;
export const addTaskPanelHeightMax = 600;
export const defaultAddTaskPanelHeight = 192;
export const addTaskPanelResizeStep = 24;

export function clampAddTaskPanelHeight(value: number): number {
  return Math.max(addTaskPanelHeightMin, Math.min(addTaskPanelHeightMax, value));
}

export function normalizeAddTaskPanelHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultAddTaskPanelHeight;
  }
  return clampAddTaskPanelHeight(value);
}

// 默认强调色
export const defaultAccentColor: AccentColor = 'emerald';

// 默认快捷键设置
export const defaultHotkeySettings: HotkeySettings = {
  startTasks: 'F10',
  stopTasks: 'F11',
};

// 默认配置
export const defaultConfig: MxuConfig = {
  version: '1.0',
  instances: [],
  settings: {
    theme: 'system',
    accentColor: defaultAccentColor,
    language: 'system',
    confirmBeforeDelete: false,
    maxLogsPerInstance: DEFAULT_MAX_LOGS_PER_INSTANCE,
    autoClearLogsOnLaunch: false,
    windowSize: defaultWindowSize,
    mirrorChyan: defaultMirrorChyanSettings,
    helpImproveSoftware: true,
  },
};

/**
 * 判断任意值是否是结构上可用的 MxuConfig。
 *
 * `parseJsonc` 解析失败时不抛异常而是返回 undefined，若不校验就会把 undefined
 * 当成配置一路传下去，直到访问 `config.instances` 时才炸。所有读盘路径都必须先过这里。
 */
export function isValidMxuConfig(value: unknown): value is MxuConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<MxuConfig>;
  return (
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.instances) &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    !Array.isArray(candidate.settings)
  );
}
