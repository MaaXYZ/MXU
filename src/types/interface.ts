// MaaFramework ProjectInterface V2 协议类型定义

export interface ProjectInterface {
  interface_version: 2;
  languages?: Record<string, string>;
  name: string;
  label?: string;
  title?: string;
  icon?: string;
  mirrorchyan_rid?: string;
  mirrorchyan_multiplatform?: boolean;
  github?: string;
  version?: string;
  contact?: string;
  license?: string;
  welcome?: string;
  description?: string;
  agent?: AgentConfig | AgentConfig[];
  controller: ControllerItem[];
  resource: ResourceItem[];
  /** v2.4.0: 任务分组声明 */
  group?: GroupItem[];
  task: TaskItem[];
  option?: Record<string, OptionDefinition>;
  /** v2.3.0: 全局选项配置，参与到所有任务的 pipeline override 中 */
  global_option?: string[];
  /**
   * MXU 扩展：任务设置页的 UI 元数据
   * 仅描述如何展示设置区域，不定义 option 本身；实际可编辑项仍复用 `option`
   */
  setting?: InterfaceSettingSection[];
  /** v2.2.0: 导入其他 PI 文件的路径数组 */
  import?: string[];
  /** v2.3.0: 预设配置 */
  preset?: PresetItem[];
  /** v2.7.0: Controller 启动前执行的预任务声明 */
  pretask?: PretaskItem | PretaskItem[];
  /** v2.9.0: 匿名遥测（数据埋点）配置容器 */
  telemetry?: TelemetryConfig;
}

/**
 * v2.9.0: 匿名遥测（数据埋点）配置容器。
 * 作为遥测配置的统一容器，当前提供 `sentry` 子字段，未来可扩展其他平台。
 */
export interface TelemetryConfig {
  /** 基于 Sentry 的遥测配置 */
  sentry?: SentryTelemetryConfig;
}

/** v2.9.0: 基于 Sentry 的遥测配置。 */
export interface SentryTelemetryConfig {
  /** Sentry 项目的 DSN。必填；缺省或为空字符串时不启用 Sentry 遥测。 */
  dsn: string;
  /** 是否启用性能 / 事务上报（任务生命周期）。可选，默认 true。 */
  tracing?: boolean;
  /** 事务采样率，取值 0~1。可选，默认 1.0。 */
  traces_sample_rate?: number;
  /** 失败附件独立采样率，取值 0~1。Error Event 本身不受影响。可选，默认 1.0。 */
  failure_attachments_sample_rate?: number;
  /** 环境标签（如 production、beta）。可选，缺省由 Client 决定。 */
  environment?: string;
}

/**
 * v2.7.0: 预任务（pretask）配置项。
 * 由项目在 interface.json 中声明，Client 应在连接 Controller 前按顺序执行这些外部程序。
 */
export interface PretaskItem {
  /** 要执行的程序路径，可以是系统 PATH 中的可执行文件 */
  exec: string;
  /** 💡 v2.8.1: 指定适用的控制器列表（controller.name） */
  controller?: string[];
  /** 💡 v2.8.1: 指定适用的资源包列表（resource.name） */
  resource?: string[];
  /** 可选。固定参数数组，按顺序传递给 exec */
  args?: string[];
  /** 可选。唯一标识符，缺省时回退到 exec */
  name?: string;
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头） */
  label?: string;
  /** 可选。详细说明，支持国际化字符串/文件路径/URL，内容支持 Markdown */
  description?: string;
  /** 可选。图标路径，相对于 interface.json 所在目录 */
  icon?: string;
  /** 可选。引用的顶层 option 键名数组，其取值序列化为最后一个参数 */
  option?: string[];
}

/**
 * 将 PI 协议中的 pretask 字段（单对象或数组）标准化为数组。
 * 如果 pretask 未定义则返回 undefined。
 */
export function normalizePretaskConfigs(
  pretask: PretaskItem | PretaskItem[] | undefined,
): PretaskItem[] | undefined {
  if (!pretask) return undefined;
  return Array.isArray(pretask) ? pretask : [pretask];
}

/** MXU 扩展：任务设置页 section 定义 */
export interface InterfaceSettingSection {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  default_expand?: boolean;
  option?: string[];
}

/** v2.4.0: 任务分组声明 */
export interface GroupItem {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  default_expand?: boolean;
}

export interface AgentConfig {
  child_exec: string;
  child_args?: string[];
  identifier?: string;
  /** 连接超时时间（毫秒），-1 表示无限等待 */
  timeout?: number;
}

/**
 * 将 PI 协议中的 agent 字段（单对象或数组）标准化为数组。
 * 如果 agent 未定义则返回 undefined。
 */
export function normalizeAgentConfigs(
  agent: AgentConfig | AgentConfig[] | undefined,
): AgentConfig[] | undefined {
  if (!agent) return undefined;
  return Array.isArray(agent) ? agent : [agent];
}

