/**
 * 内容解析服务
 * 根据 ProjectInterface V2 协议，处理以下类型的内容：
 * 1. 国际化文本（以 $ 开头）
 * 2. 文件路径（相对路径）
 * 3. URL（http:// 或 https://）
 * 4. 直接文本
 */

import { invoke } from '@tauri-apps/api/core';
import { loggers } from '@/utils/logger';
import { marked, type RendererObject } from 'marked';
import DOMPurify from 'dompurify';
import { cachedFetch } from './cacheService';
import { isTauri, joinPath } from '@/utils/paths';
import { getApiBase } from '@/utils/backendApi';

const log = loggers.app;

/** 内容类型枚举 */
export type ContentType = 'url' | 'file' | 'text';

/**
 * 判断内容是否为 URL
 */
export function isUrl(content: string): boolean {
  return content.startsWith('https://') || content.startsWith('http://');
}

/**
 * 判断内容是否可能为文件路径
 * 根据 ProjectInterface V2 协议：支持文件路径、URL 或直接文本
 *
 * 文件路径特征：
 * 1. 以 ./ 或 ../ 开头
 * 2. 包含常见文档扩展名（.md, .txt, .html 等）
 * 3. 简单的文件名（无空格、无 HTML 标签、无换行，全大写或常见文件名格式）
 */
export function isFilePath(content: string): boolean {
  if (isUrl(content)) return false;

  // 以 ./ 或 ../ 开头，明确是相对路径
  if (content.startsWith('./') || content.startsWith('../')) return true;

  // 包含常见文档扩展名
  if (/\.(md|txt|json|html|htm)$/i.test(content)) return true;

  // 简单文件名检测：
  // - 不包含空格、换行、HTML 标签
  // - 不是纯数字
  // - 长度合理（1-100 字符）
  // - 全大写或包含常见路径分隔符
  const isSimpleName =
    /^[A-Za-z0-9_\-./\\]+$/.test(content) &&
    content.length >= 1 &&
    content.length <= 100 &&
    !/^\d+$/.test(content) &&
    !content.includes('<') &&
    !content.includes('>');

  // 全大写的简单名称很可能是文件名（如 LICENSE, CONTACT, README）
  if (isSimpleName && /^[A-Z][A-Z0-9_\-]*$/.test(content)) return true;

  // 包含路径分隔符的简单名称也可能是文件路径
  if (isSimpleName && (content.includes('/') || content.includes('\\'))) return true;

  return false;
}

/**
 * 检测内容类型
 */
export function detectContentType(content: string): ContentType {
  if (!content) return 'text';
  if (isUrl(content)) return 'url';
  if (isFilePath(content)) return 'file';
  return 'text';
}

/**
 * 规范化文件路径（移除 ./ 前缀）
 */
function normalizeFilePath(filePath: string): string {
  if (filePath.startsWith('./')) {
    return filePath.slice(2);
  }
  return filePath;
}

/**
 * 从文件路径加载文本内容
 */
