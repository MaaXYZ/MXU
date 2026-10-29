import { useSyncExternalStore } from 'react';
import { getCurrentWeekday, subscribeCurrentWeekday } from '@/utils/currentWeekday';

/** 跨午夜或窗口恢复时刷新，供周计划提示与启动按钮共用。 */
export function useCurrentWeekday(): number {
  return useSyncExternalStore(subscribeCurrentWeekday, getCurrentWeekday, getCurrentWeekday);
}
