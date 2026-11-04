import type { TaskExecutionLease } from './taskExecutionGate';

export type RunState = 'starting' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped';
export type EntryState = 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped';
export interface PiMcpErrorData {
  code: string;
  message: string;
  path?: string;
}
export class PiMcpError extends Error {
  constructor(readonly detail: PiMcpErrorData) {
    super(detail.message);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

export interface RunTask {
  name: string;
  option?: Record<string, unknown>;
}
export interface StartRequest {
  instance_id: string;
  context_revision: string;
  request_id: string;
  tasks: RunTask[];
}
export interface PreparedRun<S> {
  snapshot: S;
  tasks: { name: string; option: Record<string, unknown> }[];
  secrets: string[];
}
interface RunRecord<S> {
  id: string;
  instanceId: string;
  requestId: string;
  signature: string;
  state: RunState;
  tasks: { index: number; name: string; state: EntryState; option: Record<string, unknown> }[];
  error?: PiMcpErrorData;
  snapshot?: S;
  secrets: string[];
  lease: TaskExecutionLease;
  logs: { sequence: number; level: string; message: string }[];
  sequence: number;
  cancellation?: Promise<void>;
}
export interface RuntimeHooks<S> {
  prepare(request: StartRequest): PreparedRun<S>;
  acquire(instanceId: string): TaskExecutionLease;
  execute(
    snapshot: S,
    lease: TaskExecutionLease,
    entry: (index: number, state: EntryState) => void,
  ): Promise<void>;
  cancel(snapshot: S, lease: TaskExecutionLease): Promise<void>;
  cleanup(snapshot: S, lease: TaskExecutionLease, failed: boolean): Promise<void>;
  error(code: string, path?: string): PiMcpError;
  id(): string;
}

export function isTerminal(state: RunState) {
  return state === 'succeeded' || state === 'failed' || state === 'stopped';
}

export class PiMcpRuntime<S> {
  private runs = new Map<string, RunRecord<S>>();
  private requests = new Map<string, Map<string, RunRecord<S>>>();
  constructor(
    private readonly hooks: RuntimeHooks<S>,
    private readonly capacity = 1000,
  ) {}

  start(request: StartRequest) {
    const signature = canonicalJson(request);
    const previous = this.requests.get(request.instance_id)?.get(request.request_id);
    if (previous) {
      if (previous.signature !== signature) throw this.hooks.error('request_conflict');
      return { run_id: previous.id, state: previous.state };
    }
    if (this.runs.size >= this.capacity) throw this.hooks.error('resource_exhausted');
    // prepare and acquire are synchronous: no local edit can interleave with admission.
    const prepared = this.hooks.prepare(request);
    const lease = this.hooks.acquire(request.instance_id);
    const record: RunRecord<S> = {
      id: this.hooks.id(),
      instanceId: request.instance_id,
      requestId: request.request_id,
      signature,
      state: 'starting',
      snapshot: prepared.snapshot,
      secrets: prepared.secrets,
      tasks: prepared.tasks.map((task, index) => ({ ...task, index, state: 'pending' })),
      lease,
      logs: [],
      sequence: 0,
    };
    this.runs.set(record.id, record);
    const requests = this.requests.get(request.instance_id) ?? new Map<string, RunRecord<S>>();
    requests.set(request.request_id, record);
    this.requests.set(request.instance_id, requests);
    // Return acceptance before entering any asynchronous preparation.
    void Promise.resolve().then(() => this.execute(record));
    return { run_id: record.id, state: record.state };
  }

  private async execute(record: RunRecord<S>) {
    const snapshot = record.snapshot!;
    let failure: PiMcpErrorData | undefined;
    try {
      await this.hooks.execute(snapshot, record.lease, (index, state) => {
        if (record.lease.controller.signal.aborted && state === 'running') return;
        if (state === 'running') record.state = 'running';
        record.tasks[index].state = state;
      });
    } catch (error) {
      failure =
        error instanceof PiMcpError
          ? error.detail
          : this.hooks.error(
              error === 'instance_busy' ||
                (error instanceof Error && error.message === 'instance_busy')
                ? 'instance_busy'
                : 'execution_failed',
            ).detail;
    }
    // Cleanup must drain startup and Tasker work before releasing admission or publishing a terminal state.
    for (;;) {
      try {
        await record.cancellation;
        await this.hooks.cleanup(snapshot, record.lease, !!failure);
        break;
      } catch {
        // Preserve ownership until startup/Tasker cleanup can actually be established.
        record.state = 'stopping';
        record.error = this.hooks.error('execution_failed').detail;
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    }
    const stopped = record.lease.controller.signal.aborted;
    record.state = stopped ? 'stopped' : failure ? 'failed' : 'succeeded';
    if (failure && !stopped) record.error = failure;
    else delete record.error;
    for (const task of record.tasks) {
      if (task.state === 'pending') task.state = 'skipped';
      if (task.state === 'running') task.state = stopped ? 'stopped' : 'failed';
    }
    record.lease.release();
    record.snapshot = undefined;
    record.secrets = [];
  }

  private find(instanceId: string, runId: string) {
    const record = this.runs.get(runId);
    if (!record || record.instanceId !== instanceId) throw this.hooks.error('run_not_found');
    return record;
  }

  stop(instanceId: string, runId: string) {
    const record = this.find(instanceId, runId);
    if (!isTerminal(record.state)) {
      record.state = 'stopping';
      record.lease.controller.abort();
      record.cancellation ??= this.hooks.cancel(record.snapshot!, record.lease).catch(() => {
        record.error = this.hooks.error('execution_failed').detail;
      });
    }
    return { run_id: record.id, state: record.state };
  }

  active(instanceId: string) {
    return (
      [...this.runs.values()].find((run) => run.instanceId === instanceId && !isTerminal(run.state))
        ?.id ?? null
    );
  }

  appendLog(instanceId: string, level: string, message: string) {
    const id = this.active(instanceId);
    if (!id) return;
    const record = this.runs.get(id)!;
    for (const secret of record.secrets)
      if (secret) message = message.split(secret).join('[redacted]');
    record.logs.push({ sequence: ++record.sequence, level, message });
    if (record.logs.length > 500) record.logs.shift();
  }

  status(instanceId: string, runId: string, after?: string, limit = 20) {
    const record = this.find(instanceId, runId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw this.hooks.error('invalid_option', '/limit');
    let position: number | undefined;
    if (after !== undefined) {
      const prefix = record.id + ':';
      position = after.startsWith(prefix) ? Number(after.slice(prefix.length)) : NaN;
      if (!Number.isInteger(position) || position < 0 || position > record.sequence) {
        throw this.hooks.error('invalid_option', '/after');
      }
    }
    const logs =
      position === undefined
        ? record.logs.slice(-limit)
        : record.logs.filter((log) => log.sequence > position!).slice(0, limit);
    const cursor = (sequence: number) => record.id + ':' + sequence;
    return {
      run_id: record.id,
      state: record.state,
      tasks: record.tasks.map((task) => ({ ...task })),
      logs: logs.map((log) => ({
        cursor: cursor(log.sequence),
        level: log.level,
        message: log.message,
      })),
      next_cursor: record.sequence
        ? cursor(logs[logs.length - 1]?.sequence ?? position ?? record.sequence)
        : null,
      logs_truncated: (position ?? 0) < (record.logs[0]?.sequence ?? 1) - 1,
      ...(record.error ? { error: record.error } : {}),
    };
  }
}
