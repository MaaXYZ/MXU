/**
 * 启动前的选项校验：checkbox 数量约束 + input/hotkey 取值合法性。
 *
 * 两类校验共用同一个遍历器（`validateOptionKeys`），保证校验范围与
 * `pipelineOverride.collectOptionOverrides` 实际会代入的选项完全一致：
 * 只看当前控制器/资源兼容的选项、当前选中的 case 及其嵌套选项，
 * 并覆盖全局选项、资源级、控制器级、任务级与 MXU 内置任务。
 */
import { createDefaultOptionValue, sanitizeOptionValue } from '@/stores/helpers';
import type {
  CheckboxOption,
  InputItem,
  OptionDefinition,
  OptionValue,
  ProjectInterface,
  SelectedTask,
} from '@/types/interface';
import { getPretaskItem, isPretaskName } from '@/types/pretasks';
import { getMxuSpecialTask, isMxuSpecialTask } from '@/types/specialTasks';
import type { TFunction } from 'i18next';
import { findSwitchCase } from './optionHelpers';
import { getInputValueError, type InputValueErrorKind } from './optionInputValue';
import { isPasswordInput } from './passwordOptionValues';

export interface CheckboxCountViolation {
  type: 'checkbox';
  optionKey: string;
  selectedCount: number;
  minCount: number;
  maxCount?: number;
  kind: 'min' | 'max';
  taskId?: string;
  taskName?: string;
}

/** 输入值不合法：启动前会据此拒绝运行，绝不带着非法值下发流水线。 */
export interface InputValueViolation {
  type: 'input';
  optionKey: string;
  inputName: string;
  value: string;
  kind: InputValueErrorKind;
  taskId?: string;
  taskName?: string;
}

export type OptionViolation = CheckboxCountViolation | InputValueViolation;

export function getCheckboxMinCount(optionDef: CheckboxOption): number {
  return optionDef.min_count ?? 0;
}

export function getCheckboxMaxCount(optionDef: CheckboxOption): number | undefined {
  return optionDef.max_count;
}

function resolveInterfaceLabel(
  label: string | undefined,
  fallback: string,
  translations?: Record<string, string>,
): string {
  if (!label) return fallback;
  if (!label.startsWith('$')) return label;
  return translations?.[label.slice(1)] ?? label.slice(1);
}

/** 解析违规项所属的任务/选项上下文，两个格式化函数共用。 */
function resolveViolationContext(
  violation: Pick<OptionViolation, 'taskId' | 'taskName' | 'optionKey'>,
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  translations: Record<string, string> | undefined,
  t: TFunction,
): {
  specialTask: ReturnType<typeof getMxuSpecialTask>;
  optionDef: OptionDefinition | undefined;
  optionLabel: string;
  scope: string;
} {
  const selectedTask = violation.taskId
    ? tasks.find((task) => task.id === violation.taskId)
    : undefined;
  const specialTask = selectedTask ? getMxuSpecialTask(selectedTask.taskName) : undefined;
  const pretask =
    selectedTask && isPretaskName(selectedTask.taskName)
      ? getPretaskItem(projectInterface, selectedTask.taskName)
      : undefined;
  const taskDef = selectedTask
    ? specialTask?.taskDef ||
      (pretask
        ? {
            label: pretask.label || pretask.name || pretask.exec,
            name: pretask.name || pretask.exec,
          }
        : projectInterface?.task.find((item) => item.name === selectedTask.taskName))
    : undefined;
  const taskLabel =
    selectedTask?.customName ||
    (specialTask
      ? t(taskDef?.label || taskDef?.name || selectedTask?.taskName || violation.taskName || '')
      : resolveInterfaceLabel(
          taskDef?.label,
          taskDef?.name || selectedTask?.taskName || '',
          translations,
        ));
  const optionDef =
    specialTask?.optionDefs[violation.optionKey] || projectInterface?.option?.[violation.optionKey];
  const optionLabel = specialTask
    ? t(optionDef?.label || violation.optionKey)
    : resolveInterfaceLabel(optionDef?.label, violation.optionKey, translations);
  const scope = selectedTask
    ? t('taskList.checkboxTaskScope', { task: taskLabel })
    : t('taskList.checkboxGlobalScope');

  return { specialTask, optionDef, optionLabel, scope };
}

/** 在选项定义里找到对应的输入项，用于取 label / pattern_msg。 */
function findInputDefinition(
  optionDef: OptionDefinition | undefined,
  inputName: string,
): InputItem | undefined {
  if (optionDef?.type === 'input') return optionDef.inputs?.find((item) => item.name === inputName);
  if (optionDef?.type === 'hotkey')
    return optionDef.hotkeys?.find((item) => item.name === inputName);
  return undefined;
}

