import type { ActionConfig, Instance, ProjectInterface, SelectedTask } from '@/types/interface';
import { getPretaskItems, isPretaskName, pretaskName } from '@/types/pretaskIdentity';

export type StartupStep =
  | { type: 'pretask'; item: SelectedTask }
  | { type: 'preAction'; item: ActionConfig };

/** Missing ranks preserve legacy PI declaration order, followed by preActions. */
export function getStartupSteps(
  instance: Pick<Instance, 'selectedTasks' | 'preActions'>,
  pi?: ProjectInterface | null,
): StartupStep[] {
  const declarations = getPretaskItems(pi).map(pretaskName);
  const pretasks = instance.selectedTasks
    .filter((task) => isPretaskName(task.taskName))
    .sort((a, b) => declarations.indexOf(a.taskName) - declarations.indexOf(b.taskName));
  const steps: StartupStep[] = [
    ...pretasks.map((item): StartupStep => ({ type: 'pretask', item })),
    ...(instance.preActions ?? []).map((item): StartupStep => ({ type: 'preAction', item })),
  ];
  const rank = (step: StartupStep) =>
    Number.isFinite(step.item.startupOrder) ? step.item.startupOrder! : Infinity;
  return steps.sort((a, b) => rank(a) - rank(b));
}

export function reorderStartupSteps(
  instance: Instance,
  pi: ProjectInterface | null,
  from: number,
  to: number,
): Instance {
  const steps = getStartupSteps(instance, pi);
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) {
    return instance;
  }
  const [step] = steps.splice(from, 1);
  steps.splice(to, 0, step);
  const ranks = new Map(steps.map(({ item }, index) => [item.id, index]));
  return {
    ...instance,
    selectedTasks: instance.selectedTasks.map((task) =>
      ranks.has(task.id) ? { ...task, startupOrder: ranks.get(task.id) } : task,
    ),
    preActions: instance.preActions?.map((action) => ({
      ...action,
      startupOrder: ranks.get(action.id),
    })),
  };
}
