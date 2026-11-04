const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** 本地自然日的星期，与任务周计划使用同一时间基准。 */
export function getCurrentWeekday(): number {
  return new Date().getDay();
}

function scheduleRefresh(): void {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // 午夜准时更新；每分钟重新校准，兼顾系统时间或时区被修改的情况。
  timer = setTimeout(refresh, Math.min(midnight.getTime() - now.getTime(), 60_000));
}

function refresh(): void {
  clearTimeout(timer);
  for (const listener of listeners) listener();
  if (listeners.size > 0) scheduleRefresh();
}

/** 所有组件共享一个时钟；休眠或后台恢复后立即重新读取日期。 */
export function subscribeCurrentWeekday(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    scheduleRefresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    }
  };
}
