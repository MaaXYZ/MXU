import type { ControllerItem, ControllerType, SavedDeviceInfo } from '@/types/interface';
import type { AdbDevice, ControllerConfig } from '@/types/maa';
import { hasValidUinputDimensions } from '@/utils/linuxUinput';
import {
  LinuxInputMethod,
  LinuxScreencapMethod,
  parseLinuxInputMethod,
  parseLinuxScreencapMethod,
  parseMacOSInputMethod,
  parseMacOSScreencapMethod,
  parseWin32InputMethod,
  parseWin32ScreencapMethod,
} from '@/types/maa';

export type DesktopWindowControllerType = Extract<ControllerType, 'Win32' | 'MacOS' | 'Gamepad'>;

/** 使用 MaaToolkit 桌面窗口发现流程的控制器类型。 */
export function isDesktopWindowControllerType(
  type: ControllerType | undefined,
): type is DesktopWindowControllerType {
  return type === 'Win32' || type === 'MacOS' || type === 'Gamepad';
}

/**
 * 返回 MaaToolkit 窗口发现所需的筛选条件。
 * PI V2 的 macOS 控制器只有 title_regex，不支持 Win32 的 class_regex。
 */
export function getDesktopWindowFilters(controller: ControllerItem | undefined): {
  classRegex?: string;
  titleRegex?: string;
} {
  if (controller?.type === 'MacOS') {
    return {
      classRegex: undefined,
      titleRegex: controller.macos?.title_regex,
    };
  }

  if (controller?.type === 'Win32') {
    return {
      classRegex: controller.win32?.class_regex,
      titleRegex: controller.win32?.window_regex,
    };
  }

  if (controller?.type === 'Gamepad') {
    return {
      classRegex: controller.gamepad?.class_regex,
      titleRegex: controller.gamepad?.window_regex,
    };
  }

  return {};
}

/** ADB 地址优先，兼容旧配置按名称匹配。 */
export function findMatchingAdbDevice(
  devices: readonly AdbDevice[],
  savedDevice: Pick<SavedDeviceInfo, 'adbDeviceAddress' | 'adbDeviceName'> | undefined,
  requireUnique = false,
): AdbDevice | undefined {
  const address = savedDevice?.adbDeviceAddress;
  // 名称保持原有的大小写和空白匹配语义，避免旧配置行为变化。
  const name = savedDevice?.adbDeviceName;
  const selectMatch = (matches: AdbDevice[]) =>
    matches.length > 0 && (!requireUnique || matches.length === 1) ? matches[0] : undefined;
  const addressMatches = address ? devices.filter((device) => device.address === address) : [];
  const addressMatch = selectMatch(addressMatches);
  if (addressMatch) return addressMatch;
  if (addressMatches.length > 1) {
    const namedMatches = name ? addressMatches.filter((device) => device.name === name) : [];
    return selectMatch(namedMatches) || (requireUnique ? undefined : addressMatches[0]);
  }

  const nameMatches = name ? devices.filter((device) => device.name === name) : [];
  return selectMatch(nameMatches);
}

/** 构建共享桌面窗口选择流程对应的运行时控制器配置。 */
export function buildDesktopWindowControllerConfig(
  controller: ControllerItem | undefined,
  handle: number,
): ControllerConfig | null {
  if (controller?.type === 'Win32') {
    return {
      type: 'Win32',
      handle,
      screencap_method: parseWin32ScreencapMethod(controller.win32?.screencap || ''),
      mouse_method: parseWin32InputMethod(controller.win32?.mouse || ''),
      keyboard_method: parseWin32InputMethod(controller.win32?.keyboard || ''),
      display_short_side: controller.display_short_side,
    };
  }

  if (controller?.type === 'MacOS') {
    return {
      type: 'MacOS',
      handle,
      screencap_method: parseMacOSScreencapMethod(controller.macos?.screencap || ''),
      input_method: parseMacOSInputMethod(controller.macos?.input || ''),
      display_short_side: controller.display_short_side,
    };
  }

  if (controller?.type === 'Gamepad') {
    return {
      type: 'Gamepad',
      handle,
      display_short_side: controller.display_short_side,
    };
  }

  return null;
}

const WORKSTATION_UNLOCK_REQUIREMENT: Record<ControllerType, boolean> = {
  Adb: false,
  Win32: true,
  MacOS: false,
  WlRoots: false,
  Linux: false,
  PlayCover: false,
  Gamepad: true,
};

/** Whether the controller depends on the interactive Windows desktop. */
export function requiresUnlockedWorkstation(controllerType: ControllerType): boolean {
  // Fail closed for unexpected runtime values loaded from interface.json.
  return WORKSTATION_UNLOCK_REQUIREMENT[controllerType] ?? true;
}

/** Linux 控制器发现需求描述。 */
export interface LinuxDiscoveryNeeds {
  /** 截图或输入使用 Wlr 时需要 wayland socket */
  needWlrSocket: boolean;
  /** 截图 PipeWire + Gamescope 源时需要 gamescope 节点 */
  needGamescopeNode: boolean;
  /** 输入 Libei 时需要 EIS socket */
  needEisSocket: boolean;
  /** 截图 PipeWire + Portal 源：无需前端发现，连接时后端打开门户 */
  isPortal: boolean;
}

/**
 * 计算 Linux 控制器在运行时需要发现哪些设备。
 */
