import type { MxuConfig } from '@/types/config';
import { defaultConfig, isValidMxuConfig } from '@/types/config';
import { loggers } from '@/utils/logger';
import { parseJsonc } from '@/utils/jsonc';
import { joinPath, isTauri, getCacheDir } from '@/utils/paths';
import { apiGet, apiPut } from '@/utils/backendApi';

const log = loggers.config;

/**
 * 追踪由本客户端发起的 config 保存次数。
 * 后端保存配置后会双通道广播 ConfigChanged（WS + Tauri 事件），所有客户端都会收到，
 * 用此计数器让发起方跳过自己触发的 config-changed 事件，避免 importConfig 重置 UI 状态。
 */
let _pendingSelfSaves = 0;

export function markSelfSave(): void {
  _pendingSelfSaves++;
}

export function consumeSelfSave(): boolean {
  if (_pendingSelfSaves > 0) {
    _pendingSelfSaves--;
    return true;
  }
  return false;
}

// 配置文件子目录
const CONFIG_DIR = 'config';
const BACKUP_SUBDIR = 'config_backup';
/** 滚动备份最小间隔：距上一份备份不足 1 天则跳过本次备份 */
const BACKUP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
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

let _recoveryNotice: ConfigRecoveryNotice | null = null;

/** 取走并清空自愈通知（与 markSelfSave / consumeSelfSave 同一模式） */
export function consumeConfigRecoveryNotice(): ConfigRecoveryNotice | null {
  const notice = _recoveryNotice;
  _recoveryNotice = null;
  return notice;
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

/** 获取配置目录路径（同步版本，用于已知 dataPath 的场景） */
function getConfigDirSync(dataPath: string): string {
  return joinPath(dataPath || '.', CONFIG_DIR);
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
export async function loadConfig(basePath: string, projectName?: string): Promise<MxuConfig> {
  if (isTauri()) {
    const configPath = getConfigPathSync(basePath, projectName);

    log.debug('加载配置, 路径:', configPath);

    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');

    if (await exists(configPath)) {
      let content: string | null = null;
      try {
        content = await readTextFile(configPath);
      } catch (err) {
        log.warn('读取配置文件失败:', err);
      }

      if (content !== null) {
        if (isCorruptContent(content)) {
          log.error('配置文件已损坏：内容为空或全为 NUL 字节');
        } else {
          // parseJsonc 解析失败时返回 undefined 而不抛异常，必须校验后再返回，
          // 否则 undefined 会一路传到调用方访问 config.instances 时才炸。
          const parsed = parseJsonc<MxuConfig>(content, configPath);
          if (isValidMxuConfig(parsed)) {
            log.info('配置加载成功');
            return parsed;
          }
          log.error('配置文件结构无效');
        }
      }

      // 文件存在但不可用：尝试从备份自愈。
      // 文件不存在时不做恢复，那是全新安装或用户主动移走了配置。
      const recovered = await tryRecoverConfig(basePath, projectName);
      if (recovered) return recovered;
      return defaultConfig;
    } else {
      log.info('配置文件不存在，使用默认配置');
    }
  } else {
    // 浏览器环境：优先从后端 HTTP API 获取（Tauri 进程运行时提供权威配置）
    try {
      const config = await apiGet<MxuConfig>('/config');
      if (isValidMxuConfig(config)) {
        log.info('配置加载成功（后端 HTTP API）');
        return config;
      }
    } catch {
      // API 不可用，继续尝试静态文件
    }

    // 回退：尝试从 public 目录加载（纯前端开发预览模式）
    try {
      const fileName = getConfigFileName(projectName);
      const fetchPath =
        basePath === '' ? `/${CONFIG_DIR}/${fileName}` : `${basePath}/${CONFIG_DIR}/${fileName}`;
      const response = await fetch(fetchPath);
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const content = await response.text();
          const config = parseJsonc<MxuConfig>(content, fetchPath);
          if (isValidMxuConfig(config)) {
            log.info('配置加载成功（浏览器环境静态文件）');
            return config;
          }
        }
      }
    } catch {
      // 浏览器环境加载失败是正常的
    }

    // 纯前端预览没有后端或静态配置时，恢复本地保存的设置（也可能还没有实例）。
    const storageConfig = loadConfigFromStorage(projectName);
    if (isValidMxuConfig(storageConfig)) {
      return storageConfig;
    }
  }

  return defaultConfig;
}

