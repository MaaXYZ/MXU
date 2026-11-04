import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { taskControlService } from '@/services/taskControlService';
import { taskExecutionGate, checkStartCancelled } from './taskExecutionGate';
import type { TaskStartSnapshot } from './taskStartService';
import { runPiMcpSequence } from './piMcpSequence';
import { PiMcpRuntime, PiMcpError, canonicalJson, type StartRequest } from './piMcpRuntime';
import {
  baselineOptions,
  convertMcpOptions,
  describeOptions,
  formatOptionValues,
  isOptionIncompatible,
  type OptionContext,
} from '@/utils/mcpOptions';
import { isHotkeyValueSupported } from '@/utils/pipelineOverride';
import { collectPasswordPlaintexts } from '@/utils/passwordOptionValues';
import type { Instance, SelectedTask, TaskItem } from '@/types/interface';
import { isPretaskName } from '@/types/pretasks';
import i18n, { getInterfaceLangKey } from '@/i18n';
import { isTauri, loggers } from '@/utils';

interface Identity {
  id: string;
  signature: string;
  revision: string;
}
interface ExecutionSnapshot {
  instance: Instance;
  context: TaskStartSnapshot;
}
const identities = new Map<string, Identity>();
const getState = () => useAppStore.getState();
const newId = () => crypto.randomUUID();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
const error = (code: string, path?: string) =>
  new PiMcpError({ code, message: i18n.t('mcp.pi.errors.' + code), ...(path ? { path } : {}) });
const text = (value: string | undefined) =>
  value
    ? getState().resolveI18nText(value, getInterfaceLangKey(getState().language)) || value
    : undefined;

