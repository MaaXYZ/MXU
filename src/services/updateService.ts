// MirrorChyan 更新检查服务
// API 文档: https://github.com/MirrorChyan/docs

import type { DownloadProgress, UpdateInfo } from '@/stores/appStore';
import { useAppStore } from '@/stores/appStore';
import type { ProxySettings, UpdateChannel } from '@/types/config';
import { loggers } from '@/utils/logger';
import { getCacheDir, joinPath } from '@/utils/paths';
import { invoke } from '@tauri-apps/api/core';
import { dirname } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import * as semver from 'semver';

import { backupConfigBeforeUpdate } from './configService';
import { downloadWithProxy } from './proxyService';

const log = loggers.app;

// 下载状态标志，防止重复检查或下载
let isDownloading = false;
// 下载是否被用户主动取消
let downloadCancelled = false;
// 安装互斥锁，防止并发 installUpdate 导致目录竞争
let isInstalling = false;

/**
 * 将文件移动到 cache/old 文件夹（调用 Rust 端统一实现）
 */
async function moveToOldFolder(filePath: string): Promise<void> {
  try {
    await invoke('move_file_to_old', { filePath });
    log.info(`已移动到 cache/old: ${filePath}`);
  } catch (error) {
    log.warn(`移动文件到 cache/old 失败: ${filePath}`, error);
  }
}

/**
 * 检查当前是否正在下载
 */
export function getIsDownloading(): boolean {
  return isDownloading;
}

/**
 * 取消当前正在进行的下载
 * @returns 是否成功取消（如果没有正在进行的下载则返回 false）
 */
export async function cancelDownload(): Promise<boolean> {
  if (!isDownloading || !currentDownloadPath) {
    return false;
  }

  log.info('取消下载...');

  // 标记为用户主动取消，让 downloadUpdate 知道不需要再重置状态
  downloadCancelled = true;

  try {
    // 调用 Rust 后端设置取消标志
    await invoke('cancel_download', { savePath: currentDownloadPath });
  } catch (error) {
    log.warn('取消下载失败:', error);
  }

  // 立即重置状态，允许新的下载开始
  isDownloading = false;
  currentDownloadPath = null;
  return true;
}

const MIRRORCHYAN_API_BASES = [
  'https://mirrorchyan.com/api/resources',
  'https://mirrorchyan.net/api/resources',
];

// MirrorChyan API 错误码定义
// 参考: https://github.com/MirrorChyan/docs/blob/main/ErrorCode.md
export const MIRRORCHYAN_ERROR_CODES = {
  // 业务逻辑错误 (code > 0)
  INVALID_PARAMS: 1001, // 参数不正确
  KEY_EXPIRED: 7001, // CDK 已过期
  KEY_INVALID: 7002, // CDK 错误
  RESOURCE_QUOTA_EXHAUSTED: 7003, // CDK 今日下载次数已达上限
  KEY_MISMATCHED: 7004, // CDK 类型和待下载的资源不匹配
  KEY_BLOCKED: 7005, // CDK 已被封禁
  RESOURCE_NOT_FOUND: 8001, // 对应架构和系统下的资源不存在
  INVALID_OS: 8002, // 错误的系统参数
  INVALID_ARCH: 8003, // 错误的架构参数
  INVALID_CHANNEL: 8004, // 错误的更新通道参数
  UNDIVIDED: 1, // 未区分的业务错误
} as const;

// MirrorChyan API 响应类型
interface MirrorChyanApiResponse {
  code: number;
  msg: string;
  data?: {
    version_name: string;
    version_number?: number;
    url?: string;
    sha256?: string;
    release_note?: string;
    custom_data?: string;
    update_type?: 'incremental' | 'full';
    channel?: string;
    filesize?: number;
    cdk_expired_time?: number;
    os?: string;
    arch?: string;
  };
}

// GitHub Release API 响应类型
interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

// 获取操作系统类型（以后端真实 OS 为准；后端未知时回退到浏览器平台，仅纯前端 dev 预览）
function getOS(): string {
  const os = useAppStore.getState().backendOS;
  if (os === 'windows') return 'windows';
  if (os === 'macos') return 'darwin';
  if (os === 'linux') return 'linux';
  // 后端 OS 未知（纯前端 dev 预览，无后端）时回退到浏览器平台
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('linux')) return 'linux';
  return '';
}

let cachedArchPromise: Promise<string> | null = null;

/**
 * 获取系统架构（优先使用后端真实值）
 *
 * 后端返回值通常是 `x86_64` / `aarch64`，这里统一映射为更新逻辑使用的
 * `amd64` / `arm64`，避免 Apple Silicon 被误判为 x86。
 *
 * 优先读 store 中已缓存的后端架构（interfaceLoader 在 Tauri/HTTP 两条路径均会填充，
 * 使 WebUI 远程也能拿到后端真实架构）；store 尚未填充时回退到直接 invoke（仅 Tauri 可用），
 * 再失败则回退 amd64。
 */
