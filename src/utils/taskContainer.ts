import type { SelectedTask } from '@/types/interface';
import { getContainerDefinition } from '@/types/containerTasks';

/** 判断子任务挂载关系是否有效（父存在、父是容器、任务名被该容器支持）。 */
function isValidParent(tasks: SelectedTask[], task: SelectedTask): boolean {
  if (!task.parentId) return false;
  const parent = tasks.find((t) => t.id === task.parentId);
  if (!parent) return false;
  const def = getContainerDefinition(parent.taskName);
  return !!def && def.childTaskNames.includes(task.taskName);
}

/**
 * 归一化容器相关的任务顺序（纯函数）：
 * - 悬空或非法的 parentId（父不存在 / 父不是容器 / 任务名不被支持）会被清除；
 * - 子任务出现在其容器之前时视为「拖出容器」：清除挂载并保留原位；
 * - 其余子任务统一收拢为紧随容器之后的连续块，块内相对顺序保持不变。
 *
 * 返回新数组；没有变化时原样返回入参（便于浅比较）。
 */
export function normalizeContainerTasks(tasks: SelectedTask[]): SelectedTask[] {
  let changed = false;
  const indexOf = new Map<string, number>();
  tasks.forEach((t, i) => indexOf.set(t.id, i));

  const cleaned = tasks.map((task) => {
    if (!task.parentId) return task;
    const valid = isValidParent(tasks, task);
    // 子任务位于其容器之前：视为拖出，清除挂载
    const parentIndex = valid ? indexOf.get(task.parentId as string) : undefined;
    const released =
      valid && parentIndex !== undefined && parentIndex > (indexOf.get(task.id) ?? 0);
    if (!valid || released) {
      changed = true;
      return { ...task, parentId: undefined };
    }
    return task;
  });

  const result: SelectedTask[] = [];
  const used = new Set<string>();
  for (const task of cleaned) {
    if (used.has(task.id)) continue;
    const def = getContainerDefinition(task.taskName);
    if (def && !task.parentId) {
      result.push(task);
      used.add(task.id);
      for (const child of cleaned) {
        if (used.has(child.id) || child.parentId !== task.id) continue;
        result.push(child);
        used.add(child.id);
      }
    } else if (task.parentId) {
      // 父任务尚未出现（父在列表更后）：跳过，等父任务处理
      continue;
    } else {
      result.push(task);
      used.add(task.id);
    }
  }

  const orderUnchanged =
    result.length === cleaned.length && result.every((t, i) => t === cleaned[i]);
  if (!changed && orderUnchanged) {
    return tasks;
  }
  return result;
}

/** 归一化容器任务顺序（store 与配置加载的统一入口）。 */
export function reconcileContainerTasks(tasks: SelectedTask[]): SelectedTask[] {
  return normalizeContainerTasks(tasks);
}

/**
 * 计算任务顺序调整的结果（纯函数）：
 * - 移动容器时连同其子任务块一起移动。否则容器一旦被拖到子任务行下方，
 *   下一步归一化会把它当成「子任务在容器之前」而解除关联；
 * - 其余任务按单元素移动处理（与 splice(oldIndex,1)+splice(newIndex,0) 一致）。
 *
 * 无变化时返回原数组引用（便于浅比较）。
 */
export function planTaskReorder(
  tasks: SelectedTask[],
  oldIndex: number,
  newIndex: number,
): SelectedTask[] {
  const len = tasks.length;
  if (oldIndex < 0 || oldIndex >= len || newIndex < 0 || newIndex >= len) return tasks;
  if (oldIndex === newIndex) return tasks;

  const moved = tasks[oldIndex];
  const def = getContainerDefinition(moved.taskName);
  if (!def || moved.parentId) {
    const next = [...tasks];
    const [removed] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, removed);
    return next;
  }

  // 容器：整块移动 [容器, ...其子任务]。落点在块内（自身或自己的子任务）时顺序不变。
  const block = [moved, ...tasks.filter((t) => t.parentId === moved.id)];
  if (newIndex >= oldIndex && newIndex <= oldIndex + block.length - 1) return tasks;

  const blockIds = new Set(block.map((t) => t.id));
  const kept = tasks.map((t, index) => ({ t, index })).filter(({ t }) => !blockIds.has(t.id));
  const before = kept.filter(({ index }) => index < newIndex).length;
  const insertAt = Math.min(before + (newIndex > oldIndex ? 1 : 0), kept.length);
  const next = kept.map(({ t }) => t);
  next.splice(insertAt, 0, ...block);
  return next;
}