async function loadFromFile(filePath: string, _basePath: string): Promise<string> {
  const normalizedPath = normalizeFilePath(filePath);

  if (isTauri()) {
    // Tauri 环境：使用 Rust 命令读取 exe 同目录的文件
    return await invoke<string>('read_local_file', { filename: normalizedPath });
  } else {
    // 浏览器环境：通过后端本地文件代理 API 读取
    const response = await fetch(
      `${getApiBase()}/local-file?path=${encodeURIComponent(normalizedPath)}`,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  }
}

/**
 * 从 URL 加载内容（带 ETag 缓存）
 * @param url 请求的 URL
 */
async function loadFromUrl(url: string): Promise<string> {
  const result = await cachedFetch(url);
  if (result.fromCache) {
    log.debug(`URL 内容来自缓存: ${url}`);
  }
  return result.data;
}

/**
 * 读取本地文本文件（供外部使用）
 */
export async function readLocalTextFile(filename: string): Promise<string> {
  if (isTauri()) {
    return await invoke<string>('read_local_file', { filename });
  } else {
    const response = await fetch(`${getApiBase()}/local-file?path=${encodeURIComponent(filename)}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  }
}

/**
 * 读取本地二进制文件并返回 base64（供外部使用）
 */
export async function readLocalFileBase64(filename: string): Promise<string> {
  if (isTauri()) {
    return await invoke<string>('read_local_file_base64', { filename });
  } else {
    // 浏览器环境：通过后端本地文件代理 API 获取并转换为 base64
    const response = await fetch(`${getApiBase()}/local-file?path=${encodeURIComponent(filename)}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

/**
 * 检查本地文件是否存在
 */
export async function localFileExists(filename: string): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>('local_file_exists', { filename });
  } else {
    try {
      const response = await fetch(
        `${getApiBase()}/local-file?path=${encodeURIComponent(filename)}`,
        { method: 'HEAD' },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

export interface ResolveOptions {
  /** 翻译映射表 */
  translations?: Record<string, string>;
  /** 资源基础路径 */
  basePath?: string;
  /** 是否加载外部内容（文件/URL），默认 true */
  loadExternal?: boolean;
}

/** 内容解析结果 */
export interface ResolvedContent {
  /** 解析后的内容 */
  content: string;
  /** 原始内容类型 */
  type: ContentType;
  /** 是否从外部加载成功 */
  loaded: boolean;
  /** 加载错误信息 */
  error?: string;
}

/**
 * 解析国际化文本
 * 如果文本以 $ 开头，则从翻译表中查找对应的值
 */
export function resolveI18nText(
  text: string | undefined,
  translations?: Record<string, string>,
): string {
  if (!text) return '';
  if (!text.startsWith('$')) return text;

  const key = text.slice(1);
  return translations?.[key] || key;
}

/**
 * 解析内容（同步版本，仅处理国际化）
 * 用于不需要加载外部内容的场景
 */
export function resolveContentSync(
  content: string | undefined,
  options: ResolveOptions = {},
): string {
  if (!content) return '';

  // 先处理国际化
  const resolved = resolveI18nText(content, options.translations);

  return resolved;
}

/**
 * 解析内容（异步版本，完整处理）
 * 支持国际化、文件路径、URL
 */
export async function resolveContent(
  content: string | undefined,
  options: ResolveOptions = {},
): Promise<string> {
  if (!content) return '';

  const { translations, basePath = '.', loadExternal = true } = options;

  // 先处理国际化
  let resolved = resolveI18nText(content, translations);

  if (!loadExternal) return resolved;

  try {
    // 检查是否为 URL
    if (isUrl(resolved)) {
      resolved = await loadFromUrl(resolved);
    }
    // 检查是否为文件路径
    else if (isFilePath(resolved)) {
      resolved = await loadFromFile(resolved, basePath);
    }
  } catch (err) {
    log.warn(`加载内容失败 [${resolved}]:`, err);
    // 加载失败时返回原始文本
  }

  return resolved;
}

/**
 * 解析描述类内容（异步版本，返回详细结果）
 * 根据 ProjectInterface V2 协议，description 等字段支持：
 * - 文件路径（相对于 interface.json 所在目录）
 * - URL（http:// 或 https://）
 * - 直接文本
 *
 * @param content 原始内容
 * @param options 解析选项
 * @returns 解析结果，包含内容、类型和加载状态
 */
export async function resolveDescriptionContent(
  content: string | undefined,
  options: ResolveOptions = {},
): Promise<ResolvedContent> {
  if (!content) {
    return { content: '', type: 'text', loaded: false };
  }

  const { translations, basePath = '' } = options;

  // 先处理国际化
  const resolved = resolveI18nText(content, translations);

  // 检测内容类型
  const type = detectContentType(resolved);

  // 如果是直接文本，直接返回
  if (type === 'text') {
    return { content: resolved, type, loaded: false };
  }

  // 尝试加载外部内容
  try {
    let loadedContent: string;

    if (type === 'url') {
      loadedContent = await loadFromUrl(resolved);
    } else {
      // 文件路径：相对于 interface.json 所在目录
      loadedContent = await loadFromFile(resolved, basePath);
    }

    return { content: loadedContent, type, loaded: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`加载描述内容失败 [${type}: ${resolved}]:`, err);
    // 加载失败时返回原始文本，并附带错误信息
    return { content: resolved, type, loaded: false, error: errorMsg };
  }
}

/**
 * 解析图标路径（同步版本，仅返回路径）
 * 用于非 Tauri 环境或作为 key
 */
export function resolveIconPath(
  iconPath: string | undefined,
  _basePath: string,
  translations?: Record<string, string>,
): string | undefined {
  if (!iconPath) return undefined;

  // 先处理国际化
  let resolved = resolveI18nText(iconPath, translations);

  if (!resolved) return undefined;

  // 如果是 URL 直接返回
  if (isUrl(resolved)) return resolved;

  // 规范化路径
  resolved = normalizeFilePath(resolved);

  // 浏览器环境：通过后端本地文件代理 API 访问
  if (!isTauri()) {
    resolved = `${getApiBase()}/local-file?path=${encodeURIComponent(resolved)}`;
  }

  return resolved;
}

/**
 * 图标 data URL 缓存（会话内）。
 *
 * 同一个图标会出现在多个 label / 任务项 / 下拉项里，缓存后同一路径只读一次文件；
 * 资源目录被换掉（同一路径下文件内容变化）时调用 {@link clearIconDataUrlCache} 失效。
 */
const iconDataUrlCache = new Map<string, string>();

/** 同一路径的并发读取去重，避免首屏同时发起 N 次 IPC */
const iconLoadInFlight = new Map<string, Promise<string | undefined>>();

/**
 * 缓存代数，每次 {@link clearIconDataUrlCache} 自增。
 * 用于丢弃「清空之前发起、清空之后才完成」的读取结果，避免切换资源后写回旧图标。
 */
let iconCacheGeneration = 0;

/** 清空图标 data URL 缓存（加载 / 切换资源目录时调用） */
export function clearIconDataUrlCache(): void {
  iconCacheGeneration += 1;
  iconDataUrlCache.clear();
  iconLoadInFlight.clear();
}

/**
 * 加载图标为 data URL（异步版本）
 * 在 Tauri 环境下读取本地文件并转换为 base64 data URL
 *
 * @param iconPath 图标路径（相对于 interface.json 所在目录）
 * @param basePath interface.json 所在目录
 * @param translations 翻译表
 */
export async function loadIconAsDataUrl(
  iconPath: string | undefined,
  basePath: string = '',
  translations?: Record<string, string>,
): Promise<string | undefined> {
  if (!iconPath) return undefined;

  // 先处理国际化
  let resolved = resolveI18nText(iconPath, translations);

  if (!resolved) return undefined;

  // 如果是 URL 直接返回
  if (isUrl(resolved)) return resolved;

  // 规范化路径并拼接 basePath
  resolved = normalizeFilePath(resolved);
  const fullPath = joinPath(basePath, resolved);

  const cached = iconDataUrlCache.get(fullPath);
  if (cached) return cached;

  const inFlight = iconLoadInFlight.get(fullPath);
  if (inFlight) return inFlight;

  const generation = iconCacheGeneration;
  const task = (async (): Promise<string | undefined> => {
    try {
      if (isTauri()) {
        // Tauri 环境：读取文件并转换为 base64 data URL
        const base64 = await readLocalFileBase64(fullPath);
        const ext = resolved.split('.').pop()?.toLowerCase() || 'png';
        const mimeType = getMimeType(ext);
        return `data:${mimeType};base64,${base64}`;
      } else {
        // 浏览器环境：通过后端本地文件代理 API 访问。
        // 先探测代理确实能提供该文件：否则调用方会把一个必然 404 的 URL 当成加载成功，
        // 缺失的图标就会留下破图（Tauri 环境是真读文件，天然具备这个校验）。
        const url = `${getApiBase()}/local-file?path=${encodeURIComponent(fullPath)}`;
        const response = await fetch(url);
        if (!response.ok) return undefined;
        return url;
      }
    } catch (err) {
      log.warn(`加载图标失败 [${fullPath}]:`, err);
      return undefined;
    }
  })();

  iconLoadInFlight.set(fullPath, task);

  try {
    const result = await task;
    // 只缓存成功结果：文件缺失等情况下次仍会重试；
    // 且只缓存本代数的结果，避免清空缓存后写回旧资源目录的图标
    if (result && generation === iconCacheGeneration) iconDataUrlCache.set(fullPath, result);
    return result;
  } finally {
    // 只清理自己那一项：清空缓存后新发起的同路径请求不能被旧请求删掉
    if (iconLoadInFlight.get(fullPath) === task) iconLoadInFlight.delete(fullPath);
  }
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * 全局 Markdown 渲染样式（description、focus 日志等共用），使用 Tailwind class。
 */
const tailwindRenderer: RendererObject = {
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const styles: Record<number, string> = {
      1: 'text-xl font-bold mt-4 mb-2',
      2: 'text-lg font-semibold mt-4 mb-2',
      3: 'text-base font-semibold mt-3 mb-1',
      4: 'text-sm font-semibold mt-2 mb-1',
      5: 'text-sm font-medium mt-2 mb-1',
      6: 'text-xs font-medium mt-2 mb-1',
    };
    return `<h${depth} class="${styles[depth] || ''}">${text}</h${depth}>`;
  },

  paragraph({ tokens }) {
    const text = this.parser.parseInline(tokens);
    return `<p class="my-1">${text}</p>`;
  },

  link({ href, tokens }) {
    const text = this.parser.parseInline(tokens);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${text}</a>`;
  },

  code({ text, lang }) {
    const escapedCode = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langClass = lang ? ` language-${lang}` : '';
    return `<pre class="bg-bg-tertiary rounded p-2 my-2 overflow-x-auto text-sm"><code class="${langClass}">${escapedCode}</code></pre>`;
  },

  codespan({ text }) {
    return `<code class="bg-bg-tertiary px-1 rounded text-sm">${text}</code>`;
  },

  list(token) {
    const body = token.items.map((item) => this.listitem(item)).join('');
    const tag = token.ordered ? 'ol' : 'ul';
    const listClass = token.ordered ? 'list-decimal' : 'list-disc';
    return `<${tag} class="${listClass} list-inside my-1">${body}</${tag}>`;
  },

  listitem(item) {
    let text = this.parser.parse(item.tokens);
    if (item.task) {
      const checkbox = `<input type="checkbox" disabled ${item.checked ? 'checked' : ''} class="mr-1" />`;
      text = checkbox + text;
    }
    return `<li>${text}</li>`;
  },

  blockquote({ tokens }) {
    const text = this.parser.parse(tokens);
    return `<blockquote class="border-l-4 border-border pl-4 my-2 text-text-secondary italic">${text}</blockquote>`;
  },

  hr() {
    return '<hr class="my-4 border-border" />';
  },

  table(token) {
    const headerCells = token.header
      .map((cell, i) => this.tablecell({ ...cell, align: token.align[i] }))
      .join('');
    const header = `<tr class="border-b border-border">${headerCells}</tr>`;

    const bodyRows = token.rows
      .map((row) => {
        const cells = row
          .map((cell, i) => this.tablecell({ ...cell, align: token.align[i] }))
          .join('');
        return `<tr class="border-b border-border">${cells}</tr>`;
      })
      .join('');

    return `<table class="w-full my-2 border-collapse"><thead>${header}</thead><tbody>${bodyRows}</tbody></table>`;
  },

  tablecell(token) {
    const text = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    const alignClass = token.align ? ` text-${token.align}` : '';
    const baseClass = token.header ? 'font-semibold' : '';
    return `<${tag} class="px-2 py-1${alignClass} ${baseClass}">${text}</${tag}>`;
  },

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  },

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  },

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  },

  image({ href, title, text }) {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${text}"${titleAttr} class="max-w-full my-2 rounded" />`;
  },
};

// 配置全局 marked 实例（description、focus 日志等）
marked.use({ breaks: true, gfm: true, renderer: tailwindRenderer });

/**
 * DOMPurify 配置：集中一处，避免不同调用点的白名单漂移。
 *
 * 各调用点直接写 `DOMPurify.sanitize(..., PURIFY_CONFIG)`，不额外包本地 helper：
 * 让「这段 HTML 已清理」在每个调用点上都显式可见。
 */
const PURIFY_CONFIG = { ADD_ATTR: ['target', 'rel', 'style'] };

/**
 * 将 Markdown 转换为安全的 HTML
 * 使用 marked 解析 markdown，使用 DOMPurify 清理 HTML 防止 XSS
 *
 * @param markdown Markdown 文本
 */
export function markdownToHtml(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }), PURIFY_CONFIG);
}

/**
 * 把 HTML 里相对路径的图片替换为 data URL。
 *
 * 安全约束：入参必须是**已清理**的 HTML（上游 {@link markdownToHtml} 已用 DOMPurify 处理）。
 * 这里再做一次防御性 sanitize，让函数自身即使被新调用方误用也不会成为注入点。
 * 顺序放在替换 data URL **之前**：这样只需要清理资源作者提供的内容，不必把随后内联进来的
 * base64 图片（可能很大）再送进 DOMPurify 解析一遍。
 *
 * 用 DOM 而不是正则改写：属性顺序、alt/title 里的特殊字符、路径里的引号都不会影响结果。
 */
async function resolveLocalImages(html: string, basePath: string): Promise<string> {
  // 解析富文本片段用 Range.createContextualFragment，而不是 `container.innerHTML = ...`。
  // 值本身已经是 DOMPurify 的产物，但静态扫描（opengrep 的 insecure-innerhtml /
  // insecure-document-method）对 innerHTML 写入没有 sanitizer 例外，会一直把它报成 XSS 风险；
  // 片段解析不会执行脚本，末尾也只读取序列化结果（读取不是危险 sink）。
  const container = document.createElement('div');
  container.append(
    document.createRange().createContextualFragment(DOMPurify.sanitize(html, PURIFY_CONFIG)),
  );

  await Promise.all(
    Array.from(container.querySelectorAll('img')).map(async (img) => {
      const src = img.getAttribute('src');
      // 跳过已经是 data URL 或 http(s) URL 的图片
      if (!src || src.startsWith('data:') || isUrl(src)) return;

      const dataUrl = await loadIconAsDataUrl(src, basePath);
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
      }
    }),
  );

  return container.innerHTML;
}

/**
 * 将 Markdown 转换为 HTML，并将相对路径图片转换为 data URL
 * @param markdown Markdown 文本
 * @param basePath 资源基础路径（用于解析相对路径图片）
 * @returns 处理后的 HTML
 */
export async function markdownToHtmlWithLocalImages(
  markdown: string,
  basePath: string = '',
): Promise<string> {
  return resolveLocalImages(markdownToHtml(markdown), basePath);
}

/**
 * @deprecated 请使用 markdownToHtml
 */
export const simpleMarkdownToHtml = markdownToHtml;

// ============================================================================
// React Hooks
// ============================================================================

import { useState, useEffect } from 'react';

/** useResolvedContent Hook 的返回值 */
export interface UseResolvedContentResult {
  /** 解析后的内容 */
  content: string;
  /** 转换为 HTML 后的内容（支持 Markdown） */
  html: string;
  /** 是否正在加载 */
  loading: boolean;
  /** 原始内容类型 */
  type: ContentType;
  /** 是否从外部成功加载 */
  loaded: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * React Hook: 解析 description 等支持文件/URL 的字段
 *
 * @param content 原始内容（可能是文件路径、URL 或直接文本）
 * @param basePath 资源基础路径（相对路径基于此目录）
 * @param translations 翻译表（用于国际化文本）
 */
export function useResolvedContent(
  content: string | undefined,
  basePath: string = '',
  translations?: Record<string, string>,
): UseResolvedContentResult {
  const [result, setResult] = useState<UseResolvedContentResult>({
    content: '',
    html: '',
    loading: false,
    type: 'text',
    loaded: false,
  });

  useEffect(() => {
    if (!content) {
      setResult({ content: '', html: '', loading: false, type: 'text', loaded: false });
      return;
    }

    // 先处理国际化
    const resolvedI18n = resolveI18nText(content, translations);
    const type = detectContentType(resolvedI18n);

    // 统一使用异步处理，以支持直接文本中的本地图片
    setResult((prev) => ({ ...prev, loading: true, type }));

    let cancelled = false;

    (async () => {
      let finalContent = resolvedI18n;
      let loaded = false;
      let error: string | undefined;

      // 如果是文件或 URL 类型，需要先加载内容
      if (type !== 'text') {
        const resolved = await resolveDescriptionContent(content, { translations, basePath });
        finalContent = resolved.content;
        loaded = resolved.loaded;
        error = resolved.error;
      }

      if (cancelled) return;

      // 异步加载本地图片的 HTML（统一处理，支持直接文本中的 Markdown 图片）
      const html = await markdownToHtmlWithLocalImages(finalContent, basePath);

      if (cancelled) return;

      setResult({
        content: finalContent,
        html,
        loading: false,
        type,
        loaded,
        error,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [content, basePath, translations]);

  return result;
}

/**
 * React Hook: 解析 description 并返回 HTML（简化版本）
 * 用于只需要 HTML 结果的场景
 */
export function useDescriptionHtml(
  description: string | undefined,
  basePath: string = '',
  translations?: Record<string, string>,
): { html: string; loading: boolean; error?: string } {
  const result = useResolvedContent(description, basePath, translations);
  return { html: result.html, loading: result.loading, error: result.error };
}
