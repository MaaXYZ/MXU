/**
 * 选项相关的工具函数
 */

import type { CaseItem, OptionDefinition, OptionValue } from '@/types/interface';

const YES_CASE_NAMES = ['Yes', 'yes', 'Y', 'y'] as const;

const NO_CASE_NAMES = ['No', 'no', 'N', 'n'] as const;

/**
 * 根据 Switch 的选中状态查找对应的 case
 * @param cases case 列表
 * @param isChecked switch 是否选中
 * @returns 匹配的 case，如果没有找到返回 undefined
 */
export function findSwitchCase(
  cases: CaseItem[] | undefined,
  isChecked: boolean,
): CaseItem | undefined {
  if (!cases) return undefined;

  const targetNames: readonly string[] = isChecked ? YES_CASE_NAMES : NO_CASE_NAMES;
  return cases.find((c) => targetNames.includes(c.name));
}

/**
 * 找出「当前选中且带子选项」的 case 列表，供渲染嵌套 option 使用。
 *
 * - switch / select：单选，最多返回 1 个
 * - checkbox：多选，可能返回多个（按 cases 定义顺序，保证渲染顺序稳定）
 * - input / hotkey：无 case，返回空数组
 *
 * 只返回 option 非空的 case，调用方无需再判断。
 */
export function getSelectedCasesWithOptions(
  optionDef: OptionDefinition,
  value: OptionValue | undefined,
): CaseItem[] {
  const hasNestedOption = (caseItem: CaseItem) => (caseItem.option?.length ?? 0) > 0;

  if (optionDef.type === 'checkbox') {
    const selectedCases =
      value?.type === 'checkbox' ? value.caseNames : (optionDef.default_case ?? []);
    return optionDef.cases.filter((c) => selectedCases.includes(c.name) && hasNestedOption(c));
  }

  if (optionDef.type === 'switch') {
    const isChecked = value?.type === 'switch' ? value.value : false;
    const matched = findSwitchCase(optionDef.cases, isChecked);
    return matched && hasNestedOption(matched) ? [matched] : [];
  }

  if (optionDef.type === 'select' || !optionDef.type) {
    const caseName =
      value?.type === 'select'
        ? value.caseName
        : optionDef.default_case || optionDef.cases?.[0]?.name;
    const matched = optionDef.cases?.find((c) => c.name === caseName);
    return matched && hasNestedOption(matched) ? [matched] : [];
  }

  return [];
}
