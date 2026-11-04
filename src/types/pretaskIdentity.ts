import type { ProjectInterface, PretaskItem } from './interface';
import { normalizePretaskConfigs } from './interface';

/** pretask 伪任务名前缀 */
export const PRETASK_NAME_PREFIX = '__MXU_PRETASK__';

/** pretask 条目的稳定标识（缺省 name 时回退到 exec） */
export function pretaskItemId(item: PretaskItem): string {
  return item.name || item.exec;
}

/** 由 pretask 条目生成唯一的伪任务名 */
export function pretaskName(item: PretaskItem): string {
  return PRETASK_NAME_PREFIX + pretaskItemId(item);
}

/** 判断某任务名是否为 pretask 伪任务 */
export function isPretaskName(taskName: string): boolean {
  return taskName.startsWith(PRETASK_NAME_PREFIX);
}

/** 获取当前项目声明的全部 pretask 条目 */
export function getPretaskItems(pi: ProjectInterface | null | undefined): PretaskItem[] {
  if (!pi) return [];
  return normalizePretaskConfigs(pi.pretask) || [];
}

/** 通过伪任务名反查 pretask 条目定义 */
export function getPretaskItem(
  pi: ProjectInterface | null | undefined,
  taskName: string,
): PretaskItem | undefined {
  if (!isPretaskName(taskName)) return undefined;
  return getPretaskItems(pi).find((item) => pretaskName(item) === taskName);
}