function contextOf(instance: Instance) {
  const state = getState();
  const controllerName =
    state.selectedController[instance.id] ||
    instance.controllerName ||
    state.projectInterface?.controller[0]?.name;
  const resourceName =
    state.selectedResource[instance.id] ||
    instance.resourceName ||
    state.projectInterface?.resource[0]?.name;
  const controller = state.projectInterface?.controller.find(
    (item) => item.name === controllerName,
  );
  const keyboardType =
    (controller?.type === 'Linux' && controller.linux?.use_win32_vk_code) ||
    (controller?.type === 'WlRoots' && controller.wlroots?.use_win32_vk_code)
      ? 'Win32'
      : controller?.type;
  return {
    controllerName,
    resourceName,
    resolveText: text,
    error,
    validateHotkey: (value: string) => isHotkeyValueSupported(value, keyboardType),
  };
}
function identity(instance: Instance) {
  const state = getState();
  const { controllerName, resourceName } = contextOf(instance);
  // The signature stays private, including credentials. Only random revisions leave the process.
  const signature = canonicalJson({
    pi: state.projectInterface,
    basePath: state.basePath,
    controllerName,
    resourceName,
    savedDevice: instance.savedDevice,
    preActions: instance.preActions,
    tasks: instance.selectedTasks.map(({ taskName, optionValues, enabled }) => ({
      taskName,
      optionValues,
      enabled,
    })),
    global: state.globalOptionValues,
    tcpCompatMode: state.tcpCompatMode,
    delay: state.preActionConnectDelaySec,
  });
  let value = identities.get(instance.id);
  if (!value) {
    value = { id: newId(), signature, revision: newId() };
    identities.set(instance.id, value);
  } else if (value.signature !== signature) {
    value.signature = signature;
    value.revision = newId();
  }
  return value;
}
function resolveInstance(id: string) {
  const instance = getState().instances.find((item) => identity(item).id === id);
  if (!instance) throw error('instance_not_found');
  return instance;
}
function definition(instance: Instance, name: string) {
  const task = getState().projectInterface?.task.find((item) => item.name === name);
  if (!task) throw error('task_not_found');
  if (isOptionIncompatible(task, contextOf(instance))) throw error('task_not_found');
  return task;
}
function baseline(instance: Instance, task: TaskItem, ctx: OptionContext) {
  const matches = instance.selectedTasks.filter((item) => item.taskName === task.name);
  if (
    matches.length > 1 &&
    matches.some(
      (item) => canonicalJson(item.optionValues) !== canonicalJson(matches[0].optionValues),
    )
  ) {
    throw error('configuration_required');
  }
  const saved = structuredClone(matches[0]?.optionValues ?? {});
  return {
    saved,
    values: baselineOptions(
      task.option ?? [],
      getState().projectInterface?.option ?? {},
      ctx,
      saved,
    ),
  };
}
function requireExecution() {
  if (!getState().mcpExecutionEnabled) throw error('permission_denied');
}
function prepare(request: StartRequest) {
  const instance = resolveInstance(request.instance_id);
  if (identity(instance).revision !== request.context_revision) throw error('stale_context');
  const state = getState();
  const pi = state.projectInterface;
  const ctx = contextOf(instance);
  if (!pi || !ctx.controllerName || !ctx.resourceName || !taskControlService.isReady())
    throw error('configuration_required');
  const definitions = pi.option ?? {};
  const tasks = request.tasks.map((item, index): SelectedTask => {
    const def = definition(instance, item.name);
    const base = baseline(instance, def, ctx);
    return {
      id: newId(),
      taskName: item.name,
      enabled: true,
      expanded: false,
      optionValues: {
        ...base.saved,
        ...convertMcpOptions({
          optionKeys: def.option ?? [],
          allOptions: definitions,
          defaults: base.values,
          input: item.option ?? {},
          ctx,
          path: '/tasks/' + index + '/option',
        }),
      },
    };
  });
  const globalOptionValues = convertMcpOptions({
    optionKeys: pi.global_option ?? [],
    allOptions: definitions,
    defaults: state.globalOptionValues,
    input: {},
    ctx,
  });
  const scopedRoots = [
    ...(pi.controller.find((item) => item.name === ctx.controllerName)?.option ?? []),
    ...(pi.resource.find((item) => item.name === ctx.resourceName)?.option ?? []),
  ];
  for (const task of tasks)
    Object.assign(
      task.optionValues,
      convertMcpOptions({
        optionKeys: scopedRoots.filter(
          (key) => !(definition(instance, task.taskName).option ?? []).includes(key),
        ),
        allOptions: definitions,
        defaults: task.optionValues,
        input: {},
        ctx,
      }),
    );
  const pretasks = structuredClone(
    instance.selectedTasks.filter((item) => isPretaskName(item.taskName)),
  );
  const context: TaskStartSnapshot = structuredClone({
    projectInterface: pi,
    globalOptionValues,
    basePath: state.basePath,
    language: state.language,
    tcpCompatMode: state.tcpCompatMode,
    maaVersion: state.maaVersion,
    interfaceTranslations: state.interfaceTranslations,
    preActionConnectDelaySec: state.preActionConnectDelaySec,
    taskIds: tasks.map((task) => task.id),
    controllerName: ctx.controllerName,
    resourceName: ctx.resourceName,
  });
  const snapshot = {
    instance: structuredClone({ ...instance, selectedTasks: [...pretasks, ...tasks] }),
    context,
  };
  const secrets = [
    ...collectPasswordPlaintexts(globalOptionValues, definitions),
    ...snapshot.instance.selectedTasks.flatMap((item) =>
      collectPasswordPlaintexts(item.optionValues, definitions),
    ),
  ];
  return {
    snapshot,
    secrets,
    tasks: tasks.map((item) => ({
      name: item.taskName,
      option: formatOptionValues(
        definition(instance, item.taskName).option ?? [],
        definitions,
        item.optionValues,
        ctx,
      ),
    })),
  };
}

