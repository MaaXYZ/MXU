import type { SavedTask } from '@/types/config';
import type { ActionConfig, Instance, OptionDefinition, OptionValue } from '@/types/interface';
import { encryptPasswordOptionValues } from '@/utils/passwordOptionValues';
import { isTauri } from '@/utils/paths';
import { cacheTaskEnabledForController } from '@/utils/taskControllerCache';
import { normalizeWeeklySchedule } from '@/utils/taskRunFilter';
import { toast } from 'sonner';

const PROTOCOL_SEGMENT = 'tab-sharing';
const CURRENT_VERSION = 'v1';

export interface TabExportPayload {
  controllerName?: string;
  resourceName?: string;
  selectedTasks: SavedTask[];
  preActions?: ActionConfig[];
}

export interface TabImportResult {
  tabName: string;
  payload: TabExportPayload;
}

export type ImportError = 'invalid_format' | 'project_mismatch' | 'unsupported_version';

// ── v1 短 key 内部序列化结构 ─────────────────────────────────────────────────
// 仅在 wire 格式中使用，不对外暴露

type WireOptionValue =
  | { t: 's'; c: string } // select:   caseName
  | { t: 'cb'; c: string[] } // checkbox: caseNames
  | { t: 'sw'; v: boolean } // switch:   value
  | { t: 'in'; v: Record<string, string>; ev?: Record<string, string> } // input: values + encryptedValues
  | { t: 'hk'; v: Record<string, string> };

interface WireTask {
  i: string; // id
  tn: string; // taskName
  cn?: string; // customName
  e: boolean; // enabled
  ec?: Record<string, boolean>; // enabledByController
  ws?: number[]; // weeklySchedule
  ov: Record<string, WireOptionValue>; // optionValues
}

interface WireAction {
  i: string; // id
  cn?: string; // customName
  e: boolean; // enabled
  p: string; // program
  a: string; // args
  w: boolean; // waitForExit
  s: boolean; // skipIfRunning
  u: boolean; // useCmd
}

interface WirePayload {
  cn?: string; // controllerName
  rn?: string; // resourceName
  t: WireTask[]; // selectedTasks
  pa?: WireAction[]; // preActions
}

// ── 序列化：业务结构 → 短 key wire 格式 ─────────────────────────────────────

function encodeOptionValue(v: OptionValue): WireOptionValue {
  switch (v.type) {
    case 'select':
      return { t: 's', c: v.caseName };
    case 'checkbox':
      return { t: 'cb', c: v.caseNames };
    case 'switch':
      return { t: 'sw', v: v.value };
    case 'input': {
      const wire: Extract<WireOptionValue, { t: 'in' }> = { t: 'in', v: v.values };
      if (v.encryptedValues && Object.keys(v.encryptedValues).length > 0) {
        wire.ev = v.encryptedValues;
      }
      return wire;
    }
    case 'hotkey':
      return { t: 'hk', v: v.values };
    default:
      throw new Error('invalid_format');
  }
}

function encodeTask(task: SavedTask): WireTask {
  const wire: WireTask = {
    i: task.id,
    tn: task.taskName,
    e: task.enabled,
    ov: Object.fromEntries(
      Object.entries(task.optionValues).map(([k, v]) => [k, encodeOptionValue(v)]),
    ),
  };
  if (task.customName !== undefined) wire.cn = task.customName;
  if (task.enabledByController !== undefined) wire.ec = task.enabledByController;
  if (task.weeklySchedule !== undefined) wire.ws = task.weeklySchedule;
  return wire;
}

function encodeAction(action: ActionConfig): WireAction {
  const wire: WireAction = {
    i: action.id,
    e: action.enabled,
    p: action.program,
    a: action.args,
    w: action.waitForExit,
    s: action.skipIfRunning,
    u: action.useCmd,
  };
  if (action.customName !== undefined) wire.cn = action.customName;
  return wire;
}

function encodePayload(payload: TabExportPayload): WirePayload {
  const wire: WirePayload = {
    t: payload.selectedTasks.map(encodeTask),
  };
  if (payload.controllerName !== undefined) wire.cn = payload.controllerName;
  if (payload.resourceName !== undefined) wire.rn = payload.resourceName;
  if (payload.preActions?.length) wire.pa = payload.preActions.map(encodeAction);
  return wire;
}