export type ControllerType =
  | 'Adb'
  | 'Win32'
  | 'MacOS'
  | 'WlRoots'
  | 'Linux'
  | 'PlayCover'
  | 'Gamepad';

export interface ControllerItem {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  type: ControllerType;
  display_short_side?: number;
  display_long_side?: number;
  display_raw?: boolean;
  permission_required?: boolean;
  /** v2.2.0: 额外的资源路径数组，在 resource.path 加载完成后加载 */
  attach_resource_path?: string[];
  /** v2.3.0: 控制器级的选项配置 */
  option?: string[];
  adb?: Record<string, unknown>;
  win32?: Win32Config;
  macos?: MacOSConfig;
  wlroots?: WlRootsConfig;
  linux?: LinuxConfig;
  playcover?: PlayCoverConfig;
  gamepad?: GamepadConfig;
}

export interface Win32Config {
  class_regex?: string;
  window_regex?: string;
  mouse?: string;
  keyboard?: string;
  screencap?: string | string[];
}

export interface MacOSConfig {
  title_regex?: string;
  screencap?: string;
  input?: string;
}

export interface WlRootsConfig {
  wlr_socket_path?: string;
  use_win32_vk_code?: boolean;
}

export interface LinuxConfig {
  screencap?: string;
  input?: string;
  use_win32_vk_code?: boolean;
  pipewire_source?: 'Gamescope' | 'Portal';
}

export interface PlayCoverConfig {
  uuid?: string;
}

export interface GamepadConfig {
  class_regex?: string;
  window_regex?: string;
  gamepad_type?: 'Xbox360' | 'DualShock4' | 'DS4';
  screencap?: string;
}

export interface ResourceItem {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  path: string[];
  controller?: string[];
  option?: string[];
  /** v2.6.0: resource integrity hash from MaaResourceGetHash */
  hash?: string;
}

export interface TaskItem {
  name: string;
  label?: string;
  entry: string;
  default_check?: boolean;
  description?: string;
  icon?: string;
  /** v2.4.0: 任务所属分组列表 */
  group?: string[];
  resource?: string[];
  controller?: string[];
  pipeline_override?: Record<string, unknown>;
  option?: string[];
}

export type OptionType = 'select' | 'checkbox' | 'input' | 'switch' | 'hotkey';

export interface CaseItem {
  name: string;
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  option?: string[];
  pipeline_override?: Record<string, unknown>;
}

export interface InputItem {
  name: string;
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  default?: string;
  pipeline_type?: 'string' | 'int' | 'bool';
  verify?: string;
  pattern_msg?: string;
  /**
   * MXU 扩展：输入控件类型，'file' 会渲染文件选择器，'time' 会渲染时间选择器
   */
  input_type?: 'text' | 'file' | 'time';
  /** MXU 扩展：输入框占位提示文本（i18n key） */
  placeholder?: string;
  /** MXU 扩展：密码字段；启用后 UI 掩码显示，配置加密存储，日志/遥测脱敏 */
  password?: boolean;
}

export interface SelectOption {
  type?: 'select';
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  controller?: string[];
  /** v2.3.0: 指定适用的资源包列表 */
  resource?: string[];
  cases: CaseItem[];
  default_case?: string;
}

/** v2.3.0: 多选框类型 */
export interface CheckboxOption {
  type: 'checkbox';
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  controller?: string[];
  resource?: string[];
  cases: CaseItem[];
  default_case?: string[];
  /** v2.10.1: 最少选择数量，默认 0 */
  min_count?: number;
  /** v2.10.1: 最大选择数量，缺省表示不限制 */
  max_count?: number;
}

export interface SwitchOption {
  type: 'switch';
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  controller?: string[];
  resource?: string[];
  cases: [CaseItem, CaseItem];
  default_case?: string;
}

export interface InputOption {
  type: 'input';
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  controller?: string[];
  resource?: string[];
  inputs: InputItem[];
  pipeline_override?: Record<string, unknown>;
}

export interface HotkeyOption {
  type: 'hotkey';
  /** 可选。UI 展示名称，支持国际化字符串（以 $ 开头）。MXU 扩展：支持行内 Markdown，渲染见 components/RichLabel.tsx */
  label?: string;
  description?: string;
  icon?: string;
  controller?: string[];
  resource?: string[];
  /** 热键项，支持单键或组合键捕获 */
  hotkeys: InputItem[];
  pipeline_override?: Record<string, unknown>;
}

export type OptionDefinition =
  | SelectOption
  | CheckboxOption
  | SwitchOption
  | InputOption
  | HotkeyOption;

