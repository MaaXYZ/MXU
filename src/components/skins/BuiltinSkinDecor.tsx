import { useAppStore } from '@/stores/appStore';
import { DeepseekDecor } from './DeepseekDecor';
import { NaiwaDecor } from './NaiwaDecor';
import type { SkinDecorSlot } from '@/skins/types';

export function BuiltinSkinDecor({ slot }: { slot: SkinDecorSlot }) {
  const skinId = useAppStore((state) => state.skinId);
  if (skinId === 'deepseek') return <DeepseekDecor slot={slot} />;
  if (skinId === 'naiwa') return <NaiwaDecor slot={slot} />;
  return null;
}
