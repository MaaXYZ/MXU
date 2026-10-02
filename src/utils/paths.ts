/**
 * 路径工具函数
 * 统一管理应用数据目录的获取
 */

// 目录常量
const DIR_DEBUG = 'debug';
const DIR_CONFIG = 'config';
const DIR_CACHE = 'cache';

// 检测是否在 Tauri 环境中
export const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
};

// 缓存数据目录路径
let cachedDataPath: string | null = null;

/**
 * 获取应用数据目录
 * - macOS: ~/Library/Application Support/MXU/
 * - Linux: $XDG_DATA_HOME/{项目名}，默认 ~/.local/share/{项目名}
 * - Windows: exe 所在目录
 *
 * 结果会被缓存，多次调用不会重复请求
 */
export async function getDataPath(): Promise<string> {
  if (cachedDataPath) return cachedDataPath;

  if (!isTauri()) {
    cachedDataPath = '.';
    return cachedDataPath;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    cachedDataPath = await invoke<string>('get_data_dir');
    return cachedDataPath;
  } catch {
    cachedDataPath = '.';
    return cachedDataPath;
  }
}

/**
 * 规范化路径分隔符并移除尾部斜杠
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * 拼接路径
 */
export function joinPath(base: string, ...parts: string[]): string {
  const normalizedBase = normalizePath(base);
  const normalizedParts = parts.map((p) => p.replace(/^\/+|\/+$/g, ''));
  return [normalizedBase, ...normalizedParts].filter(Boolean).join('/');
}

// ============ 常用目录快捷获取 ============

/**
 * 获取日志目录路径 (debug)
 */
export async function getDebugDir(): Promise<string> {
  const base = await getDataPath();
  return joinPath(base, DIR_DEBUG);
}

/**
 * 获取配置目录路径 (config)
 */
export async function getConfigDir(): Promise<string> {
  const base = await getDataPath();
  return joinPath(base, DIR_CONFIG);
}

/**
 * 获取缓存目录路径 (cache)
 */
export async function getCacheDir(): Promise<string> {
  const base = await getDataPath();
  return joinPath(base, DIR_CACHE);
}

/**
 * 从完整路径中提取文件名（进程名）
 */
export function getProcessNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * 打开指定目录（仅 Tauri 环境有效）
 */
export async function openDirectory(dirPath: string): Promise<void> {
  if (!isTauri()) return;
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(dirPath);
}
