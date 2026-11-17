import type { LogEntry } from '@/stores/types';
import { DEFAULT_MAX_LOGS_PER_INSTANCE } from '@/types/config';

const RUNTIME_LOG_STORAGE_KEY = 'mxu.runtime-logs.v1';
const STORAGE_VERSION = 1;
const STORAGE_WRITE_DEBOUNCE_MS = 250;

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

  const sanitized = sanitizeRuntimeLogs(logs, maxLogsPerInstance);
  if (Object.keys(sanitized).length === 0) {
    clearPersistedRuntimeLogs();
    return;
  }

  const payload: PersistedRuntimeLogs = {
    version: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    logs: Object.fromEntries(
      Object.entries(sanitized).map(([instanceId, entries]) => [
        instanceId,
        entries.map((entry) => ({
          id: entry.id,
          timestamp: entry.timestamp.toISOString(),
          type: entry.type,
          message: entry.message,
          html: entry.html,
        })),
      ]),
    ),
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