// ── 反序列化：短 key wire 格式 → 业务结构 ───────────────────────────────────

function decodeOptionValue(w: WireOptionValue): OptionValue {
  switch (w.t) {
    case 's':
      return { type: 'select', caseName: w.c };
    case 'cb':
      return { type: 'checkbox', caseNames: w.c };
    case 'sw':
      return { type: 'switch', value: w.v };
    case 'in':
      return {
        type: 'input',
        values: w.v,
        ...(w.ev && Object.keys(w.ev).length > 0 ? { encryptedValues: w.ev } : {}),
      };
    case 'hk':
      return { type: 'hotkey', values: w.v };
    default:
      throw new Error('invalid_format');
  }
}

function decodeTask(w: WireTask): SavedTask {
  return {
    id: w.i,
    taskName: w.tn,
    customName: w.cn,
    enabled: w.e,
    enabledByController: w.ec,
    weeklySchedule: normalizeWeeklySchedule(w.ws),
    optionValues: Object.fromEntries(
      Object.entries(w.ov).map(([k, v]) => [k, decodeOptionValue(v)]),
    ),
  };
}

function decodeAction(w: WireAction): ActionConfig {
  return {
    id: w.i,
    customName: w.cn,
    enabled: w.e,
    program: w.p,
    args: w.a,
    waitForExit: w.w,
    skipIfRunning: w.s,
    useCmd: w.u,
  };
}

function decodePayload(wire: WirePayload): TabExportPayload {
  return {
    controllerName: wire.cn,
    resourceName: wire.rn,
    selectedTasks: wire.t.map(decodeTask),
    preActions: wire.pa?.map(decodeAction),
  };
}

// ── deflate helpers ──────────────────────────────────────────────────────────

async function compress(str: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(str);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(encoded);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function decompress(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes as Uint8Array<ArrayBuffer>);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(result);
}

function toBase64Url(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 将当前 Tab 的配置序列化并写入剪贴板。
 * 格式（三行）：
 *   {hint}          ← 开头说明（调用方传入，本地化）
 *   {projectName}://tab-sharing/v1/{tabName}/{base64url(deflate(JSON))}
 *   {footer}        ← 结尾签名（调用方传入，本地化）
 */
export async function buildTabConfigExportText(
  instance: Instance,
  projectName: string,
  hint?: string,
  footer?: string,
  allOptions?: Record<string, OptionDefinition>,
): Promise<string> {
  const payload: TabExportPayload = {
    controllerName: instance.controllerName,
    resourceName: instance.resourceName,
    selectedTasks: instance.selectedTasks.map((t) => ({
      id: t.id,
      taskName: t.taskName,
      customName: t.customName,
      enabled: t.enabled,
      weeklySchedule: normalizeWeeklySchedule(t.weeklySchedule),
      enabledByController: cacheTaskEnabledForController(
        t.enabledByController,
        instance.controllerName,
        t.enabled,
      ),
      optionValues: allOptions
        ? encryptPasswordOptionValues(t.optionValues, allOptions, projectName)
        : t.optionValues,
    })),
    preActions: instance.preActions,
  };

  const wire = encodePayload(payload);
  const jsonStr = JSON.stringify(wire);
  const compressed = await compress(jsonStr);
  const base64 = toBase64Url(compressed);
  const tabNameEncoded = encodeURIComponent(instance.name);

  const dataLine = `${projectName}://${PROTOCOL_SEGMENT}/${CURRENT_VERSION}/${tabNameEncoded}/${base64}`;
  const hintLine = hint ?? `[MXU] ${projectName} · ${instance.name}`;
  return footer ? `${hintLine}\n${dataLine}\n${footer}` : `${hintLine}\n${dataLine}`;
}

export async function exportTabConfig(
  instance: Instance,
  projectName: string,
  hint?: string,
  footer?: string,
  allOptions?: Record<string, OptionDefinition>,
): Promise<void> {
  const lines = await buildTabConfigExportText(instance, projectName, hint, footer, allOptions);
  await navigator.clipboard.writeText(lines);
}

function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'config'
  );
}

