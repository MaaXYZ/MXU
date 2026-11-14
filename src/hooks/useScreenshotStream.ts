import { useEffect } from 'react';
import { maaService } from '@/services/maaService';
import { generateId } from '@/stores/helpers';
import { loggers } from '@/utils/logger';

// The backend expires subscribers after 30s, even at a 30s frame interval.
const RENEW_INTERVAL_MS = 10_000;

export function useScreenshotStream(
  instanceId: string,
  enabled: boolean,
  intervalMs: number,
  captureFrame: () => Promise<string | null>,
  onFrame: (frame: string) => void,
  onError?: (error: unknown, consecutiveFailures: number) => void,
) {
  useEffect(() => {
    if (!instanceId || !enabled) return;

    // A late unsubscribe from a previous connection or another window must
    // release only its own lease. Renewal reuses this ID.
    const subscriberId = generateId();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let pending: Promise<void>;
    const subscribe = () => {
      pending = maaService
        .screenshotSubscribe(instanceId, subscriberId, intervalMs)
        .catch((error) => loggers.ui.warn('截图订阅失败:', error));
      void pending.then(() => {
        if (active) timer = setTimeout(subscribe, RENEW_INTERVAL_MS);
      });
    };
    subscribe();
    return () => {
      active = false;
      clearTimeout(timer);
      void pending
        .then(() => maaService.screenshotUnsubscribe(instanceId, subscriberId))
        .catch(() => {});
    };
  }, [instanceId, enabled, intervalMs]);

  useEffect(() => {
    if (!instanceId || !enabled) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const readFrame = async () => {
      const started = Date.now();
      try {
        const frame = await captureFrame();
        if (active && frame) {
          failures = 0;
          onFrame(frame);
        }
      } catch (error) {
        if (active) onError?.(error, ++failures);
      }
      if (active) timer = setTimeout(readFrame, Math.max(0, intervalMs - (Date.now() - started)));
    };
    void readFrame();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [instanceId, enabled, intervalMs, captureFrame, onFrame, onError]);
}
