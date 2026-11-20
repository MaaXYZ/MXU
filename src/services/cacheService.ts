/**
 * ETag 缓存服务
 * 用于缓存从 URL 获取的数据，避免重复请求
 *
 * 工作原理：
 * 1. 首次请求 URL 时，保存响应数据和 ETag 到 cache 目录
 * 2. 再次请求同一 URL 时，发送带 If-None-Match 头的条件请求
 * 3. 如果服务器返回 304，直接使用缓存数据
 * 4. 如果服务器返回新数据，更新缓存
 */

import { loggers } from '@/utils/logger';
import { getCacheDir, joinPath, isTauri } from '@/utils/paths';

const log = loggers.app;

// 缓存文件名
const CACHE_INDEX_FILE = 'etag-index.json';

/** 缓存索引条目 */
interface CacheEntry {
  etag: string;
  filename: string;
  timestamp: number;
}

/** 缓存索引结构 */
interface CacheIndex {
  version: string;
  entries: Record<string, CacheEntry>;
}

// 内存中的缓存索引
let cacheIndex: CacheIndex | null = null;
let cacheIndexLoaded = false;

/**
 * 将 URL 转换为安全的文件名
 * 使用简单的 hash 算法避免文件名过长或包含非法字符
 */
function urlToFilename(url: string): string {
  // 简单的 hash 实现
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // 转换为 32 位整数
  }
  // 转换为正数的 16 进制字符串
  const hashStr = Math.abs(hash).toString(16);
  // 提取 URL 中的域名和路径末尾作为可读部分
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);
  const readablePart =
    pathParts
      .slice(-2)
      .join('_')
      .replace(/[^a-zA-Z0-9_-]/g, '') || 'data';
  return `${hashStr}_${readablePart}`.slice(0, 100);
}

/** 获取缓存索引文件路径 */
async function getCacheIndexPath(): Promise<string> {
  const cacheDir = await getCacheDir();
  return joinPath(cacheDir, CACHE_INDEX_FILE);
}

/** 获取缓存数据文件路径 */
async function getCacheDataPath(filename: string): Promise<string> {
  const cacheDir = await getCacheDir();
  return joinPath(cacheDir, filename);
}

/**
 * 加载缓存索引
 */
async function loadCacheIndex(): Promise<CacheIndex> {
  if (cacheIndexLoaded && cacheIndex) {
    return cacheIndex;
  }

  const defaultIndex: CacheIndex = { version: '1.0', entries: {} };

  if (!isTauri()) {
    cacheIndex = defaultIndex;
    cacheIndexLoaded = true;
    return cacheIndex;
  }

  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const indexPath = await getCacheIndexPath();

    if (await exists(indexPath)) {
      const content = await readTextFile(indexPath);
      cacheIndex = JSON.parse(content) as CacheIndex;
      log.debug('缓存索引加载成功，条目数:', Object.keys(cacheIndex.entries).length);
    } else {
      cacheIndex = defaultIndex;
    }
  } catch (err) {
    log.warn('加载缓存索引失败:', err);
    cacheIndex = defaultIndex;
  }

  cacheIndexLoaded = true;
  return cacheIndex;
}

/**
 * 保存缓存索引
 */
async function saveCacheIndex(): Promise<void> {
  if (!isTauri() || !cacheIndex) return;

  try {
    const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const cacheDir = await getCacheDir();
    const indexPath = await getCacheIndexPath();

    if (!(await exists(cacheDir))) {
      await mkdir(cacheDir, { recursive: true });
    }

    await writeTextFile(indexPath, JSON.stringify(cacheIndex, null, 2));
  } catch (err) {
    log.warn('保存缓存索引失败:', err);
  }
}

/**
 * 读取缓存数据
 */
async function readCacheData(filename: string): Promise<string | null> {
  if (!isTauri()) return null;

  try {
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const filePath = await getCacheDataPath(filename);

    if (await exists(filePath)) {
      return await readTextFile(filePath);
    }
  } catch (err) {
    log.warn('读取缓存数据失败:', err);
  }
  return null;
}

/**
 * 写入缓存数据
 */
async function writeCacheData(filename: string, data: string): Promise<void> {
  if (!isTauri()) return;

  try {
    const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const cacheDir = await getCacheDir();

    if (!(await exists(cacheDir))) {
      await mkdir(cacheDir, { recursive: true });
    }

    const filePath = await getCacheDataPath(filename);
    await writeTextFile(filePath, data);
  } catch (err) {
    log.warn('写入缓存数据失败:', err);
  }
}

export interface CachedFetchOptions {
  /** 请求头 */
  headers?: Record<string, string>;
}

export interface CachedFetchResult {
  /** 响应数据 */
  data: string;
  /** 是否来自缓存 */
  fromCache: boolean;
  /** ETag 值 */
  etag?: string;
}

