import type { PresetItem } from '../types/interface';

/** PI v2.10.4: 按 controller.name 过滤预设，与 task.controller 保持一致。 */
export function isPresetCompatible(
  preset: PresetItem,
  controllerName: string | undefined,
): boolean {
  return (
    !preset.controller?.length || !controllerName || preset.controller.includes(controllerName)
  );
}
