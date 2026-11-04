import type { OptionDefinition, SelectedTask } from '@/types/interface';
import type { ContainerTaskDefinition } from '@/types/containerTasks';

/**
 * 计算子条目显示名的后缀段（返回选项 case 的标签键，由调用方做 i18n 解析）。
 *
 * 规则来自容器的 `displaySuffix` 声明：第一段取指定选项当前 case 的标签；
 * `followCaseOption` 为 true 时追加第二段——取「当前 case 名同名的选项」
 * 的当前 case 标签（用于「协议空间-分页-细分种类」这类命名）。
 *
 * 选项未选择、定义缺失或类型不符时返回已解析出的段（可能为空数组）。
 */
export function getChildDisplaySegments(
  def: ContainerTaskDefinition,
  child: SelectedTask,
  optionDefs: Record<string, OptionDefinition> | undefined,
): string[] {
  const rule = def.displaySuffix;
  if (!rule || !optionDefs) return [];

  const resolveCaseLabel = (optionKey: string): { label: string; caseName: string } | undefined => {
    const optionDef = optionDefs[optionKey];
    const value = child.optionValues[optionKey];
    if (!optionDef || !('cases' in optionDef) || value?.type !== 'select') return undefined;
    const caseDef = (optionDef.cases ?? []).find((c) => c.name === value.caseName);
    if (!caseDef?.label) return undefined;
    return { label: caseDef.label, caseName: value.caseName };
  };

  const segments: string[] = [];
  const first = resolveCaseLabel(rule.optionKey);
  if (!first) return segments;
  segments.push(first.label);

  if (rule.followCaseOption) {
    const second = resolveCaseLabel(first.caseName);
    if (second) segments.push(second.label);
  }
  return segments;
}