/**
 * 保存配置到文件
 * @param basePath 基础路径（exe 所在目录）
 * @param config 配置对象
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export async function saveConfig(
  basePath: string,
  config: MxuConfig,
  projectName?: string,
): Promise<boolean> {
  if (!isTauri()) {
    // 浏览器环境：优先通过后端 HTTP API 持久化（多端一致性）
    try {
      markSelfSave();
      await apiPut<{ ok: boolean }>('/config', config);
      log.debug('配置已通过后端 API 保存');
      return true;
    } catch {
      consumeSelfSave();
      // API 不可用，回退到 localStorage（离线/开发预览模式）
    }

    try {
      const storageKey = projectName ? `mxu-config-${projectName}` : 'mxu-config';
      localStorage.setItem(storageKey, JSON.stringify(config));
      log.debug('配置已保存到 localStorage（API 不可用时的回退）');
      return true;
    } catch {
      return false;
    }
  }

  const configDir = getConfigDirSync(basePath);
  const configPath = getConfigPathSync(basePath, projectName);

  log.debug('保存配置, 路径:', configPath);

  try {
    const { writeTextFile, mkdir, exists, readTextFile, rename, remove } =
      await import('@tauri-apps/plugin-fs');

    // 确保 config 目录存在
    if (!(await exists(configDir))) {
      log.debug('创建配置目录:', configDir);
      await mkdir(configDir, { recursive: true });
    }

    // 保护：拒绝用空实例覆盖已有的非空配置，避免“配置被清空”
    if (config.instances.length === 0 && (await exists(configPath))) {
      try {
        const existingContent = await readTextFile(configPath);
        const existingConfig = parseJsonc<Partial<MxuConfig>>(existingContent, configPath);
        const existingInstances = Array.isArray(existingConfig.instances)
          ? existingConfig.instances
          : [];
        if (existingInstances.length > 0) {
          log.error('检测到空实例覆盖风险，已拒绝保存:', configPath);
          return false;
        }
      } catch (err) {
        // 读取旧配置失败时，保持保守策略：拒绝覆盖，避免误清空
        log.error('读取现有配置失败，已拒绝覆盖保存:', err);
        return false;
      }
    }

    // 滚动备份：把磁盘上的上一代配置存进备份池。
    // 内含 1 天间隔判定，绝大多数保存会在这里直接返回。
    await rollingBackup(basePath, projectName);

    const content = JSON.stringify(config, null, 2);
    // 原子写：先写到 .tmp，再 rename 覆盖正式文件。
    // 这样即使进程在写入中途被杀（典型场景：自动更新后 Tauri relaunch
    // 触发 beforeunload，writeTextFile 已经把目标文件截断为 0 字节但内容还没
    // 落盘），目标文件也只会停留在上一份完整内容，不会出现空 / 损坏的
    // mxu-{projectName}.json。
    const tempPath = configPath + '.tmp';
    try {
      await writeTextFile(tempPath, content);
      await rename(tempPath, configPath);
    } catch (err) {
      // 写入或重命名失败时清理半成品 .tmp，避免遗留垃圾
      try {
        if (await exists(tempPath)) {
          await remove(tempPath);
        }
      } catch (cleanupErr) {
        log.debug('清理临时配置文件失败（忽略）:', cleanupErr);
      }
      throw err;
    }
    log.info('配置保存成功');

    // 通知 Rust 后端更新内存缓存并广播 config-changed 给所有其他客户端
    try {
      markSelfSave();
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('notify_config_changed', { config });
    } catch (err) {
      consumeSelfSave();
      log.debug('notify_config_changed 调用失败（不影响保存）:', err);
    }

    return true;
  } catch (err) {
    log.error('保存配置文件失败:', err);
    return false;
  }
}

/**
 * 浏览器环境下从 localStorage 加载配置
 * @param projectName 项目名称（来自 interface.json 的 name 字段）
 */