function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function exportTabConfigToFile(
  instance: Instance,
  projectName: string,
  hint: string,
  footer: string,
  allOptions?: Record<string, OptionDefinition>,
): Promise<boolean> {
  const content = await buildTabConfigExportText(instance, projectName, hint, footer, allOptions);
  const fileName = `${sanitizeFileName(projectName)}-${sanitizeFileName(instance.name)}.txt`;

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const selected = await save({
      defaultPath: fileName,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (!selected) return false;

    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(selected, content);
    return true;
  }

  downloadTextFile(fileName, content);
  return true;
}

/**
 * 从剪贴板读取并解析 Tab 配置导入数据。
 * 返回解析后的 tabName + payload，或抛出带有 ImportError 类型的错误。
 */
export async function importTabConfigFromText(
  projectName: string,
  rawText: string,
): Promise<TabImportResult> {
  const raw = rawText.trim();

  const escapedSegment = PROTOCOL_SEGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dataLineRegex = new RegExp(`(.+://${escapedSegment}/.+)`, 'm');
  const dataLineMatch = raw.match(dataLineRegex);
  const text = dataLineMatch ? dataLineMatch[1].trim() : raw;

  const protocolPrefix = `${projectName}://${PROTOCOL_SEGMENT}/`;
  if (!text.startsWith(protocolPrefix)) {
    const mismatchRegex = new RegExp(`^.+://${escapedSegment}/`);
    if (mismatchRegex.test(text)) {
      throw createImportError('project_mismatch');
    }
    throw createImportError('invalid_format');
  }

  const rest = text.slice(protocolPrefix.length);
  // rest = "v1/{tabName}/{base64url}"
  const parts = rest.split('/');
  if (parts.length < 3) {
    throw createImportError('invalid_format');
  }

  const version = parts[0];
  if (version !== CURRENT_VERSION) {
    throw createImportError('unsupported_version');
  }

  const tabName = decodeURIComponent(parts[1]);
  const base64Data = parts.slice(2).join('/');

  let payload: TabExportPayload;
  try {
    const compressed = fromBase64Url(base64Data);
    const jsonStr = await decompress(compressed);
    const wire: WirePayload = JSON.parse(jsonStr);
    payload = decodePayload(wire);
  } catch {
    throw createImportError('invalid_format');
  }

  if (!payload || !Array.isArray(payload.selectedTasks)) {
    throw createImportError('invalid_format');
  }

  return { tabName, payload };
}

export async function importTabConfigFromClipboard(projectName: string): Promise<TabImportResult> {
  const rawText = await navigator.clipboard.readText();
  return importTabConfigFromText(projectName, rawText);
}

function readTextFileFromBrowser(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file.text().then(resolve, reject);
    };
    input.click();
  });
}

export async function importTabConfigFromFile(
  projectName: string,
): Promise<TabImportResult | null> {
  let content: string | null = null;

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (!selected || Array.isArray(selected)) return null;

    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    content = await readTextFile(selected);
  } else {
    content = await readTextFileFromBrowser();
  }

  if (content === null) return null;
  return importTabConfigFromText(projectName, content);
}

function createImportError(type: ImportError): Error {
  const err = new Error(type);
  (err as Error & { importErrorType: ImportError }).importErrorType = type;
  return err;
}

export function getImportErrorType(err: unknown): ImportError | undefined {
  if (err instanceof Error && 'importErrorType' in err) {
    return (err as Error & { importErrorType: ImportError }).importErrorType;
  }
  return undefined;
}

export function exportWithToast(
  instance: Instance,
  projectName: string,
  hint: string,
  footer: string,
  messages: { success: string; failed: string },
  allOptions?: Record<string, OptionDefinition>,
): void {
  exportTabConfig(instance, projectName, hint, footer, allOptions).then(
    () => toast.success(messages.success),
    () => toast.error(messages.failed),
  );
}

export function exportFileWithToast(
  instance: Instance,
  projectName: string,
  hint: string,
  footer: string,
  messages: { success: string; failed: string },
  allOptions?: Record<string, OptionDefinition>,
): void {
  exportTabConfigToFile(instance, projectName, hint, footer, allOptions).then(
    (saved) => {
      if (saved) toast.success(messages.success);
    },
    () => toast.error(messages.failed),
  );
}