/** 日志只保留 origin + path，去掉凭据、查询参数和换行，避免泄漏签名或伪造日志行 */
function sanitizeUrlForLog(url: string): string {
  const trimmed = url.replace(/[\r\n\t]/g, '');
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return trimmed.split(/[?#]/)[0];
  }
}

/**
 * 带 ETag 缓存的 fetch 请求
 *
 * @param url 请求的 URL
 * @param options 选项
 * @returns 响应数据和缓存状态
 */
export async function cachedFetch(
  url: string,
  options: CachedFetchOptions = {},
): Promise<CachedFetchResult> {
  const { headers = {} } = options;

  // 加载缓存索引
  const index = await loadCacheIndex();
  const cacheEntry = index.entries[url];

  // 准备请求头
  const requestHeaders: Record<string, string> = { ...headers };

  // 如果有缓存的 ETag，添加条件请求头
  if (cacheEntry?.etag) {
    requestHeaders['If-None-Match'] = cacheEntry.etag;
    log.debug(`使用缓存 ETag 请求: ${url}`);
  }

  log.info(
    `remote content: request ${sanitizeUrlForLog(url)}${cacheEntry?.etag ? ' (conditional)' : ''}`,
  );

  try {
    // 根据环境选择 fetch 方法
    let response: Response;
    if (isTauri()) {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      response = await tauriFetch(url, { headers: requestHeaders });
    } else {
      response = await fetch(url, { headers: requestHeaders });
    }

    // 304 Not Modified - 使用缓存
    if (response.status === 304 && cacheEntry) {
      const cachedData = await readCacheData(cacheEntry.filename);
      if (cachedData !== null) {
        log.info(`remote content: 304 cache ${sanitizeUrlForLog(url)}`);
        return {
          data: cachedData,
          fromCache: true,
          etag: cacheEntry.etag,
        };
      }
      // 缓存文件丢失，继续获取新数据
      log.warn(`缓存文件丢失，重新获取: ${url}`);
    }

    // 非 OK 状态，尝试返回缓存数据
    if (!response.ok) {
      if (cacheEntry) {
        const cachedData = await readCacheData(cacheEntry.filename);
        if (cachedData !== null) {
          log.warn(`请求失败 (${response.status})，使用缓存数据: ${url}`);
          return {
            data: cachedData,
            fromCache: true,
            etag: cacheEntry.etag,
          };
        }
      }
      throw new Error(`HTTP ${response.status}`);
    }

    // 获取新数据
    const data = await response.text();
    const newEtag = response.headers.get('etag');
    log.info(`remote content: updated ${sanitizeUrlForLog(url)} (${data.length} chars)`);

    // 如果有 ETag，保存到缓存
    if (newEtag) {
      const filename = urlToFilename(url);

      // 更新缓存索引
      index.entries[url] = {
        etag: newEtag,
        filename,
        timestamp: Date.now(),
      };

      // 保存缓存数据和索引
      await writeCacheData(filename, data);
      await saveCacheIndex();

      log.debug(`已缓存数据: ${url}, ETag: ${newEtag}`);
    }

    return {
      data,
      fromCache: false,
      etag: newEtag || undefined,
    };
  } catch (err) {
    // 请求失败，尝试返回缓存数据
    if (cacheEntry) {
      const cachedData = await readCacheData(cacheEntry.filename);
      if (cachedData !== null) {
        log.warn(`请求异常，使用缓存数据: ${url}`, err);
        return {
          data: cachedData,
          fromCache: true,
          etag: cacheEntry.etag,
        };
      }
    }
    throw err;
  }
}

/**
 * 清理过期的缓存条目
 * @param maxAge 最大缓存时间（毫秒），默认 7 天
 */
export async function cleanExpiredCache(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  if (!isTauri()) return;

  try {
    const index = await loadCacheIndex();
    const now = Date.now();
    const expiredUrls: string[] = [];

    // 找出过期的条目
    for (const [url, entry] of Object.entries(index.entries)) {
      if (now - entry.timestamp > maxAge) {
        expiredUrls.push(url);
      }
    }

    if (expiredUrls.length === 0) return;

    const { remove, exists } = await import('@tauri-apps/plugin-fs');

    // 删除过期的缓存文件和索引条目
    for (const url of expiredUrls) {
      const entry = index.entries[url];
      const filePath = await getCacheDataPath(entry.filename);

      if (await exists(filePath)) {
        await remove(filePath);
      }
      delete index.entries[url];
    }

    await saveCacheIndex();
    log.info(`已清理 ${expiredUrls.length} 个过期缓存条目`);
  } catch (err) {
    log.warn('清理过期缓存失败:', err);
  }
}