// 运行时状态类型
export interface SelectedTask {
  id: string;
  taskName: string;
  customName?: string; // 用户自定义名称
  enabled: boolean;
  /** 单次运行：下次启动时包含该任务，运行结束后自动清除 */
  runOnce?: boolean;
  /**
   * 周计划：仅在选中的星期几参与运行（0-6，0=周日）。
   * 缺省或空数组表示未启用周计划，即每天都会参与。
   * 显式操作（单次运行 / 从此处运行的锚点）不受周计划约束。
   */
  weeklySchedule?: number[];
  /** 各控制器独立的勾选状态；enabled 始终表示当前控制器的状态 */
  enabledByController?: Record<string, boolean>;
  optionValues: Record<string, OptionValue>;
  expanded: boolean;
  /** 各选项的子选项折叠状态（optionKey → 是否折叠）；缺省 = 展开，向后兼容 */
  collapsedOptions?: Record<string, boolean>;
}

export type OptionValue =
  | {
      type: 'select';
      caseName: string;
    }
  | {
      type: 'checkbox';
      caseNames: string[];
    }
  | {
      type: 'switch';
      value: boolean;
    }
  | {
      type: 'input';
      values: Record<string, string>;
      /** 密码字段密文（持久化用，XOR + Base64）；运行时 values 中为明文 */
      encryptedValues?: Record<string, string>;
    }
  | {
      type: 'hotkey';
      values: Record<string, string>;
    };

// 保存的设备信息（运行时使用）
export interface SavedDeviceInfo {
  adbDeviceName?: string;
  /** ADB 设备地址，用于优先恢复连接；旧配置仍可按名称匹配 */
  adbDeviceAddress?: string;
  windowName?: string;
  wlrSocketPath?: string;
  playcoverAddress?: string;
  /** Linux 控制器：gamescope display 号（gamescope-<n> 的 n，节点 id 会随会话变化，故存 display 号） */
  gamescopeDisplayNo?: number;
  /** Linux 控制器：uinput 输入的物理屏幕分辨率（宽/高） */
  uinputScreenWidth?: number;
  uinputScreenHeight?: number;
  /** Win32 连接窗口对应的进程可执行文件路径 */
  connectedProgramPath?: string;
}

// 定时执行策略
export interface SchedulePolicy {
  id: string;
  name: string; // 策略名称
  enabled: boolean; // 是否启用
  weekdays: number[]; // 重复日期 (0-6, 0=周日)
  times: string[]; // 开始时间点 ("HH:mm"，已排序去重)
}

// pre-action config
export interface ActionConfig {
  id: string; // 唯一标识（用于排序和识别）
  customName?: string; // 用户自定义名称
  enabled: boolean; // 是否启用
  program: string; // 程序路径
  args: string; // 附加参数
  waitForExit: boolean; // 是否等待进程退出（默认 true）
  skipIfRunning: boolean; // 程序已运行时跳过执行（默认 true）
  useCmd: boolean; // 通过 cmd /c 启动（仅 Windows，默认 false）
}

// 多开实例状态
export interface Instance {
  id: string;
  name: string;
  controllerId?: string;
  resourceId?: string;
  // 保存的控制器和资源名称
  controllerName?: string;
  resourceName?: string;
  // 保存的设备信息
  savedDevice?: SavedDeviceInfo;
  selectedTasks: SelectedTask[];
  isRunning: boolean;
  // 定时执行策略列表
  schedulePolicies?: SchedulePolicy[];
  preActions?: ActionConfig[];
}

/** v2.3.0: 预设中的任务配置 */
export interface PresetTaskItem {
  name: string;
  enabled?: boolean;
  option?: Record<string, PresetOptionValue>;
}

/** v2.3.0: 预设中的选项值 */
export type PresetOptionValue =
  | string // select / switch
  | string[] // checkbox
  | Record<string, string>; // input

/** v2.3.0: 预设配置项 */
export interface PresetItem {
  name: string;
  label?: string;
  description?: string;
  icon?: string;
  task?: PresetTaskItem[];
  /** v2.10.3: 预设中的预任务配置，name 对应顶层 pretask[].name */
  pretask?: PresetTaskItem[];
}

/** v2.3.0: focus 模板，支持字符串简写和对象完整写法 */
export type FocusDisplayChannel = 'log' | 'toast' | 'notification' | 'dialog' | 'modal';

export interface FocusTemplateObject {
  /** 展示内容；缺省时该消息不展示，仅用于配置 trace */
  content?: string;
  display?: FocusDisplayChannel | FocusDisplayChannel[];
  /**
   * v2.9.1: 是否把本次节点结果上传到遥测平台。
   * 缺省时仅 `Node.PipelineNode.Failed` 视为 true，其余消息视为 false。
   */
  trace?: boolean;
}

export type FocusTemplate = string | FocusTemplateObject;

// 翻译文件类型
export type TranslationMap = Record<string, string>;