async function getArch(): Promise<string> {
  if (!cachedArchPromise) {
    cachedArchPromise = (async () => {
      let raw = useAppStore.getState().backendArch;
      if (!raw) raw = await invoke<string>('get_arch');
      const normalized = raw.toLowerCase();
      if (normalized === 'x86_64' || normalized === 'x64' || normalized === 'amd64') {
        return 'amd64';
      }
      if (normalized === 'aarch64' || normalized === 'arm64') {
        return 'arm64';
      }
      return normalized;
    })().catch((error) => {
      log.warn('获取系统架构失败，回退到 amd64:', error);
      return 'amd64';
    });
  }

  return cachedArchPromise;
}

/**
 * 从 URL 中提取文件名
 * 支持格式：
 * - 普通 URL: https://example.com/path/to/file.exe
 * - 带查询参数的 URL: https://example.com/path/to/file.dmg?token=xxx
 */
function extractFilenameFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return undefined;

    const lastSegment = segments[segments.length - 1];
    // 解码 URL 编码的文件名
    const filename = decodeURIComponent(lastSegment);

    // 确保文件名有扩展名
    if (filename && filename.includes('.')) {
      return filename;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// 获取 OS 的常见别名（用于匹配文件名）
function getOSAliases(): string[] {
  const os = getOS();
  if (os === 'windows') return ['win', 'windows', 'win32', 'win64'];
  if (os === 'darwin') return ['macos', 'mac', 'darwin', 'osx'];
  if (os === 'linux') return ['linux'];
  return [];
}

// 获取架构的常见别名（用于匹配文件名）
function getArchAliases(arch: string): string[] {
  if (arch === 'amd64') return ['x86_64', 'x64', 'amd64', 'x86-64'];
  if (arch === 'arm64') return ['aarch64', 'arm64'];
  return [arch];
}

// 构建 User-Agent 字符串
async function buildUserAgent(): Promise<string> {
  const version = typeof __MXU_VERSION__ !== 'undefined' ? __MXU_VERSION__ : 'unknown';
  const os = getOS();
  const arch = await getArch();

  // 构建平台信息字符串
  let platformInfo = '';
  if (os === 'windows') {
    platformInfo = 'Windows NT 10.0; Win64; x64';
  } else if (os === 'darwin') {
    platformInfo = 'Macintosh; Intel Mac OS X';
  } else if (os === 'linux') {
    platformInfo = 'X11; Linux x86_64';
  }

  // 格式: MXU/版本号 (平台信息) Tauri/2.0
  return `MXU/${version} (${platformInfo}; ${arch}) Tauri/2.0`;
}

export interface CheckUpdateOptions {
  resourceId: string; // mirrorchyan_rid
  currentVersion: string; // 当前版本
  cdk?: string; // MirrorChyan CDK
  channel?: UpdateChannel; // 更新频道
  userAgent?: string; // 客户端标识
}

/**
 * 向单个 API 基础 URL 发送更新检查请求
 */
async function fetchUpdateFromBase(
  apiBase: string,
  resourceId: string,
  params: URLSearchParams,
): Promise<MirrorChyanApiResponse> {
  const url = `${apiBase}/${resourceId}/latest?${params.toString()}`;
  const response = await tauriFetch(url, {
    headers: {
      'User-Agent': await buildUserAgent(),
    },
  });
  return await response.json();
}

/**
 * 检查更新
 * @returns UpdateInfo 或 null（检查失败时或正在下载时）
 */
export async function checkUpdate(options: CheckUpdateOptions): Promise<UpdateInfo | null> {
  // 正在下载时不允许检查更新
  if (isDownloading) {
    log.info('正在下载更新，跳过检查更新');
    return null;
  }

  const { resourceId, currentVersion, cdk, channel = 'stable', userAgent = 'MXU' } = options;

  if (!resourceId) {
    log.warn('未配置 mirrorchyan_rid，跳过更新检查');
    return null;
  }

  const params = new URLSearchParams();
  params.set('current_version', currentVersion);
  params.set('user_agent', userAgent);
  params.set('channel', channel);

  // 添加系统信息
  const os = getOS();
  const arch = await getArch();
  if (os) params.set('os', os);
  if (arch) params.set('arch', arch);

  // CDK 是可选的，无 CDK 时也可以检查版本（但无法获取下载链接）
  if (cdk) {
    params.set('cdk', cdk);
  }

  log.info(`检查更新: ${resourceId}, 当前版本: ${currentVersion}, 频道: ${channel}`);

  let data: MirrorChyanApiResponse | null = null;
  let lastError: unknown = null;

  // 依次尝试主站和备用站
  for (let i = 0; i < MIRRORCHYAN_API_BASES.length; i++) {
    const apiBase = MIRRORCHYAN_API_BASES[i];
    try {
      data = await fetchUpdateFromBase(apiBase, resourceId, params);
      // 请求成功且 code 为 0，直接使用结果
      if (data.code === 0) {
        break;
      }
      // code 非 0 视为 API 层面的错误，尝试备用站
      log.warn(`${apiBase} 返回错误: code=${data.code}, msg=${data.msg}，尝试备用站...`);
      lastError = new Error(`API error: code=${data.code}, msg=${data.msg}`);
    } catch (error) {
      log.warn(`${apiBase} 请求失败:`, error);
      lastError = error;
      // 网络错误，继续尝试备用站
    }
  }

  // 所有站点都失败或返回错误
  if (!data || data.code !== 0) {
    if (data && data.code !== 0) {
      log.warn(`更新检查返回错误: code=${data.code}, msg=${data.msg}`);
      // code 非 0 但仍可能有版本信息，根据版本比较判断是否有更新
      if (data.data?.version_name) {
        const hasUpdate = compareVersions(data.data.version_name, currentVersion) > 0;
        log.info(
          `更新检查完成（带错误码）: 最新版本=${data.data.version_name}, 有更新=${hasUpdate}`,
        );
        return {
          hasUpdate,
          versionName: data.data.version_name,
          releaseNote: data.data.release_note || '',
          channel: data.data.channel,
          fileSize: data.data.filesize,
          updateType: data.data.update_type,
          // 注意：code != 0 时没有下载链接
          errorCode: data.code,
          errorMessage: data.msg,
        };
      }
      // 没有版本信息但有错误码，仍然返回错误信息
      return {
        hasUpdate: false,
        versionName: '',
        releaseNote: '',
        errorCode: data.code,
        errorMessage: data.msg,
      };
    } else {
      log.error('检查更新失败:', lastError);
    }
    return null;
  }

  if (!data.data) {
    log.warn('更新检查响应缺少 data 字段');
    return null;
  }

  const {
    version_name,
    url: downloadUrl,
    release_note,
    update_type,
    channel: respChannel,
    filesize,
  } = data.data;

  // 比较版本号判断是否有更新
  const hasUpdate = compareVersions(version_name, currentVersion) > 0;

  log.info(`更新检查完成: 最新版本=${version_name}, 有更新=${hasUpdate}`);

  // 从下载 URL 中提取文件名
  const filename = downloadUrl ? extractFilenameFromUrl(downloadUrl) : undefined;

  return {
    hasUpdate,
    versionName: version_name,
    releaseNote: release_note || '',
    downloadUrl,
    updateType: update_type,
    channel: respChannel,
    fileSize: filesize,
    filename,
    downloadSource: downloadUrl ? 'mirrorchyan' : undefined,
  };
}

/**
 * 判断是否为非正式版本（不进行自动更新）
 * 非正式版本定义：
 * - 版本号为 "DEBUG_VERSION"
 * - 版本号小于 "1.0.0"
 * - 版本号包含预发布标签，且不是 beta 或 rc（如 v2.0.2-ci.123、v1.0.0-alpha.1）
 */
export function isDebugVersion(version: string | undefined): boolean {
  if (!version) return false;
  if (version === 'DEBUG_VERSION') return true;

  const normalized = version.replace(/^v/i, '');

  // 优先尝试完整解析（保留预发布标签如 -ci.123、-beta.1）
  const parsed = semver.parse(normalized);
  if (parsed) {
    if (semver.lt(parsed, '1.0.0')) return true;
    if (parsed.prerelease.length > 0) {
      const UPDATEABLE_TAGS = ['beta', 'rc'];
      const isUpdateable = parsed.prerelease.some(
        (tag) => typeof tag === 'string' && UPDATEABLE_TAGS.includes(tag),
      );
      return !isUpdateable;
    }
    return false;
  }

  // 回退到 coerce（处理非标准版本号，会丢失预发布标签）
  const coerced = semver.coerce(normalized);
  if (!coerced) return false;

  return semver.lt(coerced, '1.0.0');
}

/**
 * 比较版本号（使用 semver 库处理预发布版本）
 * @returns 正数表示 v1 > v2，负数表示 v1 < v2，0 表示相等
 */
function compareVersions(v1: string, v2: string): number {
  // 移除 v 前缀
  const normalize = (v: string) => v.replace(/^v/i, '');

  const normalized1 = normalize(v1);
  const normalized2 = normalize(v2);

  // 优先尝试直接解析为有效的 semver 版本（保留预发布标签如 -beta.1）
  const valid1 = semver.valid(normalized1);
  const valid2 = semver.valid(normalized2);

  if (valid1 && valid2) {
    // 两个都是有效的 semver 版本，直接比较
    // semver 规范：1.6.0 > 1.6.0-beta.1（正式版大于预发布版）
    return semver.compare(valid1, valid2);
  }

  // 如果有一个不是有效的 semver，尝试用 coerce 解析（会丢失预发布标签）
  const coerced1 = valid1 || semver.coerce(normalized1)?.version;
  const coerced2 = valid2 || semver.coerce(normalized2)?.version;

  if (coerced1 && coerced2) {
    return semver.compare(coerced1, coerced2);
  }

  // 如果 semver 完全无法解析，回退到字符串比较
  return normalized1.localeCompare(normalized2);
}

/**
 * 打开 MirrorChyan 网站（带来源参数和版本号）
 * 使用系统默认浏览器打开
 */
export function openMirrorChyanWebsite(source?: string) {
  let url = 'https://mirrorchyan.com';
  if (source) {
    url += `?source=${encodeURIComponent(source)}`;
  }
  openUrl(url).catch((err) => {
    log.error('Failed to open URL:', err);
  });
}

/**
 * 从 GitHub URL 提取 owner 和 repo
 * 支持格式: https://github.com/owner/repo 或 https://github.com/owner/repo.git
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * 根据版本号获取 GitHub Release
 * 在 releases 列表中查找 tag_name 匹配的 release（支持带/不带 v 前缀）
 */
async function getGitHubReleaseByVersion(
  owner: string,
  repo: string,
  targetVersion: string,
  githubPat?: string,
  proxyUrl?: string,
): Promise<GitHubRelease | null> {
  try {
    return await invoke<GitHubRelease | null>('get_github_release_by_version', {
      owner,
      repo,
      targetVersion,
      githubPat,
      proxyUrl: proxyUrl,
    });
  } catch (error) {
    log.error('获取 GitHub Release 失败:', error);
    return null;
  }
}

/**
 * 获取直接下载链接的文件扩展名列表
 * Windows 只尝试 .zip，Linux/macOS 尝试多种格式
 */
function getDownloadExtensions(): string[] {
  const os = getOS();
  if (os === 'windows') {
    return ['.zip', '.exe'];
  } else if (os === 'linux') {
    return ['.zip', '.tar.gz'];
  } else if (os === 'darwin') {
    return ['.zip', '.tar.gz', '.dmg'];
  } else {
    return ['.zip'];
  }
}

/**
 * 获取 OS 名称用于直接下载链接（与 release 文件名匹配的格式）
 */
function getOSForDownload(): string {
  const os = getOS();
  if (os === 'windows') return 'win';
  if (os === 'darwin') return 'macos';
  return os; // linux
}

/**
 * 获取架构名称用于直接下载链接（与 release 文件名匹配的格式）
 */
function getArchForDownload(arch: string): string {
  if (arch === 'amd64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  return arch;
}

/**
 * 构建直接下载链接
 * 格式:
 * https://github.com/{owner}/{repo}/releases/download/v{version}/{项目名}-{os}-{arch}-v{version}.{ext}
 */
function buildDirectDownloadUrl(
  owner: string,
  repo: string,
  projectName: string,
  version: string,
  extension: string,
  arch: string,
): string {
  const os = getOSForDownload();
  const downloadArch = getArchForDownload(arch);
  // 确保版本号有 v 前缀
  const versionTag = version.startsWith('v') ? version : `v${version}`;
  const filename = `${projectName}-${os}-${downloadArch}-${versionTag}${extension}`;
  return `https://github.com/${owner}/${repo}/releases/download/${versionTag}/${filename}`;
}

/**
 * 尝试直接下载链接（HEAD 请求检查是否存在）
 * 依次尝试多种文件扩展名，返回第一个存在的链接
 */
async function tryDirectDownloadUrls(
  owner: string,
  repo: string,
  projectName: string,
  version: string,
  proxyUrl?: string,
): Promise<{ url: string; filename: string } | null> {
  const extensions = getDownloadExtensions();
  const arch = await getArch();

  for (const ext of extensions) {
    const url = buildDirectDownloadUrl(owner, repo, projectName, version, ext, arch);
    const os = getOSForDownload();
    const downloadArch = getArchForDownload(arch);
    const versionTag = version.startsWith('v') ? version : `v${version}`;
    const filename = `${projectName}-${os}-${downloadArch}-${versionTag}${ext}`;

    try {
      log.info(`尝试直接下载链接: ${url}`);
      const status = await invoke<number>('probe_download_url', { url, proxyUrl });

      if (status >= 200 && status < 300) {
        log.info(`直接下载链接可用: ${filename}`);
        return { url, filename };
      }
      log.info(`直接下载链接不存在 (${status}): ${filename}`);
    } catch (error) {
      log.warn(`检查直接下载链接失败: ${filename}`, error);
    }
  }

  return null;
}

/**
 * 根据 OS 和架构匹配合适的 GitHub Asset
 * 优先匹配 OS + 架构，多个匹配时优先选择名字带 mxu 的，否则选体积最大的
 */
async function matchGitHubAsset(assets: GitHubAsset[]): Promise<GitHubAsset | null> {
  const osAliases = getOSAliases();
  const arch = await getArch();
  const archAliases = getArchAliases(arch);

  // 先找出所有匹配 OS + 架构的 assets
  const candidates: GitHubAsset[] = [];

  for (const asset of assets) {
    const name = asset.name.toLowerCase();

    // 检查 OS 匹配
    const osMatch = osAliases.some((alias) => name.includes(alias.toLowerCase()));
    if (!osMatch) continue;

    // 检查架构匹配
    const archMatch = archAliases.some((alias) => name.includes(alias.toLowerCase()));
    if (!archMatch) continue;

    candidates.push(asset);
  }

  if (candidates.length === 0) {
    return null;
  }

  // 如果只有一个匹配，直接返回
  if (candidates.length === 1) {
    return candidates[0];
  }

  // 多个匹配时，优先选择名字带 "mxu" 的
  const mxuCandidate = candidates.find((asset) => asset.name.toLowerCase().includes('-mxu'));
  if (mxuCandidate) {
    log.info(`多个匹配，选择带 mxu 的文件: ${mxuCandidate.name}`);
    return mxuCandidate;
  }

  // 没有 mxu 的，选择体积最大的
  const largest = candidates.reduce((max, asset) => (asset.size > max.size ? asset : max));
  log.info(`多个匹配，选择体积最大的文件: ${largest.name} (${largest.size} bytes)`);
  return largest;
}

export interface GetGitHubDownloadUrlOptions {
  githubUrl: string;
  targetVersion: string; // Mirror酱返回的目标版本号
  githubPat?: string; // GitHub Personal Access Token (支持 classic 和 fine-grained)
  projectName?: string; // 项目名称，用于拼接直接下载链接（来自 interface.name）
  proxyUrl?: string; // 代理 URL，用于 GitHub API 请求和直接下载链接探测
}

/**
 * 获取 GitHub 下载链接
 * 根据 Mirror酱返回的版本号在 GitHub releases 中查找对应的 release
 * 如果 API 请求失败，会尝试直接拼接下载链接
 * @returns 下载链接和文件大小，或 null（失败时）
 */
export async function getGitHubDownloadUrl(
  options: GetGitHubDownloadUrlOptions,
): Promise<{ url: string; size: number; filename: string } | null> {
  const { githubUrl, targetVersion, githubPat, projectName, proxyUrl } = options;
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed) {
    log.warn('无法解析 GitHub URL:', githubUrl);
    return null;
  }

  const { owner, repo } = parsed;

  // 根据 Mirror酱返回的版本号查找对应的 release（传递 PAT 和 proxyUrl）
  const release = await getGitHubReleaseByVersion(owner, repo, targetVersion, githubPat, proxyUrl);

  if (release) {
    // API 请求成功，使用 assets 匹配
    const asset = await matchGitHubAsset(release.assets);
    if (asset) {
      log.info(`匹配到 GitHub 下载文件: ${asset.name}`);
      return {
        url: asset.browser_download_url,
        size: asset.size,
        filename: asset.name,
      };
    }
    log.warn('未找到匹配当前系统的下载文件');
  } else {
    log.warn('GitHub API 请求失败，尝试直接拼接下载链接');
  }

  // API 失败或未匹配到 asset，尝试直接拼接下载链接
  if (projectName) {
    const directResult = await tryDirectDownloadUrls(
      owner,
      repo,
      projectName,
      targetVersion,
      proxyUrl,
    );
    if (directResult) {
      log.info(`使用直接下载链接: ${directResult.filename}`);
      return {
        url: directResult.url,
        size: 0, // 直接链接无法获取文件大小
        filename: directResult.filename,
      };
    }
    log.warn('直接下载链接也不可用');
  } else {
    log.warn('未提供项目名称，无法尝试直接下载链接');
  }

  return null;
}

interface DownloadUpdateOptions {
  url: string;
  savePath: string;
  totalSize?: number;
  onProgress?: (progress: DownloadProgress) => void;
  proxySettings?: ProxySettings; // 代理设置
}

// 当前下载的保存路径，用于取消时清理临时文件
let currentDownloadPath: string | null = null;

// 进度事件数据。Rust 侧 DownloadProgressEvent 走 serde 默认命名，
// 字段是 snake_case，不能直接套用前端 camelCase 的 DownloadProgress
interface DownloadProgressEventPayload {
  session_id: number;
  downloaded_size: number;
  total_size: number;
  speed: number;
  progress: number;
}

/**
 * 下载更新结果（discriminated union）
 * - success: true 时保证有 actualSavePath
 * - success: false 时没有路径信息
 */
export type DownloadUpdateResult =
  | {
      success: true;
      /** 实际保存的文件路径（可能与请求路径不同，如果检测到正确的文件名） */
      actualSavePath: string;
      /** 检测到的文件名（如果有） */
      detectedFilename?: string;
    }
  | { success: false };

/**
 * 下载更新包（使用 Rust 后端流式下载）
 *
 * 相比 JavaScript 下载，Rust 后端实现具有以下优势：
 * - 流式写入磁盘，不占用大量内存
 * - 更高的下载速度（直接写入文件，无需 JS 中转）
 * - 更稳定的大文件下载支持
 * - 自动从 302 重定向后的 URL 或 Content-Disposition 提取正确的文件名
 *
 * @returns 下载结果，包含实际保存路径
 */
export async function downloadUpdate(
  options: DownloadUpdateOptions,
): Promise<DownloadUpdateResult> {
  // 已经在下载中，不允许重复下载
  if (isDownloading) {
    log.info('已有下载任务进行中，跳过本次下载请求');
    return { success: false };
  }

  const { url, savePath, totalSize, onProgress, proxySettings } = options;

  log.info(`开始下载更新: ${url}`);
  log.info(`保存路径: ${savePath}`);

  isDownloading = true;
  downloadCancelled = false;
  currentDownloadPath = savePath;

  // 设置进度监听器
  let unlisten: (() => void) | null = null;
  // 当前下载的 session ID，用于过滤旧下载的进度事件
  let currentSessionId: number | null = null;

  try {
    // 使用统一的代理下载接口（内部已包含日志记录）
    const downloadPromise = downloadWithProxy(url, savePath, {
      totalSize,
      proxyUrl: proxySettings?.url,
    });

    // 监听 Rust 后端发送的下载进度事件
    if (onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<DownloadProgressEventPayload>('download-progress', (event) => {
        // 只处理当前 session 的进度事件，忽略旧下载的事件
        if (currentSessionId !== null && event.payload.session_id !== currentSessionId) {
          return;
        }
        // 记录第一个收到的 session_id
        if (currentSessionId === null) {
          currentSessionId = event.payload.session_id;
        }
        // 如果已被取消，忽略进度更新
        if (downloadCancelled) return;
        onProgress({
          downloadedSize: event.payload.downloaded_size,
          totalSize: event.payload.total_size,
          speed: event.payload.speed,
          progress: event.payload.progress,
        });
      });
    }

    // 等待下载完成，返回下载结果
    const result = await downloadPromise;
    currentSessionId = result.session_id;

    log.info(`下载完成 (session ${result.session_id})`);
    log.info(`实际保存路径: ${result.actual_save_path}`);
    if (result.detected_filename) {
      log.info(`检测到文件名: ${result.detected_filename}`);
    }

    return {
      success: true,
      actualSavePath: result.actual_save_path,
      detectedFilename: result.detected_filename ?? undefined,
    };
  } catch (error) {
    // 如果是用户主动取消，不记录为错误
    if (downloadCancelled) {
      log.info('下载已被用户取消');
    } else {
      log.error('下载失败:', error);
    }
    return { success: false };
  } finally {
    // 清理事件监听器
    if (unlisten) {
      unlisten();
    }
    // 只有在未被取消时才重置状态（取消时 cancelDownload 已经重置了）
    if (!downloadCancelled) {
      isDownloading = false;
      currentDownloadPath = null;
    }
  }
}

export interface CheckAndDownloadOptions extends CheckUpdateOptions {
  githubUrl?: string;
  githubPat?: string; // GitHub Personal Access Token
  proxyUrl?: string; // 代理 URL，用于 GitHub API 请求
  projectName?: string; // 项目名称，用于 GitHub API 失败时拼接直接下载链接
}

/**
 * 检查更新并获取下载信息
 * 始终使用 Mirror酱 检查更新，根据是否有 CDK 决定下载来源
 */
export async function checkAndPrepareDownload(
  options: CheckAndDownloadOptions,
): Promise<UpdateInfo | null> {
  // 正在下载时不允许检查更新
  if (isDownloading) {
    log.info('正在下载更新，跳过检查更新');
    return null;
  }

  const { githubUrl, cdk, channel, githubPat, projectName, proxyUrl, ...checkOptions } = options;

  // 始终使用 Mirror酱 检查更新
  const updateInfo = await checkUpdate({ ...checkOptions, cdk, channel });

  if (!updateInfo || !updateInfo.hasUpdate) {
    return updateInfo;
  }

  // 如果有 CDK 且返回了下载链接，直接使用
  if (cdk && updateInfo.downloadUrl) {
    log.info('使用 Mirror酱 下载链接');
    return updateInfo;
  }

  // 如果有错误码（如 CDK 问题），不尝试 GitHub，直接返回更新信息（包含错误）
  if (updateInfo.errorCode) {
    log.info('Mirror酱 返回错误码，不尝试 GitHub');
    return updateInfo;
  }

  // 没有 CDK 且没有错误码，尝试使用 GitHub
  if (githubUrl) {
    log.info(`无 CDK，尝试从 GitHub 获取版本 ${updateInfo.versionName}`);
    const githubDownload = await getGitHubDownloadUrl({
      githubUrl,
      targetVersion: updateInfo.versionName,
      githubPat,
      projectName, // 用于 API 失败时拼接直接下载链接
      proxyUrl,
    });

    if (githubDownload) {
      return {
        ...updateInfo,
        downloadUrl: githubDownload.url,
        fileSize: githubDownload.size,
        filename: githubDownload.filename,
        downloadSource: 'github',
      };
    }

    log.warn('GitHub 下载链接获取失败');
  }

  // 既没有 Mirror酱 链接也没有 GitHub 链接
  return updateInfo;
}

/**
 * 获取更新包保存路径
 * @param dataPath 数据目录（macOS: ~/Library/Application
 *     Support/MXU/，其他平台: exe 目录）
 * @param filename 文件名（可选）。如果不提供，使用默认名称。
 *                 注意：实际保存路径可能由 Rust 下载时从 302 重定向或
 * Content-Disposition 检测后覆盖
 */
export async function getUpdateSavePath(filename?: string): Promise<string> {
  // 如果提供了文件名，直接使用
  // 如果没有，使用通用的默认名称（Rust 下载时会检测实际文件名并覆盖）
  const name = filename || 'update_package';
  const cacheDir = await getCacheDir();
  return joinPath(cacheDir, name);
}

// ============================================================================
// 更新安装相关
// ============================================================================

// changes.json 结构（增量包标识）
interface ChangesJson {
  added: string[];
  deleted: string[];
  modified: string[];
}

export interface InstallUpdateOptions {
  zipPath: string; // 下载的更新包路径
  targetDir: string; // 目标安装目录
  newVersion: string; // 新版本号（用于兜底时创建文件夹）
  projectName?: string; // 项目名称（用于备份配置文件）
  onProgress?: (stage: string, detail?: string) => void;
}

/**
 * 判断文件是否为可执行安装程序（exe/dmg），这类文件应直接打开而非解压
 */
export function isExecutableInstaller(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.exe') || lower.endsWith('.dmg');
}

/**
 * 安装更新包
 * 1. 如果是 exe/dmg 文件，直接打开（调用系统默认程序）
 * 2. 否则解压更新包（支持 zip/tar.gz/tgz）
 * 3. 检查是否为增量包（存在 changes.json）
 * 4. 增量包：删除 deleted 文件，复制覆盖
 * 5. 全量包：删除同名文件夹，复制覆盖
 * 6. 清理临时文件
 * 7. 如果失败，尝试兜底：创建 v版本号 文件夹
 */
export async function installUpdate(options: InstallUpdateOptions): Promise<boolean> {
  if (isInstalling) {
    log.warn('installUpdate: 已有安装正在进行，跳过重复调用');
    return false;
  }
  isInstalling = true;

  const { zipPath, targetDir, newVersion, projectName, onProgress } = options;

  log.info(`开始安装更新: ${zipPath} -> ${targetDir}`);

  try {
    await backupConfigBeforeUpdate(targetDir, projectName);

    // 对于 exe/dmg 文件，直接打开而不是解压
    if (isExecutableInstaller(zipPath)) {
      log.info(`检测到可执行安装程序，直接打开: ${zipPath}`);
      onProgress?.('opening', zipPath);

      try {
        // 在 Unix 系统上设置执行权限（Windows 上此调用无操作）
        await invoke('set_executable', { filePath: zipPath });

        await openPath(zipPath);
        log.info('已打开安装程序');
        onProgress?.('done');
        return true;
      } catch (error) {
        log.error('打开安装程序失败:', error);
        throw error;
      }
    }

    // 生成临时解压目录
    const extractDir = joinPath(await dirname(zipPath), 'update_extract');

    try {
      // 先清理上次可能残留的解压目录，避免历史文件混入本次更新
      await invoke('cleanup_extract_dir', { extractDir }).catch(() => {});

      // 1. 解压更新包
      onProgress?.('extracting', zipPath);
      log.info(`解压更新包到: ${extractDir}`);

      await invoke('extract_zip', {
        zipPath,
        destDir: extractDir,
      });

      // 2. 检查是否为增量包
      onProgress?.('checking', 'changes.json');
      log.info('检查更新包类型...');

      const changesJson = await invoke<ChangesJson | null>('check_changes_json', {
        extractDir,
      });

      if (changesJson) {
        // 增量更新
        log.info(
          `增量更新: deleted=${changesJson.deleted.length}, added=${
            changesJson.added.length
          }, modified=${changesJson.modified.length}`,
        );
        onProgress?.('applying', 'incremental');

        await invoke('apply_incremental_update', {
          extractDir,
          targetDir,
          deletedFiles: changesJson.deleted,
        });
      } else {
        // 全量更新
        log.info('全量更新');
        onProgress?.('applying', 'full');

        await invoke('apply_full_update', {
          extractDir,
          targetDir,
        });
      }

      // 3. 清理临时文件
      onProgress?.('cleanup');
      log.info('清理临时文件...');

      await invoke('cleanup_extract_dir', { extractDir });

      // 将下载的 zip 文件移动到 old 文件夹
      await moveToOldFolder(zipPath);

      // 清理更新残留产物：target_dir/changes.json 和 cache/*.downloading
      const cacheDir = await getCacheDir();
      await invoke('cleanup_update_artifacts', { targetDir, cacheDir }).catch((e) => {
        log.warn('清理更新残留产物失败（忽略）:', e);
      });

      log.info('更新安装完成');
      onProgress?.('done');

      return true;
    } catch (error) {
      log.error('更新安装失败:', error);

      // 兜底逻辑：尝试将新文件解压到 v版本号 文件夹
      try {
        log.info('尝试兜底更新...');
        onProgress?.('fallback', newVersion);

        const fallbackDir = await invoke<string>('fallback_update', {
          extractDir,
          targetDir,
          newVersion,
        });

        log.info(`兜底更新成功，新文件已解压到: ${fallbackDir}`);

        // 清理临时解压目录
        await invoke('cleanup_extract_dir', { extractDir }).catch(() => {});
        // 清理下载的 zip 文件
        await moveToOldFolder(zipPath);

        // 抛出特殊错误，告知用户可以使用兜底文件夹
        throw new FallbackUpdateError(
          `更新失败，但已将新版本文件解压到 ${fallbackDir}，您可以临时使用该文件夹中的程序`,
          fallbackDir,
        );
      } catch (fallbackError) {
        // 如果是兜底错误，直接抛出
        if (fallbackError instanceof FallbackUpdateError) {
          throw fallbackError;
        }

        log.error('兜底更新也失败:', fallbackError);

        // 尝试清理临时目录
        await invoke('cleanup_extract_dir', { extractDir }).catch(() => {});

        throw error; // 抛出原始错误
      }
    }
  } finally {
    isInstalling = false;
  }
}

/**
 * 兜底更新错误，包含兜底文件夹路径
 */
export class FallbackUpdateError extends Error {
  public readonly fallbackDir: string;

  constructor(message: string, fallbackDir: string) {
    super(message);
    this.name = 'FallbackUpdateError';
    this.fallbackDir = fallbackDir;
  }
}

// 更新完成信息存储 key
const UPDATE_COMPLETE_STORAGE_KEY = 'mxu-update-complete';
// 待安装更新信息存储 key
const PENDING_UPDATE_STORAGE_KEY = 'mxu-pending-update';

/**
 * 更新完成后的信息（用于重启后显示）
 */
export interface UpdateCompleteInfo {
  previousVersion: string;
  newVersion: string;
  releaseNote: string;
  channel?: string;
  timestamp: number;
  /**
   * 是否需要验证版本（用于 exe/dmg 安装程序场景）
   * - true: 需要验证当前版本是否已更新到 newVersion，未更新则忽略
   * - false/undefined: 直接显示更新完成弹窗
   */
  requireVersionCheck?: boolean;
}

/**
 * 待安装的更新信息（下载完成后保存，用于下次启动时自动安装）
 */
export interface PendingUpdateInfo {
  versionName: string;
  releaseNote: string;
  channel?: string;
  downloadSavePath: string;
  fileSize?: number;
  updateType?: 'incremental' | 'full';
  downloadSource?: 'mirrorchyan' | 'github';
  timestamp: number;
}

/**
 * 保存更新完成信息到本地存储
 */
export function saveUpdateCompleteInfo(info: UpdateCompleteInfo): void {
  try {
    localStorage.setItem(UPDATE_COMPLETE_STORAGE_KEY, JSON.stringify(info));
    log.info('已保存更新完成信息');
  } catch (error) {
    log.warn('保存更新完成信息失败:', error);
  }
}

/**
 * 读取更新完成信息（不清除）
 */
export function peekUpdateCompleteInfo(): UpdateCompleteInfo | null {
  try {
    const data = localStorage.getItem(UPDATE_COMPLETE_STORAGE_KEY);
    if (!data) return null;
    return JSON.parse(data) as UpdateCompleteInfo;
  } catch (error) {
    log.warn('读取更新完成信息失败:', error);
    return null;
  }
}

/**
 * 读取并清除更新完成信息
 */
export function consumeUpdateCompleteInfo(): UpdateCompleteInfo | null {
  try {
    const data = localStorage.getItem(UPDATE_COMPLETE_STORAGE_KEY);
    if (!data) return null;

    // 读取后立即清除
    localStorage.removeItem(UPDATE_COMPLETE_STORAGE_KEY);

    const info = JSON.parse(data) as UpdateCompleteInfo;
    log.info('已读取更新完成信息:', info.newVersion);
    return info;
  } catch (error) {
    log.warn('读取更新完成信息失败:', error);
    localStorage.removeItem(UPDATE_COMPLETE_STORAGE_KEY);
    return null;
  }
}

/**
 * 保存待安装更新信息到本地存储（下载完成后调用）
 */
export function savePendingUpdateInfo(info: PendingUpdateInfo): void {
  try {
    localStorage.setItem(PENDING_UPDATE_STORAGE_KEY, JSON.stringify(info));
    log.info('已保存待安装更新信息:', info.versionName);
  } catch (error) {
    log.warn('保存待安装更新信息失败:', error);
  }
}

/**
 * 读取待安装更新信息（不自动清除，需要手动调用 clearPendingUpdateInfo）
 * 如果更新包文件已被删除，会自动清除待安装信息并返回 null
 */
export async function getPendingUpdateInfo(): Promise<PendingUpdateInfo | null> {
  try {
    const data = localStorage.getItem(PENDING_UPDATE_STORAGE_KEY);
    if (!data) return null;

    const info = JSON.parse(data) as PendingUpdateInfo;

    // 检查更新包文件是否仍然存在
    if (info.downloadSavePath && !(await exists(info.downloadSavePath))) {
      log.info('更新包文件已被删除，清除待安装更新信息:', info.downloadSavePath);
      localStorage.removeItem(PENDING_UPDATE_STORAGE_KEY);
      return null;
    }

    log.info('检测到待安装更新:', info.versionName);
    return info;
  } catch (error) {
    log.warn('读取待安装更新信息失败:', error);
    localStorage.removeItem(PENDING_UPDATE_STORAGE_KEY);
    return null;
  }
}

/**
 * 清除待安装更新信息（安装完成或用户取消后调用）
 */
export function clearPendingUpdateInfo(): void {
  try {
    localStorage.removeItem(PENDING_UPDATE_STORAGE_KEY);
    log.info('已清除待安装更新信息');
  } catch (error) {
    log.warn('清除待安装更新信息失败:', error);
  }
}

/**
 * 重启应用
 * 使用 Tauri 的 relaunch API 重启应用
 */
export async function restartApp(): Promise<void> {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (error) {
    log.error('重启应用失败:', error);
    throw error;
  }
}
