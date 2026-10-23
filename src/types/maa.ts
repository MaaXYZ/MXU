// MaaFramework 类型定义

import { loggers } from '@/utils/logger';

/** ADB 设备信息 */
export interface AdbDevice {
  name: string;
  adb_path: string;
  address: string;
  screencap_methods: string; // u64 作为字符串传递，避免 JS 精度丢失
  input_methods: string; // u64 作为字符串传递
  config: string;
}

/** Win32 窗口信息 */
export interface Win32Window {
  handle: number;
  class_name: string;
  window_name: string;
}

/** gamescope 实例（同一 display 上的截图节点 + libei 输入 socket） */
export interface GamescopeInstance {
  display_no: number;
  pipewire_node_id: number;
  eis_socket_path: string;
}

/** ADB 控制器配置 */
export interface AdbControllerConfig {
  type: 'Adb';
  adb_path: string;
  address: string;
  screencap_methods: string; // u64 作为字符串传递
  input_methods: string; // u64 作为字符串传递
  config: string;
  display_short_side?: number;
}

/** Win32 控制器配置 */
export interface Win32ControllerConfig {
  type: 'Win32';
  handle: number;
  screencap_method: number;
  mouse_method: number;
  keyboard_method: number;
  display_short_side?: number;
}

export interface CloudWebControllerConfig {
  type: 'CloudWeb';
  handle: number;
  display_short_side?: number;
}

/** macOS 原生窗口控制器配置 */
export interface MacOSControllerConfig {
  type: 'MacOS';
  handle: number;
  screencap_method: number;
  input_method: number;
  display_short_side?: number;
}

/** WlRoots 控制器配置 (Linux) */
export interface WlRootsControllerConfig {
  type: 'WlRoots';
  wlr_socket_path: string;
  use_win32_vk_code?: boolean;
}

/** Linux 原生控制器配置（截图：Wlr/PipeWire，输入：Wlr/UInput/Libei） */
export interface LinuxControllerConfig {
  type: 'Linux';
  screencap_method: number;
  input_method: number;
  pipewire_source?: 'Gamescope' | 'Portal';
  wlr_socket_path?: string;
  pw_socket_fd?: number;
  pw_node_id?: number;
  uinput_path?: string;
  uinput_screen_width?: number;
  uinput_screen_height?: number;
  eis_socket_path?: string;
  use_win32_vk_code?: boolean;
  display_short_side?: number;
}

/** PlayCover 控制器配置 (macOS) */
export interface PlayCoverControllerConfig {
  type: 'PlayCover';
  address: string;
  uuid?: string;
  display_short_side?: number;
}

/** Gamepad 控制器配置 */
export interface GamepadControllerConfig {
  type: 'Gamepad';
  handle: number;
  display_short_side?: number;
}

/** 控制器配置 */
export type ControllerConfig =
  | AdbControllerConfig
  | Win32ControllerConfig
  | CloudWebControllerConfig
  | MacOSControllerConfig
  | WlRootsControllerConfig
  | LinuxControllerConfig
  | PlayCoverControllerConfig
  | GamepadControllerConfig;

/** 连接状态 */
export type ConnectionStatus = 'Disconnected' | 'Connecting' | 'Connected' | { Failed: string };

/** 任务状态 */
export type TaskStatus = 'Pending' | 'Running' | 'Succeeded' | 'Failed';

/** MaaFramework 初始化状态 */
export interface MaaInitState {
  initialized: boolean;
  version: string | null;
  error: string | null;
}

/** 实例运行时信息 */
export interface InstanceRuntimeInfo {
  connectionStatus: ConnectionStatus;
  resourceLoaded: boolean;
  isRunning: boolean;
  currentTaskId: number | null;
}

/** Win32 截图方法 */
export const Win32ScreencapMethod = {
  None: 0n,
  GDI: 1n,
  FramePool: 1n << 1n,
  DXGI_DesktopDup: 1n << 2n,
  DXGI_DesktopDup_Window: 1n << 3n,
  PrintWindow: 1n << 4n,
  ScreenDC: 1n << 5n,
  Foreground: (1n << 3n) | (1n << 5n), // DXGI_DesktopDup_Window | ScreenDC
  Background: (1n << 1n) | (1n << 4n), // FramePool | PrintWindow
} as const;

/** Win32 输入方法 */
export const Win32InputMethod = {
  None: 0n,
  Seize: 1n,
  SendMessage: 1n << 1n,
  PostMessage: 1n << 2n,
  LegacyEvent: 1n << 3n,
  PostThreadMessage: 1n << 4n,
  SendMessageWithCursorPos: 1n << 5n,
  PostMessageWithCursorPos: 1n << 6n,
  SendMessageWithWindowPos: 1n << 7n,
  PostMessageWithWindowPos: 1n << 8n,
  Interception: 1n << 9n,
} as const;

/** Win32 截图方法名称映射 */
export const Win32ScreencapMethodNames: Record<string, bigint> = {
  GDI: Win32ScreencapMethod.GDI,
  FramePool: Win32ScreencapMethod.FramePool,
  DXGI_DesktopDup: Win32ScreencapMethod.DXGI_DesktopDup,
  DXGI_DesktopDup_Window: Win32ScreencapMethod.DXGI_DesktopDup_Window,
  PrintWindow: Win32ScreencapMethod.PrintWindow,
  ScreenDC: Win32ScreencapMethod.ScreenDC,
  Foreground: Win32ScreencapMethod.Foreground,
  Background: Win32ScreencapMethod.Background,
};

