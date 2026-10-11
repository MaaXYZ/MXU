import type { OptionValue, OptionDefinition, PresetOptionValue, TaskItem } from '@/types/interface';
import { findSwitchCase } from '@/utils/optionHelpers';
import { resolveInputValue } from '@/utils/optionInputValue';
import type { AppState } from './types';

/** 生成唯一 ID */
export const generateId = () => Math.random().toString(36).substring(2, 9);

/** 创建默认选项值 */
export const createDefaultOptionValue = (optionDef: OptionDefinition): OptionValue => {
  if (optionDef.type === 'input') {
    const values: Record<string, string> = {};
    optionDef.inputs.forEach((input) => {
      values[input.name] = input.default || '';
    });
    return { type: 'input', values };
  }

  if (optionDef.type === 'hotkey') {
    const values: Record<string, string> = {};
    optionDef.hotkeys.forEach((input) => {
      values[input.name] = input.default || '';
    });
    return { type: 'hotkey', values };
  }

  if (optionDef.type === 'switch') {
    const defaultCase = optionDef.default_case || optionDef.cases[0]?.name || 'Yes';
    const isYes = ['Yes', 'yes', 'Y', 'y'].includes(defaultCase);
    return { type: 'switch', value: isYes };
  }

  if (optionDef.type === 'checkbox') {
    const defaultCases = optionDef.default_case || [];
    return { type: 'checkbox', caseNames: [...defaultCases] };
  }

  // select type (default)
  const defaultCase = optionDef.default_case || optionDef.cases[0]?.name || '';
  return { type: 'select', caseName: defaultCase };
};

export type OptionValueSanitizeLogger = (message: string) => void;

/**
 * 校验保存的选项值是否仍符合当前 Project Interface 定义。
 * 返回 null 表示应丢弃保存值并回退到当前默认值。
 */
export const sanitizeOptionValue = (
  optionKey: string,
  value: OptionValue,
  allOptions: Record<string, OptionDefinition>,
  warn?: OptionValueSanitizeLogger,
): OptionValue | null => {
  const optionDef = allOptions[optionKey];
  if (!optionDef) {
    warn?.(`选项 "${optionKey}" 已不存在，已丢弃保存值`);
    return null;
  }

  const expectedType = optionDef.type || 'select';
  if (value.type !== expectedType) {
    warn?.(
      `选项 "${optionKey}" 的类型已从 "${value.type}" 变更为 "${expectedType}"，已重置为默认值`,
    );
    return null;
  }

  if ((!optionDef.type || optionDef.type === 'select') && value.type === 'select') {
    const caseExists = optionDef.cases.some((caseDef) => caseDef.name === value.caseName);
    if (!caseExists) {
      warn?.(`选项 "${optionKey}" 的 case "${value.caseName}" 已不存在，已重置为默认值`);
      return null;
    }
    return value;
  }

  if (optionDef.type === 'checkbox' && value.type === 'checkbox') {
    const validNames = new Set(optionDef.cases.map((caseDef) => caseDef.name));
    const caseNames = value.caseNames.filter((caseName) => validNames.has(caseName));
    if (caseNames.length !== value.caseNames.length) {
      const removedNames = value.caseNames.filter((caseName) => !validNames.has(caseName));
      warn?.(`选项 "${optionKey}" 包含已不存在的 case "${removedNames.join(', ')}"，已过滤`);
    }
    if (value.caseNames.length > 0 && caseNames.length === 0) {
      warn?.(`选项 "${optionKey}" 保存的 case 已全部失效，已重置为默认值`);
      return null;
    }
    return { type: 'checkbox', caseNames };
  }

  if (optionDef.type === 'input' && value.type === 'input') {
    const inputsByName = new Map(optionDef.inputs.map((input) => [input.name, input]));
    const values: Record<string, string> = {};
    for (const [name, val] of Object.entries(value.values)) {
      const input = inputsByName.get(name);
      if (!input) continue;
      // 落盘前消除空值：声明了 default 的输入补回 default，同时把 JSON 里的 null 归一成字符串。
      // 配置文件里不应再出现 "" / null（见 utils/optionInputValue.ts）。
      values[name] = resolveInputValue(input, val);
    }
    const encryptedValues: Record<string, string> = {};
    if (value.encryptedValues) {
      for (const [name, val] of Object.entries(value.encryptedValues)) {
        if (inputsByName.has(name)) encryptedValues[name] = val;
      }
    }
    return {
      type: 'input',
      values,
      ...(Object.keys(encryptedValues).length > 0 ? { encryptedValues } : {}),
    };
  }

  return value;
};

