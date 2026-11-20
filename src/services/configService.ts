import type { MxuConfig } from '@/types/config';
import { defaultConfig, isValidMxuConfig } from '@/types/config';
import { loggers } from '@/utils/logger';
import { parseJsonc } from '@/utils/jsonc';
import { joinPath, isTauri, getCacheDir } from '@/utils/paths';
import { getApiBase } from '@/utils/backendApi';
import {
  ConfigSync,
  stableConfigJson,
  type ConfigSnapshot,
  type ConfigChangedEvent,
} from '@/utils/configSync';
import { ConfigDrafts, type ConfigDraft as StoredConfigDraft } from '@/utils/configDrafts';

const log = loggers.config;

// 每个页面会话独立标识发送方，不能用“下一个通知”猜测是不是自己的保存。
const configSync = new ConfigSync<MxuConfig>(
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  async (request) => {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ConfigSnapshot<MxuConfig>>('save_config_snapshot', { request });
    }
    const response = await fetch(`${getApiBase()}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await response.json();
    return response.json() as Promise<ConfigSnapshot<MxuConfig>>;
  },
  (error) => window.dispatchEvent(new CustomEvent('config-sync-error', { detail: error })),
);
let backendConfigLoaded = false;
let fallbackBaseline = '';
let currentProjectName: string | undefined;

export type ConfigDraft = StoredConfigDraft<MxuConfig>;
const configDrafts = new ConfigDrafts<MxuConfig>(() => localStorage, isValidMxuConfig);

/** 未同步的编辑只作为可导出的本地草稿保留，绝不自动重放到新版本上。 */
export function preserveUnsavedConfig(config: MxuConfig, projectName: string): ConfigDraft | null {
  if (!backendConfigLoaded && !fallbackBaseline) return null;
  if (
    backendConfigLoaded
      ? !configSync.hasChanges(config)
      : stableConfigJson(config) === fallbackBaseline
  )
    return null;
  try {
    // 外部更新前保留的旧基线草稿不能被新基线上的下一次编辑覆盖。
    const draftId = `${configSync.clientId}-${configSync.getRevision() ?? 'fallback'}`;
    const draft = configDrafts.save(config, projectName, draftId);
    if (!configDrafts.isPersistent(draft))
      window.dispatchEvent(new CustomEvent('config-draft-unavailable', { detail: draft }));
    return draft;
  } catch (error) {
    log.warn('保留未同步配置草稿失败:', error);
    return { key: '', config, savedAt: new Date().toISOString() };
  }
}

export function getUnsavedConfigDrafts(projectName: string): ConfigDraft[] {
  try {
    return configDrafts.list(projectName, (config) => configSync.hasChanges(config));
  } catch (error) {
    log.warn('读取未同步配置草稿失败:', error);
    return [];
  }
}

export async function downloadConfigDraft(draft: ConfigDraft, projectName: string): Promise<void> {
  const content = JSON.stringify(draft.config, null, 2);
  const fileName = `mxu-${projectName}-unsaved-${draft.savedAt.replace(/[:.]/g, '-')}.json`.replace(
    /[<>:"/\\|?*\x00-\x1f]/g,
    '_',
  );
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(path, content);
  } else {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  try {
    configDrafts.remove(draft.key);
  } catch {
    /* 导出的文件仍可用于恢复。 */
  }
}

export function isOwnConfigChange(event: ConfigChangedEvent | undefined): Promise<boolean> {
  return configSync.isOwnChange(event);
}

export function hasBackendConfig(): boolean {
  return backendConfigLoaded || isTauri();
}

/** 只把初始化后的本地预览状态作为比较基线，绝不赋予后端写入版本。 */
export function markFallbackConfigReady(config: MxuConfig | null): void {
  if (!backendConfigLoaded && config) fallbackBaseline = stableConfigJson(config);
}

export function retryConfigSync(): void {
  configSync.retry();
}

export function hasVolatileConfigDrafts(): boolean {
  return configDrafts.hasVolatileDrafts();
}

export function isConfigDraftPersistent(draft: ConfigDraft): boolean {
  return configDrafts.isPersistent(draft);
}

export function suspendConfigSync(): void {
  configSync.suspend();
}

/** 重连刷新时不会发送旧快照；普通关闭只补发尚未落盘的编辑。 */
export function saveConfigForUnload(config: MxuConfig, projectName: string): boolean {
  preserveUnsavedConfig(config, projectName);
  const durable = !hasVolatileConfigDrafts();
  // 用户可能在草稿存储失败的离页确认中选择留下，不能提前暂停其后续保存。
  if (!durable) return false;
  const request = configSync.unloadRequest(config);
  if (!request) return durable;
  const payload = JSON.stringify(request);
  const url = `${getApiBase()}/config`;
  const sent =
    navigator.sendBeacon?.(url, new Blob([payload], { type: 'application/json' })) ?? false;
  if (!sent) {
    void fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }
  return durable;
}

// 配置文件子目录
const CONFIG_DIR = 'config';
const BACKUP_SUBDIR = 'config_backup';
/**
 * 备份池保留份数。
 *
 * 按份数而非按天数裁剪：按天数会在长期不使用后把备份池清空到 0 份，
 * 而自愈完全依赖这个池里还有候选可用。
 */
const BACKUP_KEEP_COUNT = 10;

/** 配置损坏后的自愈结果，供 UI 提示用户 */
export interface ConfigRecoveryNotice {
  kind: 'restored' | 'reset';
  /** kind 为 restored 时，被采用的那份备份的时间（用于展示） */
  backupTime?: string;
}

/**
 * 判断读到的配置内容是否已损坏。
 *
 * 断电 / 蓝屏后 NTFS 会保留文件长度但把数据读成全 0（文件大小走 journal 落了盘，
 * 数据没落盘）。NUL 是合法 UTF-8，`readTextFile` 不会失败，`parseJsonc` 也只打警告，
 * 所以这种「等长全零」必须显式识别出来。
 */
function isCorruptContent(content: string): boolean {
  return content.replace(/[\0\s]/g, '') === '';
}

/** 生成配置文件名 */
function getConfigFileName(projectName?: string): string {
  return projectName ? `mxu-${projectName}.json` : 'mxu.json';
}

/** 获取配置文件完整路径（同步版本，用于已知 dataPath 的场景） */
function getConfigPathSync(dataPath: string, projectName?: string): string {
  return joinPath(dataPath || '.', CONFIG_DIR, getConfigFileName(projectName));
}

/**
 * 从文件加载配置
 * @param basePath 基础路径（exe 所在目录）
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export async function readConfigSnapshot(): Promise<ConfigSnapshot<MxuConfig>> {
  let snapshot: ConfigSnapshot<MxuConfig>;
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    snapshot = await invoke<ConfigSnapshot<MxuConfig>>('get_config_snapshot');
  } else {
    const response = await fetch(`${getApiBase()}/config/snapshot`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Config snapshot failed: ${response.status}`);
    snapshot = (await response.json()) as ConfigSnapshot<MxuConfig>;
  }
  if (!isValidMxuConfig(snapshot.config) || typeof snapshot.revision !== 'string') {
    throw new Error('Invalid configuration snapshot');
  }
  return snapshot;
}

