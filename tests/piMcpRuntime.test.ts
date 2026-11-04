import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PiMcpRuntime,
  PiMcpError,
  isTerminal,
  type RuntimeHooks,
} from '../src/services/piMcpRuntime.ts';
import { taskExecutionGate, guardStartupCalls } from '../src/services/taskExecutionGate.ts';
import { runPiMcpSequence } from '../src/services/piMcpSequence.ts';
import type { TaskConfig, TaskStatus } from '../src/types/maa.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const error = (code: string, path?: string) => new PiMcpError({ code, message: code, path });
const request = (id: string, requestId = 'intent') => ({
  instance_id: id,
  context_revision: 'revision',
  request_id: requestId,
  tasks: [{ name: 'Task' }],
});
async function finished(runtime: PiMcpRuntime<string>, instance: string, run: string) {
  const deadline = Date.now() + 3000;
  while (!isTerminal(runtime.status(instance, run).state)) {
    assert.ok(Date.now() < deadline, 'run did not finish');
    await tick();
  }
  return runtime.status(instance, run);
}
function fixture(id: string, overrides: Partial<RuntimeHooks<string>> = {}, capacity = 1000) {
  const hooks: RuntimeHooks<string> = {
    error,
    id: () => crypto.randomUUID(),
    prepare: (input) => ({
      snapshot: input.instance_id,
      secrets: ['SECRET'],
      tasks: [{ name: 'Task', option: {} }],
    }),
    acquire: (instance) => {
      const lease = taskExecutionGate.acquire(instance, 'mcp');
      if (!lease) throw error('instance_busy');
      return lease;
    },
    execute: async (_, __, entry) => {
      entry(0, 'running');
      entry(0, 'succeeded');
    },
    cancel: async () => {},
    cleanup: async () => {},
    ...overrides,
  };
  return { runtime: new PiMcpRuntime(hooks, capacity), id };
}
test('accepted start is asynchronous and retry deduplication precedes revision and busy validation', async () => {
  const preparation = deferred();
  let count = 0;
  let revisionChanged = false;
  const { runtime, id } = fixture('retry', {
    prepare: (input) => {
      if (revisionChanged) throw error('stale_context');
      return { snapshot: input.instance_id, secrets: [], tasks: [{ name: 'Task', option: {} }] };
    },
    execute: async (_, __, entry) => {
      count++;
      await preparation.promise;
      entry(0, 'succeeded');
    },
  });
  const args = request(id);
  const accepted = runtime.start(args);
  assert.equal(accepted.state, 'starting');
  assert.equal(count, 0);
  revisionChanged = true;
  assert.equal(runtime.start(args).run_id, accepted.run_id);
  assert.throws(() => runtime.start({ ...args, tasks: [{ name: 'Other' }] }), /request_conflict/);
  preparation.resolve();
  assert.equal((await finished(runtime, id, accepted.run_id)).state, 'succeeded');
  assert.equal(runtime.start(args).run_id, accepted.run_id);
  assert.equal(count, 1);
});
test('stop during delayed preparation drains the startup call and never posts a late task', async () => {
  const preparation = deferred();
  let posts = 0;
  const { runtime, id } = fixture('stop-starting', {
    execute: async (_, lease) => {
      const service = guardStartupCalls(
        {
          prepare: () => preparation.promise,
          post: async () => {
            posts++;
          },
        },
        lease.controller.signal,
      );
      await service.prepare();
      await service.post();
    },
  });
  const accepted = runtime.start(request(id));
  await tick();
  assert.equal(runtime.stop(id, accepted.run_id).state, 'stopping');
  assert.ok(taskExecutionGate.get(id));
  await tick();
  assert.equal(runtime.status(id, accepted.run_id).state, 'stopping');
  preparation.resolve();
  assert.equal((await finished(runtime, id, accepted.run_id)).state, 'stopped');
  assert.equal(posts, 0);
  assert.equal(taskExecutionGate.get(id), undefined);
});
test('stop requests for independent instances do not block each other', async () => {
  const preparation = deferred();
  const slowStop = deferred();
  const { runtime } = fixture('unused', {
    execute: async () => preparation.promise,
    cancel: async (id) => {
      if (id === 'stop-A') await slowStop.promise;
    },
  });
  const a = runtime.start(request('stop-A'));
  const b = runtime.start(request('stop-B'));
  runtime.stop('stop-A', a.run_id);
  runtime.stop('stop-B', b.run_id);
  preparation.resolve();
  assert.equal((await finished(runtime, 'stop-B', b.run_id)).state, 'stopped');
  assert.equal(runtime.status('stop-A', a.run_id).state, 'stopping');
  slowStop.resolve();
  await finished(runtime, 'stop-A', a.run_id);
});
test('an old run stop never cancels a newer run in the same instance', async () => {
  const preparation = deferred();
  let executions = 0;
  const { runtime, id } = fixture('old-stop', {
    execute: async (_, __, entry) => {
      if (++executions === 2) await preparation.promise;
      entry(0, 'succeeded');
    },
  });
  const a = runtime.start(request(id, 'first'));
  await finished(runtime, id, a.run_id);
  const b = runtime.start(request(id, 'second'));
  assert.equal(runtime.stop(id, a.run_id).state, 'succeeded');
  assert.equal(taskExecutionGate.get(id)?.controller.signal.aborted, false);
  preparation.resolve();
  await finished(runtime, id, b.run_id);
});
test('retention refuses new runs instead of forgetting retry identities', async () => {
  const { runtime, id } = fixture('capacity', {}, 1);
  const args = request(id);
  const run = runtime.start(args);
  await finished(runtime, id, run.run_id);
  assert.throws(() => runtime.start(request(id, 'second')), /resource_exhausted/);
  assert.equal(runtime.start(args).run_id, run.run_id);
});
test('logs are run-scoped, redacted, cursor-based, and report retention gaps', async () => {
  const preparation = deferred();
  const { runtime, id } = fixture('logs', { execute: async () => preparation.promise });
  const run = runtime.start(request(id));
  for (let i = 0; i < 505; i++) runtime.appendLog(id, 'info', 'SECRET ' + i);
  const first = runtime.status(id, run.run_id, undefined, 100);
  assert.equal(first.logs.length, 100);
  assert.equal(first.logs_truncated, true);
  assert.ok(!JSON.stringify(first).includes('SECRET'));
  assert.deepEqual(runtime.status(id, run.run_id, first.next_cursor!).logs, []);
  assert.throws(() => runtime.status('other', run.run_id), /run_not_found/);
  assert.throws(() => runtime.status(id, run.run_id, 'other:1'), /invalid_option/);
  preparation.resolve();
  await finished(runtime, id, run.run_id);
});
const configs: TaskConfig[] = ['A', 'B'].map((entry) => ({ entry, pipeline_override: '[]' }));
test('the actual sequential executor does not submit later tasks after failure', async () => {
  const submitted: string[] = [];
  const states: string[] = [];
  await assert.rejects(
    runPiMcpSequence(
      configs,
      new AbortController().signal,
      {
        submit: async (tasks) => {
          submitted.push(tasks[0].entry);
          return [1];
        },
        status: async () => 'Failed',
        stop: async () => {},
        posted: () => {},
        pause: tick,
        failed: () => error('execution_failed'),
      },
      (index, state) => states.push(index + ':' + state),
    ),
    /execution_failed/,
  );
  assert.deepEqual(submitted, ['A']);
  assert.deepEqual(states, ['0:running', '0:failed']);
});
test('cancellation during native task submission drains the returned job before rejecting the sequence', async () => {
  const controller = new AbortController();
  const submission = deferred();
  let stops = 0;
  let submissions = 0;
  let status: TaskStatus = 'Running';
  const running = runPiMcpSequence(
    configs,
    controller.signal,
    {
      submit: async () => {
        submissions++;
        await submission.promise;
        return [1];
      },
      status: async () => status,
      stop: async () => {
        stops++;
        status = 'Failed';
      },
      posted: () => {},
      pause: tick,
      failed: () => error('execution_failed'),
    },
    () => {},
  );
  controller.abort();
  submission.resolve();
  await assert.rejects(running, /MXU_PRE_ACTION_CANCELLED/);
  assert.equal(stops, 1);
  assert.equal(submissions, 1);
});