export function loadConfigFromStorage(projectName?: string): MxuConfig | null {
  if (isTauri()) return null;

  try {
    const storageKey = projectName ? `mxu-config-${projectName}` : 'mxu-config';
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      return JSON.parse(stored) as MxuConfig;
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

/** 供 toast 展示的备份时间 */
function formatBackupDisplayTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
 * 下一次允许尝试滚动备份的时刻，纯粹作为廉价的提前返回缓存。
 *
 * 间隔的权威来源始终是备份目录里最新那份的文件名时间戳——只靠内存变量的话，
 * 每次启动都会归零，用户一天开关几次程序就会各备份一次，1 天的间隔约束等于失效。
 */
let nextBackupAllowedAt: number | null = null;

/**
 * 滚动备份：把磁盘上的当前配置（即上一代内容）复制进备份池。
 *
 * 备份旧文件而不是即将写入的新内容——旧文件写入更早，数据大概率已经落盘，
 * 拿来当备份更可靠。当前文件本身已损坏时跳过，避免把损坏内容灌进备份池。
 */
async function rollingBackup(basePath: string, projectName?: string): Promise<void> {
  try {
    const now = Date.now();
    if (nextBackupAllowedAt !== null && now < nextBackupAllowedAt) return;

    const backups = await listBackupsNewestFirst(projectName);
    const newest = backups[0];
    if (newest && now - newest.time.getTime() < BACKUP_MIN_INTERVAL_MS) {
      nextBackupAllowedAt = newest.time.getTime() + BACKUP_MIN_INTERVAL_MS;
      return;
    }

    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    const configPath = getConfigPathSync(basePath, projectName);
    if (!(await exists(configPath))) return;

    const content = await readTextFile(configPath);
    if (
      isCorruptContent(content) ||
      !isValidMxuConfig(parseJsonc<MxuConfig>(content, configPath))
    ) {
      log.warn('当前配置文件不可用，跳过滚动备份');
      return;
    }

    // 与最新一份备份内容完全相同时没有备份价值；推迟下次尝试，避免每次保存都重复读盘
    if (newest) {
      try {
        if ((await readTextFile(newest.path)) === content) {
          nextBackupAllowedAt = now + BACKUP_MIN_INTERVAL_MS;
          return;
        }
      } catch {
        // 最新备份读不出来，当作需要重新备份
      }
    }

    const backupFileName = await writeBackup(content, projectName);
    nextBackupAllowedAt = Date.now() + BACKUP_MIN_INTERVAL_MS;
    log.info(`配置已滚动备份: ${backupFileName}`);

    await pruneBackups(projectName);
  } catch (err) {
    // 备份失败不能影响配置保存本身
    log.warn('滚动备份失败（不影响配置保存）:', err);
  }
}

/**
 * 配置损坏时尝试从备份池恢复，成功返回恢复出的配置。
 *
 * 按时间从新到旧逐个校验，取第一份有效的。必须能继续往前退——同一次崩溃很可能
 * 把最新那份备份也一起打成全零。
 */
async function tryRecoverConfig(basePath: string, projectName?: string): Promise<MxuConfig | null> {
  const { exists, readTextFile, writeTextFile, rename } = await import('@tauri-apps/plugin-fs');
  const configPath = getConfigPathSync(basePath, projectName);

  // 保留损坏文件，便于事后排查与提 issue
  try {
    if (await exists(configPath)) {
      const corruptPath = `${configPath}.corrupt-${formatTimestamp(new Date())}`;
      await rename(configPath, corruptPath);
      log.warn(`已保留损坏的配置文件: ${corruptPath}`);
    }
  } catch (err) {
    log.warn('保留损坏配置文件失败（继续尝试恢复）:', err);
  }

  let backups: BackupEntry[] = [];
  try {
    backups = await listBackupsNewestFirst(projectName);
  } catch (err) {
    log.error('读取备份目录失败:', err);
  }

  for (const backup of backups) {
    try {
      const content = await readTextFile(backup.path);
      if (isCorruptContent(content)) {
        log.warn(`备份已损坏，尝试更早的一份: ${backup.name}`);
        continue;
      }
      const parsed = parseJsonc<MxuConfig>(content, backup.path);
      if (!isValidMxuConfig(parsed)) {
        log.warn(`备份结构无效，尝试更早的一份: ${backup.name}`);
        continue;
      }

      await writeTextFile(configPath, content);
      _recoveryNotice = { kind: 'restored', backupTime: formatBackupDisplayTime(backup.time) };
      log.info(`配置已从备份恢复: ${backup.name}`);
      return parsed;
    } catch (err) {
      log.warn(`备份不可用，尝试更早的一份: ${backup.name}`, err);
    }
  }

  _recoveryNotice = { kind: 'reset' };
  log.error('没有可用备份，配置将重置为默认值');
  return null;
}

/**
 * 在更新前备份配置文件到 cache/config_backup/。
 *
 * 更新是高风险操作，这里不受滚动备份的 1 天间隔限制，每次都写；
 * 多出来的同日条目由按份数裁剪消化。
 */
export async function backupConfigBeforeUpdate(
  basePath: string,
  projectName?: string,
): Promise<void> {
  if (!isTauri()) return;

  const configPath = getConfigPathSync(basePath, projectName);

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
    nextBackupAllowedAt = Date.now() + BACKUP_MIN_INTERVAL_MS;
    log.info(`配置文件已备份: ${backupFileName}`);

    await pruneBackups(projectName);
  } catch (error) {
    log.warn('备份配置文件失败（不影响更新流程）:', error);
  }
}