const INPUT_VALUE_REASON_KEYS: Record<InputValueErrorKind, string> = {
  empty: 'optionEditor.inputRequired',
  pattern: 'optionEditor.inputPatternMismatch',
  integer: 'optionEditor.inputNotInteger',
  'invalid-pattern': 'optionEditor.invalidVerifyPattern',
};

export function formatCheckboxCountViolation(
  violation: CheckboxCountViolation,
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  translations: Record<string, string> | undefined,
  t: TFunction,
): string {
  const { optionLabel, scope } = resolveViolationContext(
    violation,
    tasks,
    projectInterface,
    translations,
    t,
  );

  return violation.kind === 'min'
    ? t('taskList.checkboxMinimumNotMet', {
        scope,
        option: optionLabel,
        min: violation.minCount,
        count: violation.selectedCount,
      })
    : t('taskList.checkboxMaximumExceeded', {
        scope,
        option: optionLabel,
        max: violation.maxCount,
        count: violation.selectedCount,
      });
}

export function formatInputValueViolation(
  violation: InputValueViolation,
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  translations: Record<string, string> | undefined,
  t: TFunction,
): string {
  const { specialTask, optionDef, optionLabel, scope } = resolveViolationContext(
    violation,
    tasks,
    projectInterface,
    translations,
    t,
  );
  const inputDef = findInputDefinition(optionDef, violation.inputName);
  const inputLabel = specialTask
    ? t(inputDef?.label || violation.inputName)
    : resolveInterfaceLabel(inputDef?.label, violation.inputName, translations);
  // 项目自定义的 pattern_msg 优先（通常是给用户看的可读说明）
  const patternMsg = inputDef?.pattern_msg
    ? specialTask
      ? t(inputDef.pattern_msg)
      : resolveInterfaceLabel(inputDef.pattern_msg, '', translations)
    : '';
  const reason = patternMsg || t(INPUT_VALUE_REASON_KEYS[violation.kind]);

  return violation.kind === 'empty'
    ? t('taskList.inputValueMissing', {
        scope,
        option: optionLabel,
        input: inputLabel,
      })
    : t('taskList.inputValueInvalid', {
        scope,
        option: optionLabel,
        input: inputLabel,
        value: violation.value,
        reason,
      });
}

function isOptionIncompatible(
  optionDef: OptionDefinition,
  controllerName?: string,
  resourceName?: string,
): boolean {
  if (
    optionDef.controller &&
    optionDef.controller.length > 0 &&
    (!controllerName || !optionDef.controller.includes(controllerName))
  ) {
    return true;
  }
  return Boolean(
    optionDef.resource &&
    optionDef.resource.length > 0 &&
    (!resourceName || !optionDef.resource.includes(resourceName)),
  );
}

function validateOptionKeys(
  optionKeys: string[],
  optionValues: Record<string, OptionValue>,
  allOptions: Record<string, OptionDefinition>,
  controllerName: string | undefined,
  resourceName: string | undefined,
  context: Pick<CheckboxCountViolation, 'taskId' | 'taskName'>,
): OptionViolation[] {
  const violations: OptionViolation[] = [];
  const visited = new Set<string>();

  const visit = (optionKey: string) => {
    if (visited.has(optionKey)) return;
    visited.add(optionKey);

    const optionDef = allOptions[optionKey];
    if (!optionDef || isOptionIncompatible(optionDef, controllerName, resourceName)) return;

    const savedValue = optionValues[optionKey];
    const optionValue =
      (savedValue && sanitizeOptionValue(optionKey, savedValue, allOptions)) ||
      createDefaultOptionValue(optionDef);

    if (optionDef.type === 'checkbox' && optionValue.type === 'checkbox') {
      const selectedCount = new Set(optionValue.caseNames).size;
      const minCount = getCheckboxMinCount(optionDef);
      const maxCount = getCheckboxMaxCount(optionDef);

      if (selectedCount < minCount) {
        violations.push({
          type: 'checkbox',
          optionKey,
          selectedCount,
          minCount,
          maxCount,
          kind: 'min',
          ...context,
        });
      } else if (maxCount !== undefined && selectedCount > maxCount) {
        violations.push({
          type: 'checkbox',
          optionKey,
          selectedCount,
          minCount,
          maxCount,
          kind: 'max',
          ...context,
        });
      }

      return;
    }

    // input / hotkey：值必须通过自身声明的格式要求（verify），否则拒绝运行。
    // 取值方式与 pipelineOverride 的代入保持一致（空值同样按 default 解析）。
    if (
      (optionDef.type === 'input' || optionDef.type === 'hotkey') &&
      (optionValue.type === 'input' || optionValue.type === 'hotkey')
    ) {
      const inputDefs =
        optionDef.type === 'hotkey' ? (optionDef.hotkeys ?? []) : (optionDef.inputs ?? []);

      for (const inputDef of inputDefs) {
        // 密码字段的 values 由加密通道管理，不参与取值校验
        if (isPasswordInput(inputDef)) continue;

        const value = optionValue.values[inputDef.name] ?? inputDef.default ?? '';
        const error = getInputValueError(inputDef, value);
        if (error) {
          violations.push({
            type: 'input',
            optionKey,
            inputName: inputDef.name,
            value,
            kind: error.kind,
            ...context,
          });
        }
      }

      return;
    }

    if (optionDef.type === 'switch' && optionValue.type === 'switch') {
      findSwitchCase(optionDef.cases, optionValue.value)?.option?.forEach(visit);
      return;
    }

    if ((!optionDef.type || optionDef.type === 'select') && optionValue.type === 'select') {
      optionDef.cases
        .find((caseDef) => caseDef.name === optionValue.caseName)
        ?.option?.forEach(visit);
    }
  };

  optionKeys.forEach(visit);
  return violations;
}

