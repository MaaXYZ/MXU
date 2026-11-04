import type { TaskConfig, TaskStatus } from '@/types/maa';
import type { EntryState } from './piMcpRuntime';
import { checkStartCancelled } from './taskExecutionGate';

export async function runPiMcpSequence(
  tasks: TaskConfig[],
  signal: AbortSignal,
  hooks: {
    submit(tasks: TaskConfig[]): Promise<number[]>;
    status(id: number): Promise<TaskStatus>;
    stop(): Promise<void>;
    posted(id: number, task: TaskConfig): void;
    pause(): Promise<void>;
    failed(): Error;
    drain?(): Promise<void>;
  },
  entry: (index: number, state: EntryState) => void,
) {
  const ids: number[] = [];
  for (let index = 0; index < tasks.length; index++) {
    checkStartCancelled(signal);
    const submitted = await hooks.submit([tasks[index]]);
    if (submitted.length !== 1) throw hooks.failed();
    const id = submitted[0];
    ids.push(id);
    entry(index, 'running');
    hooks.posted(id, tasks[index]);
    for (;;) {
      if (signal.aborted) await hooks.stop();
      const status = await hooks.status(id);
      if (status === 'Succeeded' || status === 'Failed') {
        entry(index, signal.aborted ? 'stopped' : status === 'Succeeded' ? 'succeeded' : 'failed');
        await hooks.drain?.();
        checkStartCancelled(signal);
        if (status === 'Failed') throw hooks.failed();
        break;
      }
      await hooks.pause();
    }
  }
  return ids;
}