export function configSnapshotChanged(snapshot: ConfigSnapshot<MxuConfig>): boolean {
  return snapshot.revision !== configSync.getRevision();
}

/** 仅在调用方已决定保留/替换 UI 配置时接受版本，防止过期读取提前推进写入基线。 */
export function acceptConfigSnapshot(snapshot: ConfigSnapshot<MxuConfig>): void {
  const migrateLegacy = !backendConfigLoaded;
  backendConfigLoaded = true;
  configSync.adopt(snapshot);
  if (migrateLegacy && currentProjectName && !isTauri()) {
    try {
      const legacy = readStoredConfig(currentProjectName);
      if (legacy && configSync.hasChanges(legacy)) {
        const draft = configDrafts.save(legacy, currentProjectName, 'legacy');
        // 配额不足时保留原键作为持久恢复源。
        if (configDrafts.isPersistent(draft))
          localStorage.removeItem(storageKey(currentProjectName));
      }
    } catch (error) {
      log.warn('迁移本地配置草稿失败:', error);
    }
  }
}

export async function loadConfig(basePath: string, projectName?: string): Promise<MxuConfig> {
  currentProjectName = projectName;
  configSync.suspend();
  try {
    const snapshot = await readConfigSnapshot();
    acceptConfigSnapshot(snapshot);
    return snapshot.config;
  } catch (error) {
    // 已连接过真实后端的客户端不能退回缓存并把它当成当前版本。
    if (isTauri() || backendConfigLoaded) throw error;
  }

  // 纯前端开发预览仍允许静态配置和 localStorage；从不自动上传到真实后端。
  try {
    const fileName = getConfigFileName(projectName);
    const fetchPath =
      basePath === '' ? `/${CONFIG_DIR}/${fileName}` : `${basePath}/${CONFIG_DIR}/${fileName}`;
    const response = await fetch(fetchPath);
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const config = parseJsonc<MxuConfig>(await response.text(), fetchPath);
      if (isValidMxuConfig(config)) {
        fallbackBaseline = stableConfigJson(config);
        return config;
      }
    }
  } catch {
    /* 开发预览没有配置文件时使用默认值。 */
  }
  const config = readStoredConfig(projectName) ?? defaultConfig;
  fallbackBaseline = stableConfigJson(config);
  return config;
}

