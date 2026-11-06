import type { ControllerDisplayOptions } from '../types/interface';

/** 保留互斥的 PI 截图缩放模式，不在传输层提前填入默认短边。 */
export function getControllerDisplayOptions(
  controller?: ControllerDisplayOptions,
): ControllerDisplayOptions {
  const modes = [
    controller?.display_short_side !== undefined,
    controller?.display_long_side !== undefined,
    controller?.display_expand !== undefined,
    controller?.display_raw === true,
  ];
  const dimensions = [
    controller?.display_short_side,
    controller?.display_long_side,
    ...(controller?.display_expand ?? []),
  ].filter((value) => value !== undefined);
  if (
    modes.filter(Boolean).length > 1 ||
    (controller?.display_expand && controller.display_expand.length !== 2) ||
    dimensions.some((value) => !Number.isInteger(value) || value <= 0 || value > 2147483647)
  ) {
    throw new Error('PI_DISPLAY_OPTIONS_INVALID');
  }
  return {
    display_short_side: controller?.display_short_side,
    ...(controller?.display_long_side !== undefined && {
      display_long_side: controller.display_long_side,
    }),
    ...(controller?.display_expand !== undefined && { display_expand: controller.display_expand }),
    ...(controller?.display_raw !== undefined && { display_raw: controller.display_raw }),
  };
}