/** Win32 输入方法名称映射 */
export const Win32InputMethodNames: Record<string, bigint> = {
  Seize: Win32InputMethod.Seize,
  SendMessage: Win32InputMethod.SendMessage,
  PostMessage: Win32InputMethod.PostMessage,
  LegacyEvent: Win32InputMethod.LegacyEvent,
  PostThreadMessage: Win32InputMethod.PostThreadMessage,
  SendMessageWithCursorPos: Win32InputMethod.SendMessageWithCursorPos,
  PostMessageWithCursorPos: Win32InputMethod.PostMessageWithCursorPos,
  SendMessageWithWindowPos: Win32InputMethod.SendMessageWithWindowPos,
  PostMessageWithWindowPos: Win32InputMethod.PostMessageWithWindowPos,
  Interception: Win32InputMethod.Interception,
};

/** macOS 截图方法 */
export const MacOSScreencapMethod = {
  None: 0n,
  ScreenCaptureKit: 1n,
} as const;

/** macOS 输入方法 */
export const MacOSInputMethod = {
  None: 0n,
  GlobalEvent: 1n,
  PostToPid: 1n << 1n,
} as const;

/** macOS 截图方法名称映射 */
export const MacOSScreencapMethodNames: Record<string, bigint> = {
  ScreenCaptureKit: MacOSScreencapMethod.ScreenCaptureKit,
};

/** macOS 输入方法名称映射 */
export const MacOSInputMethodNames: Record<string, bigint> = {
  GlobalEvent: MacOSInputMethod.GlobalEvent,
  PostToPid: MacOSInputMethod.PostToPid,
};

/** 解析 Win32 截图方法名称，支持单个字符串或字符串数组（数组时按位或合并） */
export function parseWin32ScreencapMethod(name: string | string[]): number {
  if (Array.isArray(name)) {
    const combined = name.reduce<bigint>((acc, n) => {
      const method = Win32ScreencapMethodNames[n];
      return method !== undefined ? acc | method : acc;
    }, 0n);
    return combined !== 0n ? Number(combined) : Number(Win32ScreencapMethod.FramePool);
  }
  const method = Win32ScreencapMethodNames[name];
  if (method !== undefined) {
    return Number(method);
  }
  // 默认使用 FramePool
  return Number(Win32ScreencapMethod.FramePool);
}

/** 解析 Win32 输入方法名称 */
export function parseWin32InputMethod(name: string): number {
  const method = Win32InputMethodNames[name];
  if (method !== undefined) {
    return Number(method);
  }
  // 默认使用 Seize；遇到非合规值时记录警告
  loggers.config.warn('遇到非合规的 Win32 输入方法名称，已回退到默认值 Seize。', {
    name,
    fallback: 'Seize',
  });
  return Number(Win32InputMethod.Seize);
}

/** 解析 macOS 截图方法名称；协议未提供默认值时使用 ScreenCaptureKit */
export function parseMacOSScreencapMethod(name: string): number {
  const method = MacOSScreencapMethodNames[name];
  return Number(method ?? MacOSScreencapMethod.ScreenCaptureKit);
}

/** 解析 macOS 输入方法名称；协议未提供默认值时使用 GlobalEvent */
export function parseMacOSInputMethod(name: string): number {
  const method = MacOSInputMethodNames[name];
  return Number(method ?? MacOSInputMethod.GlobalEvent);
}

/** Linux 截图方法 */
export const LinuxScreencapMethod = {
  None: 0,
  Wlr: 1,
  PipeWire: 4,
} as const;

/** Linux 输入方法 */
export const LinuxInputMethod = {
  None: 0,
  Wlr: 1,
  UInput: 2,
  Libei: 4,
} as const;

/** Linux 截图方法名称映射 */
export const LinuxScreencapMethodNames: Record<string, number> = {
  Wlr: LinuxScreencapMethod.Wlr,
  PipeWire: LinuxScreencapMethod.PipeWire,
};

/** Linux 输入方法名称映射 */
export const LinuxInputMethodNames: Record<string, number> = {
  Wlr: LinuxInputMethod.Wlr,
  UInput: LinuxInputMethod.UInput,
  Libei: LinuxInputMethod.Libei,
};

/** 解析 Linux 截图方法名称；协议未提供默认值时使用 PipeWire */
export function parseLinuxScreencapMethod(name: string | undefined): number {
  if (!name) return LinuxScreencapMethod.PipeWire;
  return LinuxScreencapMethodNames[name] ?? LinuxScreencapMethod.PipeWire;
}

/** 解析 Linux 输入方法名称；协议未提供默认值时使用 Libei */
export function parseLinuxInputMethod(name: string | undefined): number {
  if (!name) return LinuxInputMethod.Libei;
  return LinuxInputMethodNames[name] ?? LinuxInputMethod.Libei;
}

/** Agent 配置（用于启动子进程） */
export interface AgentConfig {
  child_exec: string;
  child_args?: string[];
  identifier?: string;
  /** 连接超时时间（毫秒），-1 表示无限等待 */
  timeout?: number;
}

/** 任务配置 */
export interface TaskConfig {
  entry: string;
  pipeline_override: string;
  /** 对应的前端选中任务 ID（用于后端跟踪 per-task 状态） */
  selected_task_id?: string;
  /** interface 任务名（如 `SwitchTeam`），仅用于遥测埋点 */
  task_name?: string;
  /** 已脱敏的任务选项摘要，仅用于遥测埋点 */
  options?: Record<string, string>;
}

/** 当前 controller 描述（仅用于遥测埋点） */
export interface ControllerTelemetryInfo {
  name?: string;
  type?: string;
}
