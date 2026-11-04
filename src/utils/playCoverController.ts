import type { PlayCoverControllerConfig } from '@/types/maa';
import type { ControllerDisplayOptions } from '@/types/interface';
import { getControllerDisplayOptions } from './controllerDisplay';

export function buildPlayCoverControllerConfig(
  address: string,
  uuid?: string,
  display?: number | ControllerDisplayOptions,
): PlayCoverControllerConfig {
  return {
    type: 'PlayCover',
    address,
    uuid: uuid || 'maa.playcover',
    ...getControllerDisplayOptions(
      typeof display === 'number' ? { display_short_side: display } : display,
    ),
  };
}
