import { useSyncExternalStore } from 'react';

import { CONTAINER_TASKS } from '@/types/containerTasks';
import { parseJsonc } from '@/utils/jsonc';

/** 容器子任务的轮换状态（用于状态灯） */
export type ContainerChildStatus = 'pending' | 'next' | 'succeeded' | 'failed';

/** 容器状态文件的形状（字段按需读取，容忍缺省） */
interface ContainerStateFile {
  mode?: string;
  slots?: { task?: string; threshold?: number }[];
  current_index?: number;
  accum?: number[];
  progress?: string[];
  /** 运行内瞬态标记：本次运行因槽位达标而结束（项目侧在下次进入时清除） */
  rotated_this_battle?: boolean;
}

const POLL_INTERVAL_MS = 2000;

let basePath = '';
let snapshots: Record<string, ContainerStateFile | null> = {};
let version = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function stateFilePath(relativePath: string): string {
  const base = basePath.replace(/[\\/]+$/, '');
  return `${base}/${relativePath}`.replace(/\\/g, '/');
}

async function pollOnce() {
  if (polling || !basePath) return;
  polling = true;
  let changed = false;
  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    for (const def of Object.values(CONTAINER_TASKS)) {
      const path = stateFilePath(def.stateFile);
      try {
        // 文件缺失（容器未运行过、被删除或换了基准目录）时使快照失效，
        // 避免继续用其他位置/上一次运行的过时状态点灯与接力。
        if (!(await exists(path))) {
          if (snapshots[def.taskName] !== null) {
            snapshots[def.taskName] = null;
            changed = true;
          }
          continue;
        }
        const text = await readTextFile(path);
        const parsed = parseJsonc<ContainerStateFile>(text);
        const next = parsed && typeof parsed === 'object' ? parsed : null;
        if (JSON.stringify(next) !== JSON.stringify(snapshots[def.taskName] ?? null)) {
          snapshots[def.taskName] = next;
          changed = true;
        }
      } catch {
        // 读取竞争（写入过程中的半截文件等）：保留上一条快照
      }
    }
  } finally {
    polling = false;
    if (changed) emit();
  }
}

/** 立即刷新一次容器状态文件（自动接力等场景在运行结束后立即读取）。 */
export function refreshContainerStatusNow(): Promise<void> {
  return pollOnce();
}

/** 设置轮询基准目录（Agent 进程工作目录，通常为 exe 所在目录）。 */
export function setContainerStatusBasePath(path: string) {
  if (basePath === path) return;
  basePath = path;
  // 基准目录变化后旧快照属于其他项目，先作废再重新读取
  snapshots = {};
  emit();
  if (path && timer === null) {
    timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  }
  void pollOnce();
}

/** 容器当前轮换指向的槽位索引（无数据时返回 undefined）。 */
export function getContainerCurrentIndex(containerTaskName: string): number | undefined {
  const index = snapshots[containerTaskName]?.current_index;
  return typeof index === 'number' ? index : undefined;
}

/** 状态文件记录的槽位任务名（按槽位顺序；无数据时返回 undefined）。 */
export function getContainerSlotTaskNames(containerTaskName: string): string[] | undefined {
  const slots = snapshots[containerTaskName]?.slots;
  if (!Array.isArray(slots) || slots.length === 0) return undefined;
  return slots.map((s) => (typeof s?.task === 'string' ? s.task : ''));
}

/** 本次运行是否因槽位达标而结束（`rotated_this_battle` 标记）。 */
export function getContainerRotatedThisBattle(containerTaskName: string): boolean {
  return snapshots[containerTaskName]?.rotated_this_battle === true;
}

/** 容器的轮换模式（无数据时返回 undefined）。 */
export function getContainerMode(containerTaskName: string): string | undefined {
  return snapshots[containerTaskName]?.mode;
}

/**
 * 返回容器内某个槽位的状态灯状态：
 * `next` 表示轮换即将执行（橙），`pending` 未执行（灰），
 * `succeeded` 成功（绿），`failed` 失败（红）。
 * 槽位索引即条目在容器内的位置。
 */
export function getChildStatusByIndex(
  containerTaskName: string,
  slotIndex: number,
): ContainerChildStatus {
  const state = snapshots[containerTaskName];
  if (!state || !Array.isArray(state.slots) || state.slots.length === 0) {
    return 'pending';
  }
  if (state.current_index === slotIndex) return 'next';
  const progress = state.progress?.[slotIndex];
  if (progress === 'success') return 'succeeded';
  if (progress === 'failed') return 'failed';
  return 'pending';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion(): number {
  return version;
}

/** React hook：订阅容器状态变化（状态文件轮询到新数据时触发重渲染）。 */
export function useContainerStatusVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
