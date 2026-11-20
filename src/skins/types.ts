/** Reviewed skins bundled with MXU; configuration cannot name external content. */
export type BuiltinSkinId = 'default' | 'deepseek' | 'naiwa' | 'gugugaga';

/** Order shown in settings. */
export const BUILTIN_SKIN_IDS: readonly BuiltinSkinId[] = [
  'default',
  'deepseek',
  'naiwa',
  'gugugaga',
];

/** Old configurations and unrecognized skin identifiers use the standard interface. */
export function normalizeBuiltinSkinId(value: unknown): BuiltinSkinId {
  return value === 'deepseek' || value === 'naiwa' || value === 'gugugaga' ? value : 'default';
}