const runtime = new PiMcpRuntime<ExecutionSnapshot>({
  prepare,
  error,
  id: newId,
  acquire(id) {
    const instance = resolveInstance(id);
    if (instance.isRunning) throw error('instance_busy');
    const lease = taskExecutionGate.acquire(instance.id, 'mcp');
    if (!lease) throw error('instance_busy');
    return lease;
  },
  async execute(snapshot, lease, entry) {
    const { instance, context } = snapshot;
    checkStartCancelled(lease.controller.signal);
    const controller = context.projectInterface?.controller.find(
      (item) => item.name === context.controllerName,
    );
    if (controller?.permission_required && !(await maaService.isElevated()))
      throw error('permission_denied');
    getState().addLog(instance.id, {
      type: 'info',
      message: i18n.t('mcp.pi.logStart', {
        run_id: runtime.active(identities.get(instance.id)?.id ?? ''),
        tasks: instance.selectedTasks
          .filter((task) => context.taskIds.includes(task.id))
          .map((task) => task.taskName)
          .join(', '),
      }),
    });
    let executionError: unknown;
    const success = await taskControlService.start(instance, {
      snapshot: context,
      executionLease: lease,
      async executeTasks(configs, submit) {
        try {
          const resource = context.projectInterface?.resource.find(
            (item) => item.name === context.resourceName,
          );
          if (resource?.hash && (await maaService.getResourceHash(instance.id)) !== resource.hash) {
            throw error('execution_failed');
          }
          return await runPiMcpSequence(
            configs,
            lease.controller.signal,
            {
              submit,
              status: (id) => maaService.getTaskStatus(instance.id, id),
              stop: () => maaService.stopTask(instance.id),
              posted: (id, task) => getState().registerTaskIdName(id, task.task_name ?? task.entry),
              pause,
              drain: async () => {
                while (await maaService.isRunning(instance.id)) await pause();
              },
              failed: () => error('execution_failed'),
            },
            entry,
          );
        } catch (reason) {
          executionError = reason;
          throw reason;
        }
      },
    });
    if (!success) throw executionError ?? error('execution_failed');
  },
  async cancel({ instance }, lease) {
    getState().addLog(instance.id, {
      type: 'info',
      message: i18n.t('mcp.pi.logStop', {
        run_id: runtime.active(identities.get(instance.id)?.id ?? ''),
      }),
    });
    if (!lease.backendReserved) return;
    await maaService.setPreActionStop(instance.id, true);
    await maaService.stopTask(instance.id).catch(() => {});
  },
  async cleanup({ instance }, lease, failed) {
    if (!lease.backendReserved) return;
    const signal = lease.controller.signal;
    const states = await maaService.getAllStates();
    if (!states) throw error('execution_failed');
    if (!states.instances[instance.id]) {
      if (lease.backendReserved) await maaService.releaseExecution(instance.id, lease.token);
      return;
    }
    if (signal.aborted || failed) await maaService.stopTask(instance.id).catch(() => {});
    while (await maaService.isRunning(instance.id)) {
      if (signal.aborted || failed) await maaService.stopTask(instance.id);
      await pause();
    }
    if (signal.aborted || failed) await maaService.stopAgent(instance.id);
    if (lease.backendReserved) await maaService.releaseExecution(instance.id, lease.token);
    getState().updateInstance(instance.id, { isRunning: false });
  },
});

interface Page {
  signature: string;
  offset: number;
}
const cursors = new Map<string, Page>();
function pagination(args: Record<string, unknown>, revision: string) {
  const limit = args.limit === undefined ? 50 : (args.limit as number);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error('invalid_option', '/limit');
  const signature = canonicalJson({
    instance: args.instance_id,
    task: args.task_name,
    option: args.option_key,
    revision,
  });
  const page = args.cursor === undefined ? undefined : cursors.get(args.cursor as string);
  if (args.cursor !== undefined && (!page || page.signature !== signature))
    throw error('stale_context');
  return {
    limit,
    offset: page?.offset ?? 0,
    next(offset: number | null) {
      if (offset === null) return null;
      if (cursors.size >= 1000) cursors.delete(cursors.keys().next().value!);
      const cursor = newId();
      cursors.set(cursor, { signature, offset });
      return cursor;
    },
  };
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_instances: () => ({
    pi_mcp_version: '1.0',
    instances: getState().instances.map((instance) => {
      const state = getState();
      const ctx = contextOf(instance);
      const value = identity(instance);
      return {
        instance_id: value.id,
        project: {
          name: state.projectInterface?.name ?? '',
          label: text(state.projectInterface?.label),
          version: state.projectInterface?.version,
        },
        controller: ctx.controllerName ?? null,
        resource: ctx.resourceName ?? null,
        context_revision: value.revision,
        connected: state.instanceConnectionStatus[instance.id] === 'Connected',
        busy: !!instance.isRunning || !!taskExecutionGate.get(instance.id),
        active_run_id: runtime.active(value.id),
      };
    }),
  }),
  list_tasks(args) {
    const instance = resolveInstance(args.instance_id as string);
    const revision = identity(instance).revision;
    const page = pagination(args, revision);
    const tasks = (getState().projectInterface?.task ?? []).filter(
      (item) => !isOptionIncompatible(item, contextOf(instance)),
    );
    return {
      context_revision: revision,
      tasks: tasks.slice(page.offset, page.offset + page.limit).map((task) => ({
        name: task.name,
        label: text(task.label),
        description: text(task.description),
        group: task.group,
      })),
      next_cursor: page.next(
        page.offset + page.limit < tasks.length ? page.offset + page.limit : null,
      ),
    };
  },
  describe_task(args) {
    const instance = resolveInstance(args.instance_id as string);
    const def = definition(instance, args.task_name as string);
    const revision = identity(instance).revision;
    if (!args.option_key && args.cursor !== undefined) throw error('invalid_option', '/cursor');
    const page = pagination(args, revision);
    const ctx = contextOf(instance);
    const result = describeOptions(
      def.option ?? [],
      getState().projectInterface?.option ?? {},
      ctx,
      baseline(instance, def, ctx).values,
      args.option_key as string | undefined,
      page.offset,
      page.limit,
    );
    return {
      context_revision: revision,
      task_name: def.name,
      root_options: result.root_options,
      options: result.options,
      next_cursor: page.next(result.nextOffset),
    };
  },
  start_tasks(args) {
    requireExecution();
    resolveInstance(args.instance_id as string);
    return runtime.start(args as unknown as StartRequest);
  },
  stop_tasks(args) {
    requireExecution();
    resolveInstance(args.instance_id as string);
    return runtime.stop(args.instance_id as string, args.run_id as string);
  },
  get_run_status(args) {
    resolveInstance(args.instance_id as string);
    return runtime.status(
      args.instance_id as string,
      args.run_id as string,
      args.after as string | undefined,
      args.limit as number | undefined,
    );
  },
  resolve_instance(args) {
    if (!getState().mcpScreenshotEnabled) throw error('permission_denied');
    const instance = resolveInstance(args.instance_id as string);
    if (getState().instanceConnectionStatus[instance.id] !== 'Connected')
      throw error('not_connected');
    return { instance_id: args.instance_id, backend_instance_id: instance.id };
  },
};

