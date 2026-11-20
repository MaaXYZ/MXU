import type { LogEntry } from '@/stores/types';
import { DEFAULT_MAX_LOGS_PER_INSTANCE } from '@/types/config';

const RUNTIME_LOG_STORAGE_KEY = 'mxu.runtime-logs.v1';
const STORAGE_VERSION = 1;
const STORAGE_WRITE_DEBOUNCE_MS = 250;
// 运行日志与配置草稿共用 localStorage：单条日志内嵌的图片 data URL 很容易到数 MiB，
// 这里限制持久化总容量和单条 html 体积，避免占满配额后草稿写入失败。
const MAX_PERSISTED_LOGS_CHARS = 2_000_000;
const MAX_PERSISTED_HTML_CHARS = 64 * 1024;
const MAX_PERSISTED_MESSAGE_CHARS = 64 * 1024;
// 预留 version/savedAt/logs 等外层字段的空间，保证整个 JSON 不超过总预算
const PERSISTED_LOGS_BUDGET = MAX_PERSISTED_LOGS_CHARS - 1024;

let pendingPersistedLogsPayload: string | null = null;
let pendingPersistedLogsTimeout: ReturnType<typeof window.setTimeout> | null = null;
let pendingPersistedLogsIdleCallback: number | null = null;

interface PersistedLogEntry {
  id: string;
  timestamp: string;
  type: LogEntry['type'];
  message: string;
  html?: string;
}

interface PersistedRuntimeLogs {
  version: number;
  savedAt: string;
  logs: Record<string, PersistedLogEntry[]>;
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function clearPendingPersistedLogsWrite(): void {
  if (pendingPersistedLogsTimeout !== null) {
    window.clearTimeout(pendingPersistedLogsTimeout);
    pendingPersistedLogsTimeout = null;
  }

  if (
    pendingPersistedLogsIdleCallback !== null &&
    typeof window !== 'undefined' &&
    'cancelIdleCallback' in window
  ) {
    window.cancelIdleCallback(pendingPersistedLogsIdleCallback);
    pendingPersistedLogsIdleCallback = null;
  }
}

function flushPersistedLogsWrite(): void {
  if (!canUseLocalStorage() || pendingPersistedLogsPayload === null) return;

  const payload = pendingPersistedLogsPayload;
  pendingPersistedLogsPayload = null;
  pendingPersistedLogsTimeout = null;
  pendingPersistedLogsIdleCallback = null;

  try {
    window.localStorage.setItem(RUNTIME_LOG_STORAGE_KEY, payload);
  } catch {
    try {
      window.localStorage.removeItem(RUNTIME_LOG_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures. Persistence is best-effort only.
    }
  }
}

/** 立即写入尚在防抖/空闲等待中的运行日志，用于关机等进程即将结束的场景 */
export function flushPendingRuntimeLogs(): void {
  if (pendingPersistedLogsPayload === null) return;
  clearPendingPersistedLogsWrite();
  flushPersistedLogsWrite();
}

function schedulePersistedLogsWrite(payload: PersistedRuntimeLogs): void {
  pendingPersistedLogsPayload = JSON.stringify(payload);
  clearPendingPersistedLogsWrite();

  pendingPersistedLogsTimeout = window.setTimeout(() => {
    pendingPersistedLogsTimeout = null;

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      pendingPersistedLogsIdleCallback = window.requestIdleCallback(() => {
        flushPersistedLogsWrite();
      });
      return;
    }

    flushPersistedLogsWrite();
  }, STORAGE_WRITE_DEBOUNCE_MS);
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_MAX_LOGS_PER_INSTANCE;
  return Math.min(10000, Math.max(100, Math.floor(limit)));
}

function sanitizeLogEntries(
  entries: readonly (LogEntry | PersistedLogEntry)[],
  limit: number,
): LogEntry[] {
  const deduped = new Map<string, LogEntry>();

  for (const entry of entries) {
    const timestamp = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;

    deduped.set(entry.id, {
      id: entry.id,
      timestamp,
      type: entry.type,
      message: entry.message,
      html: entry.html,
    });
  }

  return [...deduped.values()]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-limit);
}

function sanitizeRuntimeLogs(
  logs: Record<string, readonly (LogEntry | PersistedLogEntry)[]>,
  maxLogsPerInstance: number,
): Record<string, LogEntry[]> {
  const limit = normalizeLimit(maxLogsPerInstance);
  return Object.fromEntries(
    Object.entries(logs)
      .map(([instanceId, entries]) => [instanceId, sanitizeLogEntries(entries, limit)] as const)
      .filter(([, entries]) => entries.length > 0),
  );
}

function toPersistedEntry(entry: LogEntry): PersistedLogEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp.toISOString(),
    type: entry.type,
    message:
      entry.message.length > MAX_PERSISTED_MESSAGE_CHARS
        ? `${entry.message.slice(0, MAX_PERSISTED_MESSAGE_CHARS)}…`
        : entry.message,
    html: entry.html && entry.html.length <= MAX_PERSISTED_HTML_CHARS ? entry.html : undefined,
  };
}