export function getLinuxDiscoveryNeeds(
  controller: ControllerItem | undefined,
): LinuxDiscoveryNeeds {
  const linux = controller?.linux;
  const screencap = parseLinuxScreencapMethod(linux?.screencap);
  const input = parseLinuxInputMethod(linux?.input);
  const pipewireSource = linux?.pipewire_source ?? 'Gamescope';

  return {
    needWlrSocket: screencap === LinuxScreencapMethod.Wlr || input === LinuxInputMethod.Wlr,
    needGamescopeNode:
      screencap === LinuxScreencapMethod.PipeWire && pipewireSource === 'Gamescope',
    needEisSocket: input === LinuxInputMethod.Libei,
    isPortal: screencap === LinuxScreencapMethod.PipeWire && pipewireSource === 'Portal',
  };
}

/** 计算 Linux 控制器设备名称的输入（与 SavedDeviceInfo 的 Linux 字段兼容）。 */
export interface LinuxDeviceNameSource {
  wlrSocketPath?: string;
  gamescopeDisplayNo?: number;
}

/**
 * 计算 Linux 控制器的设备显示名：有什么设备输出什么设备，多设备用 ` + ` 拼接、同源去重。
 *
 * 映射规则：
 * - 截图 wlr → `wayland-<n>`；pipewire(gamescope) → `gamescope-<n>`；pipewire(portal) → 传入的 portal 标签
 * - 输入 wlr → `wayland-<n>`；libei → `gamescope-<n>`（EIS 所属的 gamescope 实例）；uinput → `/dev/uinput`
 *
 * 仅按当前配置实际需要的设备取字段：不依赖 gamescope 的配置（如 Portal+Uinput）会忽略
 * 残留的 savedDevice.gamescopeDisplayNo，避免显示过期的 `gamescope-<n>`。
 */
export function getLinuxDeviceName(
  controller: ControllerItem | undefined,
  source: LinuxDeviceNameSource,
  labels: { portal: string; linux: string } = { portal: 'portal', linux: 'Linux' },
): string {
  if (controller?.type !== 'Linux') return labels.linux;

  const linux = controller.linux;
  const screencap = parseLinuxScreencapMethod(linux?.screencap);
  const input = parseLinuxInputMethod(linux?.input);
  const pipewireSource = linux?.pipewire_source ?? 'Gamescope';
  const { wlrSocketPath, gamescopeDisplayNo } = source;
  const tokens: string[] = [];

  // 截图设备（在前）
  if (screencap === LinuxScreencapMethod.Wlr) {
    if (wlrSocketPath) tokens.push(linuxWaylandToken(wlrSocketPath));
  } else if (screencap === LinuxScreencapMethod.PipeWire) {
    if (pipewireSource === 'Portal') {
      tokens.push(labels.portal);
    } else if (gamescopeDisplayNo !== undefined) {
      tokens.push(`gamescope-${gamescopeDisplayNo}`);
    }
  }

  // 输入设备（在后）
  if (input === LinuxInputMethod.Wlr) {
    if (wlrSocketPath) tokens.push(linuxWaylandToken(wlrSocketPath));
  } else if (input === LinuxInputMethod.Libei) {
    if (gamescopeDisplayNo !== undefined) tokens.push(`gamescope-${gamescopeDisplayNo}`);
  } else if (input === LinuxInputMethod.UInput) {
    tokens.push(UINPUT_DEVICE);
  }

  // 同源去重（gamescope 同时服务截图和 libei 输入时只显示一次）
  const unique = Array.from(new Set(tokens));
  return unique.length > 0 ? unique.join(' + ') : labels.linux;
}

/** 设备命名时 uinput 的字面路径。 */
const UINPUT_DEVICE = '/dev/uinput';

/**
 * 将 wlr/wayland socket 路径/名称规范化为 `wayland-<n>` 显示名。
 *
 * 支持三种常见形态：`wayland-1`、`/run/user/1000/wayland-0`、`wayland-1.sock`。
 * 解析不出尾号时回退为 basename。
 */
export function linuxWaylandToken(wlrSocketPath: string): string {
  const base = wlrSocketPath.split('/').pop() ?? wlrSocketPath;
  const cleaned = base
    .replace(/\.sock$/, '')
    .replace(/\.lock$/, '')
    .replace(/\.\d+$/, '');
  const m = cleaned.match(/(\d+)$/);
  return m ? `wayland-${m[1]}` : base;
}

/**
 * 构建 Linux 控制器运行时配置。
 *
 * portal 截图时无需传入 pw 节点信息：后端会在 connect 时打开 ScreenCast 门户并填充 FD/节点。
 */
export function buildLinuxControllerConfig(
  controller: ControllerItem | undefined,
  discovery: {
    wlrSocketPath?: string;
    pwNodeId?: number;
    eisSocketPath?: string;
    uinputScreenWidth?: number;
    uinputScreenHeight?: number;
  },
  uinputDimensionsError = 'UINPUT_SCREEN_SIZE_REQUIRED',
): ControllerConfig {
  const linux = controller?.linux;
  if (
    parseLinuxInputMethod(linux?.input) === LinuxInputMethod.UInput &&
    !hasValidUinputDimensions(discovery.uinputScreenWidth, discovery.uinputScreenHeight)
  ) {
    throw new Error(uinputDimensionsError);
  }

  return {
    type: 'Linux',
    screencap_method: parseLinuxScreencapMethod(linux?.screencap),
    input_method: parseLinuxInputMethod(linux?.input),
    pipewire_source: linux?.pipewire_source ?? 'Gamescope',
    wlr_socket_path: discovery.wlrSocketPath,
    pw_node_id: discovery.pwNodeId,
    eis_socket_path: discovery.eisSocketPath,
    uinput_screen_width: discovery.uinputScreenWidth,
    uinput_screen_height: discovery.uinputScreenHeight,
    use_win32_vk_code: linux?.use_win32_vk_code ?? false,
    display_short_side: controller?.display_short_side,
  };
}
