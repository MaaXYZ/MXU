import type { MaaCallbackDetails, MaaCallbackEvent } from '@/services/maaService';

export type MaaCallbackHandler = (
  message: string,
  details: MaaCallbackDetails,
  instanceId?: string | null,
) => void;

/** 两种传输共用同一解码入口，解析失败也必须保留来源。 */
export function dispatchMaaCallback(
  event: MaaCallbackEvent,
  callback: MaaCallbackHandler,
  onInvalidDetails: (details: string) => void,
): void {
  let details: MaaCallbackDetails;
  try {
    const parsed: unknown = JSON.parse(event.details);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Callback details must be an object');
    }
    details = parsed as MaaCallbackDetails;
  } catch {
    onInvalidDetails(event.details);
    details = {};
  }
  callback(event.message, details, event.instance_id);
}

/**
 * 仅将有明确来源的回调路由到仍存在的实例。
 * 框架全局事件、旧服务端事件和已销毁实例的迟到回调不能归属到当前活动标签页。
 */
export function getCallbackInstanceId(
  sourceInstanceId: string | null | undefined,
  instances: readonly { id: string }[],
): string | undefined {
  if (!sourceInstanceId) return undefined;
  return instances.some((instance) => instance.id === sourceInstanceId)
    ? sourceInstanceId
    : undefined;
}
