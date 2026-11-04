const TASK_ERROR_KEYS = {
  TASKER_STOPPING: 'taskList.autoConnect.taskerStopping',
  TASK_QUEUE_ALREADY_RUNNING: 'taskList.autoConnect.queueAlreadyRunning',
  INSTANCE_REPLACED: 'taskList.autoConnect.instanceReplaced',
} as const;

export class TaskLifecycleError extends Error {
  constructor(
    readonly code: keyof typeof TASK_ERROR_KEYS,
    message: string,
  ) {
    super(message);
    this.name = 'TaskLifecycleError';
  }
}

/** Both Tauri's plain rejection and the HTTP error envelope carry the same code. */
export function localizeTaskError(error: unknown, translate: (key: string) => string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, key] of Object.entries(TASK_ERROR_KEYS)) {
    if (new RegExp(`(^|[^A-Z_])${code}($|[^A-Z_])`).test(message)) {
      return new TaskLifecycleError(code as keyof typeof TASK_ERROR_KEYS, translate(key));
    }
  }
  return error;
}

/** This request never owned the active run, so its error handler cannot stop it. */
export function preservesTaskRun(error: unknown): boolean {
  return error instanceof TaskLifecycleError;
}
