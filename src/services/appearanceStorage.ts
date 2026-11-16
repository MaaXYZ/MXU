/**
 * WebUI 本地设置存储服务
 *
 * 在 WebUI（浏览器）模式下，外观和布局设置独立于 MxuConfig 存储在 localStorage 中，
 * 避免与 Tauri 桌面端互相覆盖。
 */

import type { AccentColor, CustomAccent } from '@/themes/types';
import type { Theme, Language } from '@/stores/types';
import type { WindowSize, WindowPosition, ScreenshotFrameRate } from '@/types/config';
import { normalizeBuiltinSkinId, type BuiltinSkinId } from '@/skins/types';
import { loggers } from '@/utils/logger';

const log = loggers.config;

// ── 外观 ──────────────────────────────────────────────

const APPEARANCE_KEY = 'mxu-webui-appearance';

export interface WebUIAppearance {
  theme: Theme;
  accentColor: AccentColor;
  skinId: BuiltinSkinId;
  skinReducedMotion: boolean;
  language: Language;
  backgroundImage?: string;
  backgroundOpacity: number;
  customAccents: CustomAccent[];
}

const defaultAppearance: WebUIAppearance = {
  theme: 'system',
  accentColor: 'emerald',
  skinId: 'default',
  skinReducedMotion: false,
  language: 'system',
  backgroundOpacity: 50,
  customAccents: [],
};

export function loadWebUIAppearance(): WebUIAppearance | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const appearance = parsed as Partial<WebUIAppearance>;
    return {
      ...defaultAppearance,
      ...appearance,
      skinId: normalizeBuiltinSkinId(appearance.skinId),
      skinReducedMotion: appearance.skinReducedMotion === true,
    };
  } catch {
    log.warn('WebUI 外观设置加载失败，将使用默认值');
    return null;
  }
}

export function saveWebUIAppearance(appearance: WebUIAppearance): void {
  try {
    localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({
        ...appearance,
        skinId: normalizeBuiltinSkinId(appearance.skinId),
        skinReducedMotion: appearance.skinReducedMotion === true,
      }),
    );
  } catch {
    log.warn('WebUI 外观设置保存失败');
  }
}

export function patchWebUIAppearance(patch: Partial<WebUIAppearance>): void {
  // The first local preference starts from the appearance already loaded from the backend.
  // Missing fields in older configs must not replace the local defaults with undefined.
  const current = loadWebUIAppearance() || {
    ...defaultAppearance,
    ...Object.fromEntries(
      Object.entries(getBackendAppearance()).filter(([, value]) => value !== undefined),
    ),
  };
  saveWebUIAppearance({ ...current, ...patch });
}

// ── 布局 ──────────────────────────────────────────────

const LAYOUT_KEY = 'mxu-webui-layout';

export interface WebUILayout {
  windowSize?: WindowSize;
  windowPosition?: WindowPosition;
  sidePanelExpanded: boolean;
  rightPanelWidth: number;
  rightPanelCollapsed: boolean;
  addTaskPanelHeight: number;
  connectionPanelExpanded: boolean;
  screenshotPanelExpanded: boolean;
  showOptionPreview: boolean;
  screenshotFrameRate: ScreenshotFrameRate;
}

const defaultLayout: WebUILayout = {
  sidePanelExpanded: true,
  rightPanelWidth: 320,
  rightPanelCollapsed: false,
  addTaskPanelHeight: 192,
  connectionPanelExpanded: true,
  screenshotPanelExpanded: true,
  showOptionPreview: true,
  screenshotFrameRate: '1',
};

export function loadWebUILayout(): WebUILayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    return { ...defaultLayout, ...JSON.parse(raw) };
  } catch {
    log.warn('WebUI 布局设置加载失败，将使用默认值');
    return null;
  }
}

export function saveWebUILayout(layout: WebUILayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    log.warn('WebUI 布局设置保存失败');
  }
}

export function patchWebUILayout(patch: Partial<WebUILayout>): void {
  const current = loadWebUILayout() || defaultLayout;
  saveWebUILayout({ ...current, ...patch });
}

// ── 后端缓存 ──────────────────────────────────────────

/**
 * 缓存后端 config 中的外观 & 布局设置。
 * generateConfig 序列化时使用此缓存，避免 WebUI 本地偏好回写覆盖桌面端设置。
 */
let _backendAppearance: Partial<WebUIAppearance> = {
  skinId: 'default',
  skinReducedMotion: false,
};
let _backendLayout: Partial<WebUILayout> = {};

export function cacheBackendAppearance(
  settings: {
    theme?: Theme;
    accentColor?: AccentColor;
    skinId?: unknown;
    skinReducedMotion?: unknown;
    language?: Language;
    backgroundImage?: string;
    backgroundOpacity?: number;
  },
  customAccents?: CustomAccent[],
): void {
  _backendAppearance = {
    theme: settings.theme as Theme,
    accentColor: settings.accentColor as AccentColor,
    skinId: normalizeBuiltinSkinId(settings.skinId),
    skinReducedMotion: settings.skinReducedMotion === true,
    language: settings.language as Language,
    backgroundImage: settings.backgroundImage,
    backgroundOpacity: settings.backgroundOpacity,
    customAccents: customAccents || [],
  };
}

export function getBackendAppearance(): Partial<WebUIAppearance> {
  return _backendAppearance;
}

export function cacheBackendLayout(settings: {
  windowSize?: WindowSize;
  windowPosition?: WindowPosition;
  sidePanelExpanded?: boolean;
  rightPanelWidth?: number;
  rightPanelCollapsed?: boolean;
  addTaskPanelHeight?: number;
  connectionPanelExpanded?: boolean;
  screenshotPanelExpanded?: boolean;
  showOptionPreview?: boolean;
  screenshotFrameRate?: ScreenshotFrameRate;
}): void {
  _backendLayout = { ...settings } as Partial<WebUILayout>;
}

export function getBackendLayout(): Partial<WebUILayout> {
  return _backendLayout;
}