export const sanitizeOptionValues = (
  optionValues: Record<string, OptionValue>,
  allOptions: Record<string, OptionDefinition>,
  warn?: OptionValueSanitizeLogger,
): Record<string, OptionValue> => {
  const cleaned: Record<string, OptionValue> = {};
  for (const [optionKey, value] of Object.entries(optionValues)) {
    const sanitized = sanitizeOptionValue(optionKey, value, allOptions, warn);
    if (sanitized) {
      cleaned[optionKey] = sanitized;
    }
  }
  return cleaned;
};

/**
 * 递归初始化所有选项（包括嵌套选项）的默认值
 * @param optionKeys 顶层选项键列表
 * @param allOptions 所有选项定义
 * @param result 结果对象（用于递归累积）
 */
export const initializeAllOptionValues = (
  optionKeys: string[],
  allOptions: Record<string, OptionDefinition>,
  result: Record<string, OptionValue> = {},
): Record<string, OptionValue> => {
  for (const optKey of optionKeys) {
    const optDef = allOptions[optKey];
    if (!optDef) continue;

    // 如果已经初始化过，跳过（避免循环引用）
    if (result[optKey]) continue;

    // 创建当前选项的默认值
    result[optKey] = createDefaultOptionValue(optDef);

    // 处理嵌套选项：根据当前默认值找到对应的 case，递归初始化其子选项
    if (optDef.type === 'switch' || optDef.type === 'select' || !optDef.type) {
      const currentValue = result[optKey];
      let selectedCase;

      if (optDef.type === 'switch' && 'cases' in optDef) {
        const isChecked = currentValue.type === 'switch' && currentValue.value;
        selectedCase = findSwitchCase(optDef.cases, isChecked);
      } else if ('cases' in optDef) {
        const caseName =
          currentValue.type === 'select' ? currentValue.caseName : optDef.cases?.[0]?.name;
        selectedCase = optDef.cases?.find((c) => c.name === caseName);
      }

      // 递归初始化嵌套选项
      if (selectedCase?.option && selectedCase.option.length > 0) {
        initializeAllOptionValues(selectedCase.option, allOptions, result);
      }
    }
  }

  return result;
};

/**
 * v2.3.0: 将预设的选项值转换为运行时 OptionValue
 */
export const convertPresetOptionValue = (
  optionKey: string,
  presetValue: PresetOptionValue,
  allOptions: Record<string, OptionDefinition>,
): OptionValue | null => {
  const optDef = allOptions[optionKey];
  if (!optDef) return null;

  if (optDef.type === 'switch' && typeof presetValue === 'string') {
    const isYes = ['Yes', 'yes', 'Y', 'y'].includes(presetValue);
    return { type: 'switch', value: isYes };
  }

  if (optDef.type === 'checkbox' && Array.isArray(presetValue)) {
    const validNames = new Set((optDef.cases || []).map((c) => c.name));
    const caseNames = (presetValue as string[]).filter((name) => validNames.has(name));
    return { type: 'checkbox', caseNames };
  }

  if (optDef.type === 'input' && typeof presetValue === 'object' && !Array.isArray(presetValue)) {
    return { type: 'input', values: presetValue as Record<string, string> };
  }

  if (optDef.type === 'hotkey' && typeof presetValue === 'object' && !Array.isArray(presetValue)) {
    return { type: 'hotkey', values: presetValue as Record<string, string> };
  }

  if ((!optDef.type || optDef.type === 'select') && typeof presetValue === 'string') {
    return { type: 'select', caseName: presetValue };
  }

  return null;
};

/** 获取实例当前控制器和资源名称（统一 fallback 顺序） */
export const getCurrentControllerAndResource = (
  state: Pick<
    AppState,
    'projectInterface' | 'instances' | 'selectedController' | 'selectedResource'
  >,
  instanceId: string,
) => {
  const pi = state.projectInterface;
  const instance = state.instances.find((i) => i.id === instanceId);

  const controllerName =
    state.selectedController[instanceId] || instance?.controllerName || pi?.controller[0]?.name;

  const resourceName =
    state.selectedResource[instanceId] || instance?.resourceName || pi?.resource[0]?.name;

  return { controllerName, resourceName };
};

/** 检查任务是否与指定控制器/资源兼容 */
export const isTaskCompatible = (
  taskDef: TaskItem | undefined | null,
  controllerName: string | undefined,
  resourceName: string | undefined,
): boolean => {
  if (
    taskDef?.controller &&
    taskDef.controller.length > 0 &&
    controllerName &&
    !taskDef.controller.includes(controllerName)
  ) {
    return false;
  }
  if (
    taskDef?.resource &&
    taskDef.resource.length > 0 &&
    resourceName &&
    !taskDef.resource.includes(resourceName)
  ) {
    return false;
  }
  return true;
};
