import type { PlayCoverControllerConfig } from '@/types/maa';

export function buildPlayCoverControllerConfig(
  address: string,
  uuid?: string,
  displayShortSide?: number,
): PlayCoverControllerConfig {
  return {
    type: 'PlayCover',
    address,
    uuid: uuid || 'maa.playcover',
    display_short_side: displayShortSide,
  };
}
