import type { ControllerItem } from '../types/interface';
import type { IosControllerConfig } from '../types/maa';
import { getControllerDisplayOptions } from './controllerDisplay';

export function buildIosControllerConfig(
  controller: ControllerItem,
  selectedUdid?: string,
): IosControllerConfig {
  const udid = controller.ios?.udid?.trim() || selectedUdid?.trim();
  if (!udid) throw new Error('IOS_UDID_REQUIRED');
  const names = controller.ios?.screencap
    ?.split(/[|,]/)
    .map((name) => name.trim())
    .filter(Boolean);
  const methods: Record<string, bigint> = { Stream: 1n, ScreenshotService: 2n };
  if (names?.some((name) => !Object.prototype.hasOwnProperty.call(methods, name)))
    throw new Error('IOS_CONFIG_INVALID');
  const connection = controller.ios?.connection ?? 'Auto';
  const connections = { Auto: 0, USB: 1, WiFi: 2 };
  if (!Object.prototype.hasOwnProperty.call(connections, connection))
    throw new Error('IOS_CONFIG_INVALID');
  return {
    type: 'IOS',
    udid,
    connection_method: connections[connection],
    screencap_methods: (names?.length
      ? names.reduce((mask, name) => mask | methods[name], 0n)
      : 3n
    ).toString(),
    config: JSON.stringify(controller.ios?.config ?? {}),
    ...getControllerDisplayOptions(controller),
  };
}