/**
 * 校验一次启动中实际会使用到的选项（checkbox 数量 + 输入值）。
 * 调用方应先过滤掉与当前控制器/资源不兼容的任务。
 */
export function validateInstanceOptionViolations(
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  controllerName?: string,
  resourceName?: string,
  globalOptionValues: Record<string, OptionValue> = {},
): OptionViolation[] {
  if (!projectInterface) return [];

  const violations: OptionViolation[] = [];
  const ordinaryTasks = tasks.filter(
    (task) => !isMxuSpecialTask(task.taskName) && !isPretaskName(task.taskName),
  );

  if (
    ordinaryTasks.length > 0 &&
    projectInterface.option &&
    projectInterface.global_option?.length
  ) {
    violations.push(
      ...validateOptionKeys(
        projectInterface.global_option,
        globalOptionValues,
        projectInterface.option,
        controllerName,
        resourceName,
        {},
      ),
    );
  }

  for (const task of tasks) {
    const specialTask = getMxuSpecialTask(task.taskName);
    if (specialTask) {
      violations.push(
        ...validateOptionKeys(
          specialTask.taskDef.option ?? [],
          task.optionValues,
          specialTask.optionDefs,
          controllerName,
          resourceName,
          { taskId: task.id, taskName: task.taskName },
        ),
      );
      continue;
    }

    if (isPretaskName(task.taskName)) {
      const pretask = getPretaskItem(projectInterface, task.taskName);
      if (pretask?.option && projectInterface.option) {
        violations.push(
          ...validateOptionKeys(
            pretask.option,
            task.optionValues,
            projectInterface.option,
            controllerName,
            resourceName,
            { taskId: task.id, taskName: task.taskName },
          ),
        );
      }
      continue;
    }

    const taskDef = projectInterface.task.find((item) => item.name === task.taskName);
    if (!taskDef || !projectInterface.option) continue;

    const resourceOptionKeys =
      projectInterface.resource.find((item) => item.name === resourceName)?.option ?? [];
    const controllerOptionKeys =
      projectInterface.controller.find((item) => item.name === controllerName)?.option ?? [];
    const optionKeys = [
      ...new Set([...resourceOptionKeys, ...controllerOptionKeys, ...(taskDef.option ?? [])]),
    ];

    violations.push(
      ...validateOptionKeys(
        optionKeys,
        task.optionValues,
        projectInterface.option,
        controllerName,
        resourceName,
        { taskId: task.id, taskName: task.taskName },
      ),
    );
  }

  return violations;
}

/** 只看 checkbox 数量约束（保持既有调用方语义）。 */
export function validateInstanceCheckboxCounts(
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  controllerName?: string,
  resourceName?: string,
  globalOptionValues: Record<string, OptionValue> = {},
): CheckboxCountViolation[] {
  return validateInstanceOptionViolations(
    tasks,
    projectInterface,
    controllerName,
    resourceName,
    globalOptionValues,
  ).filter((violation): violation is CheckboxCountViolation => violation.type === 'checkbox');
}

/**
 * 只看输入值合法性：值为空（但格式要求不接受空）或不符合 `verify` 时，调用方必须拒绝运行。
 * 这里只报告，不改写任何值——不合法就是用户的输入，交给他自己修。
 */
export function validateInstanceInputValues(
  tasks: SelectedTask[],
  projectInterface: ProjectInterface | null,
  controllerName?: string,
  resourceName?: string,
  globalOptionValues: Record<string, OptionValue> = {},
): InputValueViolation[] {
  return validateInstanceOptionViolations(
    tasks,
    projectInterface,
    controllerName,
    resourceName,
    globalOptionValues,
  ).filter((violation): violation is InputValueViolation => violation.type === 'input');
}
