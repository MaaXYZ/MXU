/** Shared admission and cancellation for UI, schedules, hotkeys, and MCP. */
export interface TaskExecutionLease {
  readonly instanceId: string;
  readonly source: 'client' | 'mcp';
  readonly token: string;
  backendReserved: boolean;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  release(): void;
}

export const START_CANCELLED = 'MXU_PRE_ACTION_CANCELLED';

const leases = new Map<string, TaskExecutionLease>();

export const taskExecutionGate = {
  get(instanceId: string) {
    return leases.get(instanceId);
  },

  acquire(instanceId: string, source: TaskExecutionLease['source']): TaskExecutionLease | null {
    if (leases.has(instanceId)) return null;
    let finish!: () => void;
    const lease: TaskExecutionLease = {
      instanceId,
      source,
      token: crypto.randomUUID(),
      backendReserved: false,
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      release() {
        if (leases.get(instanceId) !== lease) return;
        leases.delete(instanceId);
        finish();
      },
    };
    leases.set(instanceId, lease);
    return lease;
  },

  cancel(instanceId: string) {
    leases.get(instanceId)?.controller.abort();
  },
};

export function checkStartCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error(START_CANCELLED);
}

/** An in-flight call is drained before cancellation can finish; later calls never start. */
export function guardStartupCalls<T extends object>(service: T, signal?: AbortSignal): T {
  if (!signal) return service;
  return new Proxy(service, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        checkStartCancelled(signal);
        const result: unknown = Reflect.apply(member, target, args);
        if (result instanceof Promise) {
          return result.then((value: unknown) => {
            checkStartCancelled(signal);
            return value;
          });
        }
        checkStartCancelled(signal);
        return result;
      };
    },
  });
}