/**
 * 保存配置到文件
 * @param basePath 基础路径（exe 所在目录）
 * @param config 配置对象
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export async function saveConfig(
  _basePath: string,
  config: MxuConfig,
  projectName?: string,
): Promise<boolean> {
  if (isTauri() || backendConfigLoaded) {
    const draft = projectName ? preserveUnsavedConfig(config, projectName) : null;
    const saved = await configSync.save(config);
    if (saved && draft) {
      try {
        configDrafts.removeIfSaved(draft.key, (pending) => configSync.hasChanges(pending));
      } catch {
        /* 草稿保留不影响正常保存。 */
      }
    }
    return saved;
  }

  try {
    localStorage.setItem(storageKey(projectName), JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

/**
 * 浏览器环境下从 localStorage 加载配置
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export function loadConfigFromStorage(projectName?: string): MxuConfig | null {
  if (isTauri() || backendConfigLoaded) return null;
  return readStoredConfig(projectName);
}

function storageKey(projectName?: string): string {
  return projectName ? `mxu-config-${projectName}` : 'mxu-config';
}

function readStoredConfig(projectName?: string): MxuConfig | null {
  try {
    const stored = localStorage.getItem(storageKey(projectName));
    if (stored) {
      const config: unknown = JSON.parse(stored);
      return isValidMxuConfig(config) ? config : null;
    }
  } catch {
    // ignore
  }
  return null;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function parseTimestampFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

interface BackupEntry {
  name: string;
  path: string;
  time: Date;
}

/** 备份文件名前缀，例如 mxu-MaaEnd- */
function getBackupPrefix(projectName?: string): string {
  return `${getConfigFileName(projectName).replace(/\.json$/, '')}-`;
}

async function getBackupDir(): Promise<string> {
  return joinPath(await getCacheDir(), BACKUP_SUBDIR);
}

/** 列出该项目的所有备份，按时间从新到旧排序 */
async function listBackupsNewestFirst(projectName?: string): Promise<BackupEntry[]> {
  const { exists, readDir } = await import('@tauri-apps/plugin-fs');

  const backupDir = await getBackupDir();
  if (!(await exists(backupDir))) return [];

  const prefix = getBackupPrefix(projectName);
  const entries = await readDir(backupDir);
  const backups: BackupEntry[] = [];

  for (const entry of entries) {
    if (!entry.name || entry.isDirectory) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const time = parseTimestampFromFilename(entry.name);
    if (!time) continue;
    backups.push({ name: entry.name, path: joinPath(backupDir, entry.name), time });
  }

  backups.sort((a, b) => b.time.getTime() - a.time.getTime());
  return backups;
}

/** 把内容写入备份池，返回备份文件名 */
async function writeBackup(content: string, projectName?: string): Promise<string> {
  const { exists, writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');

  const backupDir = await getBackupDir();
  if (!(await exists(backupDir))) {
    await mkdir(backupDir, { recursive: true });
  }

  const backupFileName = `${getBackupPrefix(projectName)}${formatTimestamp(new Date())}.json`;
  await writeTextFile(joinPath(backupDir, backupFileName), content);
  return backupFileName;
}

/** 按份数裁剪备份池，只保留最近 BACKUP_KEEP_COUNT 份 */
async function pruneBackups(projectName?: string): Promise<void> {
  const backups = await listBackupsNewestFirst(projectName);
  if (backups.length <= BACKUP_KEEP_COUNT) return;

  const { remove } = await import('@tauri-apps/plugin-fs');
  for (const stale of backups.slice(BACKUP_KEEP_COUNT)) {
    try {
      await remove(stale.path);
      log.info(`已删除旧备份: ${stale.name}`);
    } catch (err) {
      log.warn(`删除旧备份失败: ${stale.path}`, err);
    }
  }
}

/**
 * 在更新前备份配置文件到 cache/config_backup/。
 *
 * 配置位于数据目录，更新是高风险操作，这里不受滚动备份的 1 天间隔限制，每次都写；
 * 多出来的同日条目由按份数裁剪消化。
 */
export async function backupConfigBeforeUpdate(
  dataPath: string,
  projectName?: string,
): Promise<void> {
  if (!isTauri()) return;

  const configPath = getConfigPathSync(dataPath, projectName);

  try {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');

    if (!(await exists(configPath))) {
      log.info('配置文件不存在，跳过备份');
      return;
    }

    const content = await readTextFile(configPath);
    if (isCorruptContent(content)) {
      log.warn('当前配置文件已损坏，跳过更新前备份');
      return;
    }

    const backupFileName = await writeBackup(content, projectName);
    log.info(`配置文件已备份: ${backupFileName}`);

    await pruneBackups(projectName);
  } catch (error) {
    log.warn('备份配置文件失败（不影响更新流程）:', error);
  }
}