function buildPersistedLogs(
  logs: Record<string, readonly LogEntry[]>,
  maxLogsPerInstance: number,
): Record<string, PersistedLogEntry[]> {
  const sanitized = sanitizeRuntimeLogs(logs, maxLogsPerInstance);
  const groups = Object.entries(sanitized).map(([instanceId, entries]) => ({
    instanceId,
    entries: entries.map(toPersistedEntry),
  }));

  // 用实际序列化长度衡量，JSON 转义（引号、换行、控制字符）不会被低估
  const sized = groups.flatMap(({ instanceId, entries }) =>
    entries.map((entry, index) => ({
      instanceId,
      entry,
      index,
      size: JSON.stringify(entry).length + 1,
    })),
  );
  const total = sized.reduce((sum, item) => sum + item.size, 0) + groups.length * 32;
  if (total <= PERSISTED_LOGS_BUDGET) {
    return Object.fromEntries(groups.map(({ instanceId, entries }) => [instanceId, entries]));
  }

  // 超预算时优先保留最新日志；时间戳相同时后写入的更新
  sized.sort((a, b) => {
    const diff = Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp);
    return diff !== 0 ? diff : b.index - a.index;
  });

  const kept = new Map<string, { entry: PersistedLogEntry; index: number }[]>();
  let used = 0;
  for (const { instanceId, entry, index, size } of sized) {
    if (used > 0 && used + size > PERSISTED_LOGS_BUDGET) break;
    used += size;
    const entries = kept.get(instanceId);
    if (entries) entries.push({ entry, index });
    else kept.set(instanceId, [{ entry, index }]);
  }

  return Object.fromEntries(
    [...kept.entries()].map(([instanceId, items]) => [
      instanceId,
      items
        .sort((a, b) => {
          const diff = Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp);
          return diff !== 0 ? diff : a.index - b.index;
        })
        .map((item) => item.entry),
    ]),
  );
}

export function loadPersistedRuntimeLogs(maxLogsPerInstance: number): Record<string, LogEntry[]> {
  if (!canUseLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(RUNTIME_LOG_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as PersistedRuntimeLogs;
    if (parsed.version !== STORAGE_VERSION || !parsed.logs || typeof parsed.logs !== 'object') {
      clearPersistedRuntimeLogs();
      return {};
    }

    const sanitized = sanitizeRuntimeLogs(parsed.logs, maxLogsPerInstance);
    if (Object.keys(sanitized).length === 0) {
      clearPersistedRuntimeLogs();
      return {};
    }

    return sanitized;
  } catch {
    clearPersistedRuntimeLogs();
    return {};
  }
}

export function persistRuntimeLogs(
  logs: Record<string, readonly LogEntry[]>,
  maxLogsPerInstance: number,
): void {
  if (!canUseLocalStorage()) return;

  const persisted = buildPersistedLogs(logs, maxLogsPerInstance);
  if (Object.keys(persisted).length === 0) {
    clearPersistedRuntimeLogs();
    return;
  }

  const payload: PersistedRuntimeLogs = {
    version: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    logs: persisted,
  };

  schedulePersistedLogsWrite(payload);
}

export function clearPersistedRuntimeLogs(
  instanceId?: string,
  maxLogsPerInstance: number = DEFAULT_MAX_LOGS_PER_INSTANCE,
): void {
  if (!canUseLocalStorage()) return;

  if (!instanceId) {
    clearPendingPersistedLogsWrite();
    pendingPersistedLogsPayload = null;
    try {
      window.localStorage.removeItem(RUNTIME_LOG_STORAGE_KEY);
    } catch {
      // Best-effort cleanup; ignore storage removal failures for consistency.
      return;
    }
    return;
  }

  const existing = loadPersistedRuntimeLogs(maxLogsPerInstance);
  if (!(instanceId in existing)) return;

  const { [instanceId]: _, ...rest } = existing;
  if (Object.keys(rest).length === 0) {
    try {
      window.localStorage.removeItem(RUNTIME_LOG_STORAGE_KEY);
    } catch {
      // Best-effort cleanup; ignore storage removal failures for consistency.
      return;
    }
    return;
  }

  persistRuntimeLogs(rest, maxLogsPerInstance);
}

export function mergeRuntimeLogs(
  maxLogsPerInstance: number,
  ...sources: Array<Record<string, readonly LogEntry[]>>
): Record<string, LogEntry[]> {
  const merged = new Map<string, LogEntry[]>();

  for (const source of sources) {
    for (const [instanceId, entries] of Object.entries(source)) {
      const current = merged.get(instanceId) ?? [];
      merged.set(instanceId, [...current, ...entries]);
    }
  }

  return sanitizeRuntimeLogs(Object.fromEntries(merged.entries()), maxLogsPerInstance);
}
