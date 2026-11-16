/** Reviewed skins bundled with MXU; configuration cannot name external content. */
export type BuiltinSkinId = 'default' | 'deepseek' | 'naiwa';

/** Old configurations and unrecognized skin identifiers use the standard interface. */
export function normalizeBuiltinSkinId(value: unknown): BuiltinSkinId {
  return value === 'deepseek' || value === 'naiwa' ? value : 'default';
}