interface BridgeRequest {
  id: number;
  op: string;
  args: Record<string, unknown>;
}
export function callPiMcpTool(op: string, args: Record<string, unknown>) {
  if (!getState().mcpEnabled) throw error('permission_denied');
  const handler = handlers[op];
  if (!handler) throw error('invalid_option');
  return handler(args);
}
async function handleRequest(request: BridgeRequest) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const data = await callPiMcpTool(request.op, request.args ?? {});
    await invoke('mcp_respond', { response: { id: request.id, ok: true, data } });
  } catch (reason) {
    const detail = reason instanceof PiMcpError ? reason.detail : error('execution_failed').detail;
    await invoke('mcp_respond', { response: { id: request.id, ok: false, error: detail } });
  }
}
async function pushMcpTexts() {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('mcp_set_texts', { texts: i18n.t('mcp.pi.server', { returnObjects: true }) });
}
export async function initMcpBridge(): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  const { invoke } = await import('@tauri-apps/api/core');
  const unlisten = await listen<BridgeRequest>('mcp-request', (event) => {
    void handleRequest(event.payload).catch(() => loggers.app.warn('[mcp] response unavailable'));
  });
  const onLanguageChanged = () => {
    void pushMcpTexts();
  };
  i18n.on('languageChanged', onLanguageChanged);
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    for (const instance of state.instances) {
      const old = previous.instanceLogs[instance.id] ?? [];
      const oldIds = new Set(old.map((log) => log.id));
      const id = identities.get(instance.id)?.id;
      if (id)
        for (const log of state.instanceLogs[instance.id] ?? [])
          if (!oldIds.has(log.id)) {
            runtime.appendLog(id, log.type === 'success' ? 'info' : log.type, log.message);
          }
    }
    for (const id of identities.keys())
      if (!state.instances.some((instance) => instance.id === id)) identities.delete(id);
    if (
      state.mcpExecutionEnabled !== previous.mcpExecutionEnabled ||
      state.mcpScreenshotEnabled !== previous.mcpScreenshotEnabled
    ) {
      void syncMcpPermissions();
    }
  });
  await pushMcpTexts();
  await syncMcpPermissions();
  await invoke('mcp_bridge_ready');
  return () => {
    unlisten();
    unsubscribe();
    i18n.off('languageChanged', onLanguageChanged);
  };
}
async function syncMcpPermissions() {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_mcp_permissions', {
    execution: getState().mcpExecutionEnabled,
    screenshot: getState().mcpScreenshotEnabled,
  });
}
export async function syncMcpEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_mcp_server_enabled', { enabled });
}
