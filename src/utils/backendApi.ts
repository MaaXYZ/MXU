/**
 * 后端 HTTP API 工具
 *
 * 浏览器环境下（非 Tauri）通过此模块调用 axum HTTP 服务器 API。
 * Tauri 环境下直接使用 invoke，不经过此模块。
 *
 * 浏览器默认保持页面同源（支持反向代理和 Vite proxy）。只有实际探测成功的
 * 直连端口或 Tauri 本地后端端口，才通过 setBackendPort 选择直连。
 */

import { isTauri } from './paths';

/** 显式选择的直连端口；0 表示浏览器继续使用页面同源。 */
let backendPort = 0;

/** 仅在 Tauri 查询端口或浏览器直连探测成功后调用，不使用接口返回的内部监听端口。 */
export function setBackendPort(port: number): void {
  backendPort = port;
}

export function getApiBase(): string {
  // Tauri 的页面 origin 不提供 /api；内置 axum 服务器只监听普通 HTTP。
  if (isTauri()) {
    return `http://127.0.0.1:${backendPort || 12701}/api`;
  }

  if (backendPort > 0 || !window.location.host) {
    // 浏览器同源加载失败后实际探测成功的 HTTP 地址；无页面 host 时也直连。
    const hostname = window.location.hostname || '127.0.0.1';
    return `http://${hostname}:${backendPort || 12701}/api`;
  }

  return '/api';
}

/** HTTP 与 WebSocket 使用同一个后端地址，保留反代的公开协议、主机与端口。 */
export function getWebSocketUrl(): string {
  const url = new URL(`${getApiBase()}/ws`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** 安全解析 JSON 响应，204 / 空 body 时返回 undefined */
async function parseJsonSafe<T>(resp: Response): Promise<T> {
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * 向后端 HTTP API 发送 GET 请求
 */
export async function apiGet<T>(path: string): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API GET ${path} failed (${resp.status}): ${text}`);
  }
  return parseJsonSafe<T>(resp);
}

/**
 * 向后端 HTTP API 发送 PUT 请求（含 JSON body）
 */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API PUT ${path} failed (${resp.status}): ${text}`);
  }
  return parseJsonSafe<T>(resp);
}

/**
 * 向后端 HTTP API 发送 POST 请求（含 JSON body）
 */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const url = `${getApiBase()}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API POST ${path} failed (${resp.status}): ${text}`);
  }
  return parseJsonSafe<T>(resp);
}

/**
 * 向后端 HTTP API 发送 DELETE 请求
 */
export async function apiDelete(path: string): Promise<void> {
  const url = `${getApiBase()}${path}`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`API DELETE ${path} failed (${resp.status}): ${text}`);
  }
}

/**
 * 检测后端 HTTP API 是否可用（axum server 是否在运行）
 */
export async function isBackendApiAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${getApiBase()}/interface`, { method: 'HEAD' });
    return resp.ok || resp.status === 405; // 405 = Method Not Allowed（只接受 GET）
  } catch {
    return false;
  }
}
