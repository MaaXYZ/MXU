import type { ProjectInterface, SelectedTask } from '@/types/interface';
import { getMxuSpecialTask } from '@/types/specialTasks';
import { resolveI18nText } from '@/services/contentResolver';
import { isPretaskName, getPretaskItem, buildPretaskDef } from '@/types/pretasks';

/**
 * 解析任务在运行日志 / UI 中的显示标签。
 *
 * 优先级：自定义名 → MXU 特殊任务 i18n → pretask / interface 任务 i18n → taskName 兜底。
 * MXU 存在两套独立的启动流程（Toolbar 与 DashboardView），显示名解析逻辑放在这里共用。
 */
export function resolveTaskLabel(
  task: Pick<SelectedTask, 'taskName' | 'customName'>,
  projectInterface: ProjectInterface | null | undefined,
  translations: Record<string, string> | undefined,
  translate: (key: string) => string,
): string {
  if (task.customName) return task.customName;

  const specialTask = getMxuSpecialTask(task.taskName);
  if (specialTask?.taskDef.label) {
    return translate(specialTask.taskDef.label);
  }

  if (isPretaskName(task.taskName)) {
    const item = getPretaskItem(projectInterface, task.taskName);
    const pretaskDef = item ? buildPretaskDef(item) : undefined;
    if (pretaskDef?.label) {
      return resolveI18nText(pretaskDef.label, translations);
    }
  }

  const taskDef = projectInterface?.task.find((item) => item.name === task.taskName);
  if (taskDef?.label) {
    return resolveI18nText(taskDef.label, translations);
  }

  return task.taskName;
}
