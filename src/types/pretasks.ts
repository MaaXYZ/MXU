// ============================================================================
// PI V2 v2.7.0 pretask（预任务）支持
// ----------------------------------------------------------------------------
// 将项目在 interface.json 中声明的 pretask 映射为“伪任务”，复用现有任务的
// 勾选/展开/选项渲染机制，与前置程序共同组成可排序的启动步骤。
// pretask 在连接 Controller 之前执行，且不进入 Tasker 执行队列，而是通过
// run_pretask 直接启动外部程序。
// ============================================================================

import type {
  ProjectInterface,
  PretaskItem,
  TaskItem,
  OptionValue,
  OptionDefinition,
} from './interface';
import { findSwitchCase } from '@/utils/optionHelpers';
import { createDefaultOptionValue, sanitizeOptionValue } from '@/stores/helpers';
import { loggers } from '@/utils/logger';

/** pretask 伪任务在流程中的入口节点名（pretask 不进 Tasker，仅作占位） */
export const PRETASK_ENTRY = 'MXU_PRETASK';

export {
  PRETASK_NAME_PREFIX,
  pretaskItemId,
  pretaskName,
  isPretaskName,
  getPretaskItems,
  getPretaskItem,
} from './pretaskIdentity';
import { pretaskName, isPretaskName, getPretaskItem } from './pretaskIdentity';

/**
 * 由 pretask 条目构造一个供 UI 复用的虚拟 TaskItem。
 * option 直接引用顶层 pi.option，因此可复用标准的选项渲染与初始化。
 */
export function buildPretaskDef(item: PretaskItem): TaskItem {
  return {
    name: pretaskName(item),
    // 缺省 label 时回退到 name / exec，避免展示内部伪任务名
    label: item.label || item.name || item.exec,
    entry: PRETASK_ENTRY,
    description: item.description,
    icon: item.icon,
    option: item.option,
    controller: item.controller,
    resource: item.resource,
  };
}

/**
 * 统一解析用于兼容性判断的 Task 定义：
 * - 普通任务：从 projectInterface.task 查找
 * - pretask 伪任务：由 pretask 条目生成虚拟 TaskItem
 */
export function resolveCompatTaskDef(
  pi: ProjectInterface | null | undefined,
  taskName: string,
): TaskItem | undefined {
  if (!pi) return undefined;
  if (isPretaskName(taskName)) {
    const item = getPretaskItem(pi, taskName);
    return item ? buildPretaskDef(item) : undefined;
  }
  return pi.task.find((t) => t.name === taskName);
}

/**
 * 按协议将 pretask 的 option 当前取值序列化为 { [optionKey]: OptionValue } 对象。
 * - select / switch -> case.name 字符串
 * - checkbox -> case.name 字符串数组
 * - input / hotkey -> { 输入名: 值 }
 * 递归包含因选择而激活的嵌套 option；跳过不满足 controller/resource 限制的 option。
 */
function collectPretaskOptionValues(
  optionKey: string,
  optionValues: Record<string, OptionValue>,
  allOptions: Record<string, OptionDefinition>,
  result: Record<string, unknown>,
  controllerName?: string,
  resourceName?: string,
): void {
  const optionDef = allOptions[optionKey];
  if (!optionDef) {
    loggers.task.warn(
      `pretask 引用了未定义的 option "${optionKey}"，序列化时将跳过；请确认 pretask.option 与 pi.option 中的键名一致`,
    );
    return;
  }

  // 过滤不满足当前 controller / resource 的 option
  if (optionDef.controller && optionDef.controller.length > 0) {
    if (!controllerName || !optionDef.controller.includes(controllerName)) return;
  }
  if (optionDef.resource && optionDef.resource.length > 0) {
    if (!resourceName || !optionDef.resource.includes(resourceName)) return;
  }

  if (result[optionKey] !== undefined) return;

  const savedValue = optionValues[optionKey];
  const sanitizedValue = savedValue ? sanitizeOptionValue(optionKey, savedValue, allOptions) : null;
  const optionValue = sanitizedValue || createDefaultOptionValue(optionDef);

  if (optionValue.type === 'checkbox') {
    result[optionKey] = [...optionValue.caseNames];
    return;
  }

  if (optionValue.type === 'input') {
    const values: Record<string, string> = {};
    if (optionDef.type === 'input') {
      for (const input of optionDef.inputs || []) {
        values[input.name] = optionValue.values[input.name] ?? input.default ?? '';
      }
    }
    result[optionKey] = values;
    return;
  }

  if (optionValue.type === 'hotkey') {
    const values: Record<string, string> = {};
    if (optionDef.type === 'hotkey') {
      for (const input of optionDef.hotkeys || []) {
        values[input.name] = optionValue.values[input.name] ?? input.default ?? '';
      }
    }
    result[optionKey] = values;
    return;
  }

  // select / switch
  let caseName: string;
  if (optionValue.type === 'switch') {
    const switchCase =
      'cases' in optionDef ? findSwitchCase(optionDef.cases, optionValue.value) : undefined;
    caseName = switchCase?.name || (optionValue.value ? 'Yes' : 'No');
  } else {
    caseName = optionValue.caseName;
  }
  result[optionKey] = caseName;

  // 递归处理激活 case 的嵌套 option
  if ('cases' in optionDef) {
    const caseDef = optionDef.cases?.find((c) => c.name === caseName);
    if (caseDef?.option) {
      for (const nestedKey of caseDef.option) {
        collectPretaskOptionValues(
          nestedKey,
          optionValues,
          allOptions,
          result,
          controllerName,
          resourceName,
        );
      }
    }
  }
}

/**
 * 生成 pretask option 取值的单行紧凑 JSON 字符串。
 * 若 item.option 未设置或为空则返回 undefined（不追加该参数）。
 */
export function serializePretaskOptions(
  item: PretaskItem,
  optionValues: Record<string, OptionValue>,
  pi: ProjectInterface | null | undefined,
  controllerName?: string,
  resourceName?: string,
): string | undefined {
  if (!item.option || item.option.length === 0) return undefined;
  const allOptions = pi?.option || {};
  const result: Record<string, unknown> = {};
  for (const optionKey of item.option) {
    collectPretaskOptionValues(
      optionKey,
      optionValues,
      allOptions,
      result,
      controllerName,
      resourceName,
    );
  }
  return JSON.stringify(result);
}

/**
 * 构造传给外部程序的完整参数数组：固定 args 后追加序列化后的 option JSON（若有）。
 */
export function buildPretaskArgs(
  item: PretaskItem,
  optionValues: Record<string, OptionValue>,
  pi: ProjectInterface | null | undefined,
  controllerName?: string,
  resourceName?: string,
): string[] {
  const args = [...(item.args || [])];
  const optionJson = serializePretaskOptions(item, optionValues, pi, controllerName, resourceName);
  if (optionJson !== undefined) {
    args.push(optionJson);
  }
  return args;
}
