export function hasValidUinputDimensions(width?: number, height?: number): boolean {
  return [width, height].every(
    (value) => value !== undefined && Number.isInteger(value) && value > 0 && value <= 2147483647,
  );
}

/** 空值或非法尺寸不能作为 UInput 的绝对坐标范围。 */
export function parseUinputDimension(value: string): number | undefined {
  const n = Number(value.trim());
  return hasValidUinputDimensions(n, n) ? n : undefined;
}
