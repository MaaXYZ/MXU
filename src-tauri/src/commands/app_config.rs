//! 应用配置状态
//!
//! 为 HTTP 服务器提供 interface.json 和配置文件的内存缓存，
//! 与现有 MaaState 并列，由 `app.manage()` 注入。

use chrono::{Local, NaiveDateTime};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

/// 备份目录（位于 `{data_path}/cache/` 下）
const BACKUP_SUBDIR: &str = "config_backup";
/// 备份文件名与 `.corrupt-` 后缀共用的时间戳格式
const BACKUP_TIMESTAMP_FORMAT: &str = "%Y%m%d-%H%M%S";
/// 滚动备份最小间隔：距上一份备份不足 1 天则跳过本次备份
const BACKUP_MIN_INTERVAL_SECS: i64 = 24 * 60 * 60;
/// 备份池保留份数。
///
/// 按份数而非天数裁剪：按天数会在长期不使用后把备份池清空到 0 份，
/// 而自愈完全依赖这个池里还有候选可用。
const BACKUP_KEEP_COUNT: usize = 10;

/// 配置损坏自愈的结果类型
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigRecoveryKind {
    /// 已从某份备份恢复
    Restored,
    /// 没有可用备份，已重置为默认配置
    Reset,
}

/// 配置损坏后的自愈结果，供前端提示用户
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRecoveryNotice {
    pub kind: ConfigRecoveryKind,
    /// kind 为 Restored 时，被采用的那份备份的时间（用于展示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_time: Option<String>,
}

/// 内部配置同步快照；revision 不属于 PI，也不会写入用户配置文件。
#[derive(Clone, Debug, serde::Serialize)]
pub struct ConfigSnapshot {
    pub config: serde_json::Value,
    pub revision: String,
}

#[derive(serde::Deserialize)]
pub struct ConfigSaveRequest {
    pub config: serde_json::Value,
    pub revision: Option<String>,
    #[serde(default)]
    pub client_id: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ConfigSaveError {
    pub code: &'static str,
    pub message: String,
}

impl ConfigSaveError {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "save_failed",
            message: message.into(),
        }
    }
}

fn config_revision(config: &serde_json::Value) -> String {
    // serde_json 的默认 Map 按键排序，同一内容在重启后仍能安全比较。
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(config).expect("JSON value serializes"))
    )
}

/// 应用配置状态（供 HTTP server 使用）
#[derive(Default)]
pub struct AppConfigState {
    /// 已加载（含 import 合并、注释剥离）的 interface.json 内容
    pub project_interface: Mutex<Option<serde_json::Value>>,
    /// 翻译文件内容 (lang -> translations map)
    pub translations: Mutex<HashMap<String, serde_json::Value>>,
    /// exe 目录（基础路径，用于解析资源相对路径）
    pub base_path: Mutex<String>,
    /// 数据目录（配置文件存放位置）
    pub data_path: Mutex<String>,
    /// 项目名称（来自 interface.json 的 "name" 字段）
    pub project_name: Mutex<Option<String>>,
    /// 沿用已有桌面配置的安全原始文件名（如项目名含点），避免接管保存时切换文件。
    pub config_filename: Mutex<Option<String>>,
    /// 当前 MXU 配置（原始 JSON，启动时从磁盘加载，变更时写回）
    pub config: Mutex<serde_json::Value>,
    /// 配置损坏自愈的结果，等前端取走后清空
    pub recovery_notice: Mutex<Option<ConfigRecoveryNotice>>,
    /// 下一次允许尝试滚动备份的时刻，仅作为廉价的提前返回缓存
    pub next_backup_allowed_at: Mutex<Option<NaiveDateTime>>,
}

impl AppConfigState {
    /// 从 exe 目录加载 interface.json（含 import 处理）及翻译文件，写入内存
    pub fn load_interface(&self, exe_dir: &Path) {
        let interface_path = exe_dir.join("interface.json");

        if !interface_path.exists() {
            log::warn!(
                "AppConfigState: interface.json not found at {:?}",
                interface_path
            );
            return;
        }

        let content = match std::fs::read_to_string(&interface_path) {
            Ok(c) => c,
            Err(e) => {
                log::error!("AppConfigState: failed to read interface.json: {}", e);
                return;
            }
        };

        let mut interface: serde_json::Value = match parse_jsonc(&content) {
            Ok(v) => v,
            Err(e) => {
                log::error!("AppConfigState: failed to parse interface.json: {}", e);
                return;
            }
        };

        // 提取项目名称
        let project_name = interface
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        log::info!(
            "AppConfigState: loaded interface for project: {:?}",
            project_name
        );

        // 处理 import 字段（将额外文件合并到主 interface）
        process_imports(&mut interface, exe_dir);

        // 加载翻译文件
        let translations = load_translations(&interface, exe_dir);

        *self.project_interface.lock().unwrap() = Some(interface);
        *self.translations.lock().unwrap() = translations;
        *self.project_name.lock().unwrap() = project_name;
        *self.base_path.lock().unwrap() = exe_dir.to_string_lossy().to_string();
    }

    /// 从数据目录加载配置文件，写入内存
    pub fn load_config(&self, data_dir: &Path) {
        *self.data_path.lock().unwrap() = data_dir.to_string_lossy().to_string();

        let project_name = self.project_name.lock().unwrap().clone();
        let sanitized_filename = make_config_filename(project_name.as_deref());
        let config_dir = data_dir.join("config");
        let config_filename = project_name
            .as_deref()
            .and_then(|name| {
                if name.contains(['/', '\\', '\0', ':']) {
                    return None;
                }
                let filename = format!("mxu-{}.json", name);
                // 两份都存在时沿用桌面端；仅旧 Web 文件存在时保持兼容；新项目沿用原桌面命名。
                (config_dir.join(&filename).is_file()
                    || !config_dir.join(&sanitized_filename).exists())
                .then_some(filename)
            })
            .unwrap_or(sanitized_filename);
        *self.config_filename.lock().unwrap() = Some(config_filename.clone());
        let config_path = data_dir.join("config").join(&config_filename);

        if config_path.exists() {
            match std::fs::read_to_string(&config_path) {
                Ok(content) => {
                    if is_corrupt_content(&content) {
                        log::error!("AppConfigState: config is corrupt (empty or all-NUL bytes)");
                    } else {
                        match parse_jsonc(&content) {
                            Ok(config) if is_valid_mxu_config(&config) => {
                                log::info!("AppConfigState: config loaded from {:?}", config_path);
                                *self.config.lock().unwrap() = config;
                                return;
                            }
                            Ok(_) => {
                                log::error!("AppConfigState: config structure is invalid");
                            }
                            Err(e) => {
                                log::error!("AppConfigState: failed to parse config: {}", e);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::error!("AppConfigState: failed to read config: {}", e);
                }
            }

            // 文件存在但不可用：尝试从备份自愈。
            // 文件不存在时不做恢复，那是全新安装或用户主动移走了配置。
            if let Some(recovered) =
                self.try_recover_config(data_dir, &config_filename, &config_path)
            {
                *self.config.lock().unwrap() = recovered;
                return;
            }
        } else {
            log::info!(
                "AppConfigState: config file not found at {:?}, using default",
                config_path
            );
        }

        // 默认配置（第一次使用时）
        *self.config.lock().unwrap() = default_config();
    }

    /// 配置损坏时尝试从备份池恢复，成功返回恢复出的配置。
    ///
    /// 按时间从新到旧逐个校验，取第一份有效的。必须能继续往前退——同一次崩溃很可能
    /// 把最新那份备份也一起打成全零。
    fn try_recover_config(
        &self,
        data_path: &Path,
        config_filename: &str,
        config_path: &Path,
    ) -> Option<serde_json::Value> {
        // 保留损坏文件，便于事后排查与提 issue
        if config_path.exists() {
            let corrupt_path = config_path.with_file_name(format!(
                "{}.corrupt-{}",
                config_filename,
                Local::now().format(BACKUP_TIMESTAMP_FORMAT)
            ));
            match std::fs::rename(config_path, &corrupt_path) {
                Ok(()) => log::warn!("AppConfigState: kept corrupt config at {:?}", corrupt_path),
                Err(e) => log::warn!("AppConfigState: failed to keep corrupt config: {}", e),
            }
        }

        for backup in list_backups_newest_first(data_path, config_filename) {
            let content = match std::fs::read_to_string(&backup.path) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!(
                        "AppConfigState: backup {} unreadable, trying an older one: {}",
                        backup.name,
                        e
                    );
                    continue;
                }
            };

            if is_corrupt_content(&content) {
                log::warn!(
                    "AppConfigState: backup {} is corrupt, trying an older one",
                    backup.name
                );
                continue;
            }

            let parsed = match parse_jsonc(&content) {
                Ok(v) if is_valid_mxu_config(&v) => v,
                _ => {
                    log::warn!(
                        "AppConfigState: backup {} is invalid, trying an older one",
                        backup.name
                    );
                    continue;
                }
            };

            // 写回磁盘，让随后读盘的前端直接拿到好文件；写失败也仍然可以用内存里这份
            if let Err(e) = std::fs::write(config_path, &content) {
                log::error!("AppConfigState: failed to restore config to disk: {}", e);
            }

            *self.recovery_notice.lock().unwrap() = Some(ConfigRecoveryNotice {
                kind: ConfigRecoveryKind::Restored,
                backup_time: Some(format_backup_display_time(backup.time)),
            });
            log::info!(
                "AppConfigState: config restored from backup {}",
                backup.name
            );
            return Some(parsed);
        }

        *self.recovery_notice.lock().unwrap() = Some(ConfigRecoveryNotice {
            kind: ConfigRecoveryKind::Reset,
            backup_time: None,
        });
        log::error!("AppConfigState: no usable backup, config will be reset to default");
        None
    }

    /// 滚动备份：把磁盘上的当前配置（即上一代内容）复制进备份池。
    ///
    /// 备份旧文件而不是即将写入的新内容——旧文件写入更早、数据大概率已经落盘，
    /// 拿来当备份更可靠。当前文件本身已损坏时跳过，避免把损坏内容灌进备份池。
    ///
    /// 间隔的权威来源是备份目录里最新那份的文件名时间戳。只靠内存变量的话每次启动
    /// 都会归零，用户一天开关几次程序就会各备份一次，1 天的间隔约束等于失效。
    fn rolling_backup(&self, data_path: &Path, config_filename: &str, config_path: &Path) {
        let now = Local::now().naive_local();
        let interval = chrono::Duration::seconds(BACKUP_MIN_INTERVAL_SECS);

        if let Some(allowed_at) = *self.next_backup_allowed_at.lock().unwrap() {
            if now < allowed_at {
                return;
            }
        }

        let backups = list_backups_newest_first(data_path, config_filename);
        let newest = backups.first();

        if let Some(newest) = newest {
            if now.signed_duration_since(newest.time) < interval {
                *self.next_backup_allowed_at.lock().unwrap() = Some(newest.time + interval);
                return;
            }
        }

        // 还没有配置文件可备份
        let Ok(content) = std::fs::read_to_string(config_path) else {
            return;
        };

        let usable = !is_corrupt_content(&content)
            && parse_jsonc(&content)
                .map(|v| is_valid_mxu_config(&v))
                .unwrap_or(false);
        if !usable {
            log::warn!("AppConfigState: current config is unusable, skipping rolling backup");
            return;
        }

        // 与最新一份备份内容相同时没有备份价值；推迟下次尝试，避免每次保存都重复读盘
        if let Some(newest) = newest {
            if std::fs::read_to_string(&newest.path).ok().as_deref() == Some(content.as_str()) {
                *self.next_backup_allowed_at.lock().unwrap() = Some(now + interval);
                return;
            }
        }

        match write_backup(data_path, config_filename, &content) {
            Ok(name) => {
                *self.next_backup_allowed_at.lock().unwrap() = Some(now + interval);
                log::info!("AppConfigState: rolling backup written {}", name);
                prune_backups(data_path, config_filename);
            }
            Err(e) => {
                log::warn!(
                    "AppConfigState: rolling backup failed (save continues): {}",
                    e
                );
            }
        }
    }

    pub fn snapshot(&self) -> Result<ConfigSnapshot, String> {
        let config = self.config.lock().map_err(|e| e.to_string())?;
        Ok(ConfigSnapshot {
            revision: config_revision(&config),
            config: config.clone(),
        })
    }

    /// 条件检查、磁盘写入及内存更新共用同一把锁，避免多个客户端同时通过检查。
    pub fn save_config(
        &self,
        request: ConfigSaveRequest,
    ) -> Result<ConfigSnapshot, ConfigSaveError> {
        // ID 会进入广播队列；它只是关联提示，不能携带任意大的调用方数据。
        if request.client_id.len() > 128
            || !request
                .client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ConfigSaveError {
                code: "invalid_client_id",
                message: "Client ID must contain at most 128 ASCII letters, digits, '-' or '_'"
                    .to_string(),
            });
        }
        let mut current = self
            .config
            .lock()
            .map_err(|e| ConfigSaveError::failed(e.to_string()))?;
        let revision = config_revision(&current);
        if request.revision.as_deref() != Some(revision.as_str()) {
            return Err(ConfigSaveError {
                code: if request.revision.is_none() {
                    "revision_required"
                } else {
                    "conflict"
                },
                message: "配置已在其它客户端更新，请重新加载后再编辑".to_string(),
            });
        }
        let config = request.config;
        if !is_valid_mxu_config(&config) {
            return Err(ConfigSaveError {
                code: "invalid_config",
                message: "配置结构无效".to_string(),
            });
        }
        let data_path = self.data_path.lock().unwrap().clone();
        if data_path.is_empty() {
            return Err(ConfigSaveError::failed("数据路径未初始化"));
        }

        let project_name = self.project_name.lock().unwrap().clone();
        let config_filename = self
            .config_filename
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| make_config_filename(project_name.as_deref()));
        let config_dir = Path::new(&data_path).join("config");

        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir)
                .map_err(|e| ConfigSaveError::failed(format!("创建配置目录失败: {}", e)))?;
        }

        let config_path = config_dir.join(&config_filename);

        // 保留原有保护：拒绝空实例列表覆盖已有非空配置。
        let new_instances_empty = config
            .get("instances")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true);

        if new_instances_empty && config_path.exists() {
            if let Ok(existing_content) = std::fs::read_to_string(&config_path) {
                if let Ok(existing) = parse_jsonc(&existing_content) {
                    let existing_non_empty = existing
                        .get("instances")
                        .and_then(|v| v.as_array())
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    if existing_non_empty {
                        log::error!(
                            "AppConfigState: refusing to overwrite non-empty config with empty instances"
                        );
                        return Err(ConfigSaveError::failed("拒绝用空实例列表覆盖已有配置"));
                    }
                }
            }
        }

        // 滚动备份：把磁盘上的上一代配置存进备份池。
        // 内含 1 天间隔判定，绝大多数保存会在这里直接返回。
        self.rolling_backup(Path::new(&data_path), &config_filename, &config_path);

        let content = serde_json::to_string_pretty(&config)
            .map_err(|e| ConfigSaveError::failed(format!("序列化配置失败: {}", e)))?;

        // 原子写：先写到 .tmp，再 rename 覆盖正式文件。
        // 避免进程在写入中途被杀
        // （如自动更新触发的 Tauri relaunch）时把配置文件截断为 0 字节。
        // std::fs::rename 在 Windows 上走 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
        // 在 Unix 上是原子的 rename(2)，同文件系统内可保证原子替换。
        let tmp_path = config_path.with_extension("json.tmp");
        std::fs::write(&tmp_path, content).map_err(|e| {
            // 清理半成品 .tmp，避免遗留
            let _ = std::fs::remove_file(&tmp_path);
            ConfigSaveError::failed(format!("写入临时配置文件失败: {}", e))
        })?;
        if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(ConfigSaveError::failed(format!(
                "重命名配置文件失败: {}",
                e
            )));
        }

        let snapshot = ConfigSnapshot {
            revision: config_revision(&config),
            config: config.clone(),
        };
        *current = config;
        log::debug!("AppConfigState: config saved to {:?}", config_path);
        Ok(snapshot)
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 桌面端和 WebUI 共用后端快照与条件写入，避免桌面直接写盘绕过并发检查。
#[tauri::command]
pub fn get_config_snapshot(state: State<Arc<AppConfigState>>) -> Result<ConfigSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn save_config_snapshot(
    app: tauri::AppHandle,
    state: State<Arc<AppConfigState>>,
    request: ConfigSaveRequest,
) -> Result<ConfigSnapshot, ConfigSaveError> {
    let client_id = request.client_id.clone();
    let snapshot = state.save_config(request)?;
    super::utils::emit_config_changed(&app, &client_id, &snapshot.revision);
    Ok(snapshot)
}

/// 取走并清空配置自愈通知（前端启动时调用一次）
#[tauri::command]
pub fn take_config_recovery_notice(
    state: State<Arc<AppConfigState>>,
) -> Result<Option<ConfigRecoveryNotice>, String> {
    Ok(state
        .recovery_notice
        .lock()
        .map_err(|e| e.to_string())?
        .take())
}

// ============================================================================
// 内部辅助函数
// ============================================================================

fn default_config() -> serde_json::Value {
    serde_json::json!({
        "version": "1.0",
        "instances": [],
        "settings": {
            "theme": "system",
            "language": "system"
        }
    })
}

/// 判断读到的配置内容是否已损坏。
///
/// 断电 / 蓝屏后 NTFS 会保留文件长度但把数据读成全 0（文件大小走 journal 落了盘，
/// 数据没落盘）。NUL 是合法 UTF-8，`read_to_string` 不会失败，所以这种「等长全零」
/// 必须显式识别出来。空文件同样视为损坏。
fn is_corrupt_content(content: &str) -> bool {
    content.chars().all(|c| c == '\0' || c.is_whitespace())
}

/// 判断 JSON 是否是结构上可用的 MXU 配置（与前端 `isValidMxuConfig` 保持一致）
fn is_valid_mxu_config(value: &serde_json::Value) -> bool {
    value.get("version").and_then(|v| v.as_str()).is_some()
        && value.get("instances").and_then(|v| v.as_array()).is_some()
        && value.get("settings").and_then(|v| v.as_object()).is_some()
}

struct BackupEntry {
    name: String,
    path: PathBuf,
    time: NaiveDateTime,
}

fn backup_dir(data_path: &Path) -> PathBuf {
    data_path.join("cache").join(BACKUP_SUBDIR)
}

/// 备份文件名前缀，例如 `mxu-MaaEnd-`
fn make_backup_prefix(config_filename: &str) -> String {
    format!(
        "{}-",
        config_filename
            .strip_suffix(".json")
            .unwrap_or(config_filename)
    )
}

fn parse_backup_timestamp(filename: &str, prefix: &str) -> Option<NaiveDateTime> {
    let stem = filename.strip_prefix(prefix)?.strip_suffix(".json")?;
    NaiveDateTime::parse_from_str(stem, BACKUP_TIMESTAMP_FORMAT).ok()
}

/// 供前端展示的备份时间
fn format_backup_display_time(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%d %H:%M").to_string()
}

/// 列出该项目的所有备份，按时间从新到旧排序
fn list_backups_newest_first(data_path: &Path, config_filename: &str) -> Vec<BackupEntry> {
    let dir = backup_dir(data_path);
    let prefix = make_backup_prefix(config_filename);

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut backups: Vec<BackupEntry> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let time = parse_backup_timestamp(&name, &prefix)?;
            Some(BackupEntry {
                path: dir.join(&name),
                name,
                time,
            })
        })
        .collect();

    backups.sort_by_key(|b| std::cmp::Reverse(b.time));
    backups
}

/// 把内容写入备份池，返回备份文件名
fn write_backup(
    data_path: &Path,
    config_filename: &str,
    content: &str,
) -> Result<String, std::io::Error> {
    let dir = backup_dir(data_path);
    std::fs::create_dir_all(&dir)?;

    let name = format!(
        "{}{}.json",
        make_backup_prefix(config_filename),
        Local::now().format(BACKUP_TIMESTAMP_FORMAT)
    );
    std::fs::write(dir.join(&name), content)?;
    Ok(name)
}

/// 按份数裁剪备份池，只保留最近 `BACKUP_KEEP_COUNT` 份
fn prune_backups(data_path: &Path, config_filename: &str) {
    let backups = list_backups_newest_first(data_path, config_filename);
    for stale in backups.iter().skip(BACKUP_KEEP_COUNT) {
        match std::fs::remove_file(&stale.path) {
            Ok(()) => log::info!("AppConfigState: removed old backup {}", stale.name),
            Err(e) => log::warn!(
                "AppConfigState: failed to remove old backup {}: {}",
                stale.name,
                e
            ),
        }
    }
}

pub(crate) fn make_config_filename(project_name: Option<&str>) -> String {
    match project_name {
        Some(name) => {
            let sanitized: String = name
                .chars()
                .map(|c| {
                    if c == '/' || c == '\\' || c == '.' || c == ':' {
                        '_'
                    } else {
                        c
                    }
                })
                .collect();
            format!("mxu-{}.json", sanitized)
        }
        None => "mxu.json".to_string(),
    }
}

/// 加载 interface.json 中声明的翻译文件
fn load_translations(
    interface: &serde_json::Value,
    base_dir: &Path,
) -> HashMap<String, serde_json::Value> {
    let mut translations = HashMap::new();

    let languages = match interface.get("languages").and_then(|v| v.as_object()) {
        Some(l) => l.clone(),
        None => return translations,
    };

    for (lang, rel_path) in &languages {
        let rel_path_str = match rel_path.as_str() {
            Some(s) => s,
            None => continue,
        };
        let lang_path = base_dir.join(rel_path_str);
        if lang_path.exists() {
            match std::fs::read_to_string(&lang_path) {
                Ok(content) => match parse_jsonc(&content) {
                    Ok(value) => {
                        translations.insert(lang.clone(), value);
                    }
                    Err(e) => {
                        log::warn!("AppConfigState: parse translation [{}] failed: {}", lang, e);
                    }
                },
                Err(e) => {
                    log::warn!("AppConfigState: read translation [{}] failed: {}", lang, e);
                }
            }
        }
    }

    translations
}

/// 处理 interface.json 中的 `import` 字段，将额外文件合并到主 interface
fn process_imports(interface: &mut serde_json::Value, base_dir: &Path) {
    let imports: Vec<String> = match interface.get("import").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        None => return,
    };

    for rel_path in &imports {
        let full_path = base_dir.join(rel_path);
        match std::fs::read_to_string(&full_path) {
            Ok(content) => match parse_jsonc(&content) {
                Ok(imported) => {
                    merge_imported(interface, &imported);
                    log::info!("AppConfigState: merged import {:?}", rel_path);
                }
                Err(e) => {
                    log::warn!("AppConfigState: parse import {:?} failed: {}", rel_path, e);
                }
            },
            Err(e) => {
                log::warn!("AppConfigState: read import {:?} failed: {}", rel_path, e);
            }
        }
    }
}

/// 将导入的内容合并到主 interface（与 interfaceLoader.ts 的 mergeImported 行为一致）
fn merge_imported(interface: &mut serde_json::Value, imported: &serde_json::Value) {
    // 合并 task 数组（追加到末尾）
    if let Some(tasks) = imported.get("task").and_then(|v| v.as_array()) {
        if let Some(arr) = interface.get_mut("task").and_then(|v| v.as_array_mut()) {
            arr.extend(tasks.iter().cloned());
        } else {
            interface["task"] = serde_json::Value::Array(tasks.to_vec());
        }
    }

    // 合并 option 对象（后导入覆盖先导入）
    if let Some(options) = imported.get("option").and_then(|v| v.as_object()) {
        if let Some(main_opts) = interface.get_mut("option").and_then(|v| v.as_object_mut()) {
            for (k, v) in options {
                main_opts.insert(k.clone(), v.clone());
            }
        } else {
            interface["option"] = imported["option"].clone();
        }
    }

    // 合并 preset 数组（追加到末尾）
    if let Some(presets) = imported.get("preset").and_then(|v| v.as_array()) {
        if let Some(arr) = interface.get_mut("preset").and_then(|v| v.as_array_mut()) {
            arr.extend(presets.iter().cloned());
        } else {
            interface["preset"] = serde_json::Value::Array(presets.to_vec());
        }
    }

    // MXU 扩展：合并 setting 数组（追加到末尾，保持导入顺序）
    if let Some(settings) = imported.get("setting").and_then(|v| v.as_array()) {
        if let Some(arr) = interface.get_mut("setting").and_then(|v| v.as_array_mut()) {
            arr.extend(settings.iter().cloned());
        } else {
            interface["setting"] = serde_json::Value::Array(settings.to_vec());
        }
    }

    // 合并 group 数组（按 name 去重，先定义优先）
    if let Some(groups) = imported.get("group").and_then(|v| v.as_array()) {
        let existing_names: std::collections::HashSet<String> = interface
            .get("group")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|g| {
                        g.get("name")
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();

        let new_groups: Vec<serde_json::Value> = groups
            .iter()
            .filter(|g| {
                !g.get("name")
                    .and_then(|n| n.as_str())
                    .map(|name| existing_names.contains(name))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();

        if !new_groups.is_empty() {
            if let Some(arr) = interface.get_mut("group").and_then(|v| v.as_array_mut()) {
                arr.extend(new_groups);
            } else {
                interface["group"] = serde_json::Value::Array(new_groups);
            }
        }
    }

    // v2.7.0: 合并 pretask（单对象视为一项，按导入顺序追加为有序列表）
    let imported_pretasks = normalize_external_task(imported.get("pretask"));
    if !imported_pretasks.is_empty() {
        let mut merged = normalize_external_task(interface.get("pretask"));
        merged.extend(imported_pretasks);
        interface["pretask"] = serde_json::Value::Array(merged);
    }
}

/// 将 pretask 字段（单对象或数组）标准化为 Vec，未定义则返回空 Vec。
fn normalize_external_task(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    match value {
        Some(serde_json::Value::Array(arr)) => arr.clone(),
        Some(v) if v.is_object() => vec![v.clone()],
        _ => Vec::new(),
    }
}

/// 解析 JSONC（带注释的 JSON），去除 `//` 和 `/* */` 注释后用 serde_json 解析
pub fn parse_jsonc(content: &str) -> Result<serde_json::Value, serde_json::Error> {
    let stripped = strip_jsonc_comments(content);
    serde_json::from_str(&strip_trailing_commas(&stripped))
}

/// 与原桌面端 jsonc-parser 的 allowTrailingComma 行为一致，字符串中的逗号不变。
fn strip_trailing_commas(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut in_string = false;
    let mut escape_next = false;
    while let Some(ch) = chars.next() {
        if escape_next {
            result.push(ch);
            escape_next = false;
            continue;
        }
        if in_string {
            if ch == '\\' {
                escape_next = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
        } else if ch == ',' && matches!(chars.clone().find(|c| !c.is_whitespace()), Some('}' | ']'))
        {
            continue;
        }
        result.push(ch);
    }
    result
}

/// 去除 JSONC 中的注释，保留字符串内的斜杠字符
fn strip_jsonc_comments(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut in_string = false;
    let mut escape_next = false;

    while let Some(ch) = chars.next() {
        if escape_next {
            result.push(ch);
            escape_next = false;
            continue;
        }

        if in_string {
            match ch {
                '\\' => {
                    result.push(ch);
                    escape_next = true;
                }
                '"' => {
                    result.push(ch);
                    in_string = false;
                }
                _ => result.push(ch),
            }
            continue;
        }

        match ch {
            '"' => {
                result.push(ch);
                in_string = true;
            }
            '/' => match chars.peek() {
                Some('/') => {
                    chars.next(); // consume second '/'
                    for c in chars.by_ref() {
                        if c == '\n' {
                            result.push('\n');
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next(); // consume '*'
                    loop {
                        match chars.next() {
                            Some('*') if chars.peek() == Some(&'/') => {
                                chars.next(); // consume '/'
                                break;
                            }
                            None => break,
                            _ => {}
                        }
                    }
                }
                _ => result.push(ch),
            },
            _ => result.push(ch),
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mxu-config-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_config_file(data_path: &Path, content: &str) -> PathBuf {
        let config_dir = data_path.join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config_path = config_dir.join("mxu-MaaEnd.json");
        std::fs::write(&config_path, content).unwrap();
        config_path
    }

    fn sample_config_json() -> String {
        serde_json::to_string(&serde_json::json!({
            "version": "1.0",
            "instances": [{ "id": "a" }],
            "settings": { "theme": "dark" }
        }))
        .unwrap()
    }

    fn initialized_state(tag: &str) -> (AppConfigState, PathBuf) {
        let data_path = make_temp_dir(tag);
        write_config_file(&data_path, &sample_config_json());
        let state = AppConfigState::default();
        *state.project_name.lock().unwrap() = Some("MaaEnd".to_string());
        state.load_config(&data_path);
        (state, data_path)
    }

    fn save_request(config: serde_json::Value, revision: Option<&str>) -> ConfigSaveRequest {
        ConfigSaveRequest {
            config,
            revision: revision.map(str::to_string),
            client_id: "test-client".to_string(),
        }
    }

    #[test]
    fn caller_ids_are_bounded_before_saving_or_broadcasting() {
        let (state, data_path) = initialized_state("client-id-limit");
        let initial = state.snapshot().unwrap();
        for id in [
            "a".repeat(129),
            "invalid/id".to_string(),
            "身份".to_string(),
        ] {
            let mut request = save_request(initial.config.clone(), Some(&initial.revision));
            request.client_id = id;
            assert_eq!(
                state.save_config(request).unwrap_err().code,
                "invalid_client_id"
            );
            assert_eq!(state.snapshot().unwrap().revision, initial.revision);
        }
        let mut request = save_request(initial.config.clone(), Some(&initial.revision));
        request.client_id = "a".repeat(128);
        assert!(state.save_config(request).is_ok());
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn stale_or_unversioned_browser_cannot_overwrite_desktop_config() {
        let (state, data_path) = initialized_state("stale-browser");
        let browser_snapshot = state.snapshot().unwrap();
        let mut desktop_config = browser_snapshot.config.clone();
        desktop_config["instances"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "id": "new-desktop-tab" }));
        let saved = state
            .save_config(save_request(
                desktop_config,
                Some(&browser_snapshot.revision),
            ))
            .unwrap();
        for revision in [None, Some(browser_snapshot.revision.as_str())] {
            let error = state
                .save_config(save_request(browser_snapshot.config.clone(), revision))
                .unwrap_err();
            assert!(matches!(error.code, "revision_required" | "conflict"));
        }
        let disk: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(data_path.join("config/mxu-MaaEnd.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk, saved.config);
        assert_eq!(state.snapshot().unwrap().config, saved.config);
        assert!(
            disk.get("revision").is_none(),
            "sync metadata must not enter the config file"
        );
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn two_simultaneous_browsers_cannot_both_commit_the_same_base_revision() {
        let (state, data_path) = initialized_state("concurrent-browsers");
        let state = Arc::new(state);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let snapshot = state.snapshot().unwrap();
        let threads: Vec<_> = ["browser-a", "browser-b"]
            .into_iter()
            .map(|name| {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                let mut config = snapshot.config.clone();
                config["instances"] = serde_json::json!([{ "id": name }]);
                let revision = snapshot.revision.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    state.save_config(save_request(config, Some(&revision)))
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| result.as_ref().is_err_and(|error| error.code == "conflict"))
                .count(),
            1
        );
        let disk: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(data_path.join("config/mxu-MaaEnd.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk, state.snapshot().unwrap().config);
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn host_restart_still_rejects_a_browser_snapshot_from_before_a_desktop_edit() {
        let (state, data_path) = initialized_state("restart-revision");
        let old = state.snapshot().unwrap();
        let mut config = old.config.clone();
        config["settings"]["theme"] = serde_json::json!("light");
        let saved = state
            .save_config(save_request(config, Some(&old.revision)))
            .unwrap();
        let restarted = AppConfigState::default();
        *restarted.project_name.lock().unwrap() = Some("MaaEnd".to_string());
        restarted.load_config(&data_path);
        assert_eq!(restarted.snapshot().unwrap().revision, saved.revision);
        assert_eq!(
            restarted
                .save_config(save_request(old.config, Some(&old.revision)))
                .unwrap_err()
                .code,
            "conflict"
        );
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn failed_disk_write_keeps_the_current_snapshot_and_revision() {
        let (state, data_path) = initialized_state("failed-write");
        let old = state.snapshot().unwrap();
        let config_path = data_path.join("config/mxu-MaaEnd.json");
        let original_disk = std::fs::read_to_string(&config_path).unwrap();
        // 模拟原子写临时文件无法创建，正式文件不能被截断或替换。
        std::fs::create_dir(config_path.with_extension("json.tmp")).unwrap();
        let mut config = old.config.clone();
        config["settings"]["theme"] = serde_json::json!("light");
        assert!(state
            .save_config(save_request(config, Some(&old.revision)))
            .is_err());
        let current = state.snapshot().unwrap();
        assert_eq!(current.revision, old.revision);
        assert_eq!(current.config, old.config);
        assert_eq!(std::fs::read_to_string(config_path).unwrap(), original_disk);
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn shared_backend_loader_preserves_jsonc_desktop_configs() {
        let data_path = make_temp_dir("jsonc-loader");
        write_config_file(
            &data_path,
            r#"// Desktop config
        { "version": "1.0", "instances": [{ "id": "a", },], "settings": { "theme": "dark", "literal": ",]", }, }
        "#,
        );
        let state = AppConfigState::default();
        *state.project_name.lock().unwrap() = Some("MaaEnd".to_string());
        state.load_config(&data_path);
        assert_eq!(state.snapshot().unwrap().config["instances"][0]["id"], "a");
        assert_eq!(
            state.snapshot().unwrap().config["settings"]["literal"],
            ",]"
        );
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn jsonc_configs_are_backed_up_and_jsonc_backups_can_be_recovered() {
        let data_path = make_temp_dir("jsonc-backup");
        let jsonc = r#"// existing desktop config
        { "version": "1.0", "instances": [{ "id": "a", },], "settings": { "theme": "dark", }, }
        "#;
        let config_path = write_config_file(&data_path, jsonc);
        let state = AppConfigState::default();
        *state.project_name.lock().unwrap() = Some("MaaEnd".to_string());
        state.load_config(&data_path);
        let snapshot = state.snapshot().unwrap();
        let mut edited = snapshot.config.clone();
        edited["settings"]["theme"] = serde_json::json!("light");
        state
            .save_config(save_request(edited, Some(&snapshot.revision)))
            .unwrap();
        let backups = list_backups_newest_first(&data_path, "mxu-MaaEnd.json");
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0].path).unwrap(), jsonc);
        std::fs::write(&config_path, "\0\0").unwrap();
        state.load_config(&data_path);
        assert_eq!(
            state.snapshot().unwrap().config["settings"]["theme"],
            "dark"
        );
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn desktop_filename_with_dots_remains_authoritative_when_backend_takes_over_writes() {
        let data_path = make_temp_dir("filename-compat");
        std::fs::create_dir_all(data_path.join("config")).unwrap();
        let raw_path = data_path.join("config/mxu-Maa.Custom.json");
        let sanitized_path = data_path.join("config/mxu-Maa_Custom.json");
        std::fs::write(&raw_path, sample_config_json()).unwrap();
        let legacy_web_content = sample_config_json().replace("dark", "system");
        std::fs::write(&sanitized_path, &legacy_web_content).unwrap();
        let state = AppConfigState::default();
        *state.project_name.lock().unwrap() = Some("Maa.Custom".to_string());
        state.load_config(&data_path);
        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.config["settings"]["theme"], "dark");
        let mut edited = snapshot.config;
        edited["settings"]["theme"] = serde_json::json!("light");
        state
            .save_config(save_request(edited, Some(&snapshot.revision)))
            .unwrap();
        let disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&raw_path).unwrap()).unwrap();
        assert_eq!(disk["settings"]["theme"], "light");
        assert_eq!(
            std::fs::read_to_string(&sanitized_path).unwrap(),
            legacy_web_content
        );
        std::fs::remove_file(raw_path).unwrap();
        state.load_config(&data_path);
        assert_eq!(
            state.snapshot().unwrap().config["settings"]["theme"],
            "system"
        );
        std::fs::remove_dir_all(data_path).unwrap();
    }

    #[test]
    fn corrupt_content_detects_all_zero_and_blank() {
        // issue #4710 的真实样本形态：71578 字节全 0x00
        assert!(is_corrupt_content(&"\0".repeat(71578)));
        assert!(is_corrupt_content(""));
        assert!(is_corrupt_content("  \r\n\t "));
        assert!(is_corrupt_content("\0\0 \n\0"));
        assert!(!is_corrupt_content("{}"));
        assert!(!is_corrupt_content(&sample_config_json()));
    }

    #[test]
    fn valid_mxu_config_requires_core_fields() {
        assert!(is_valid_mxu_config(&default_config()));

        assert!(!is_valid_mxu_config(&serde_json::json!(null)));
        assert!(!is_valid_mxu_config(&serde_json::json!([])));
        assert!(!is_valid_mxu_config(
            &serde_json::json!({ "instances": [], "settings": {} })
        ));
        assert!(!is_valid_mxu_config(
            &serde_json::json!({ "version": 1, "instances": [], "settings": {} })
        ));
        assert!(!is_valid_mxu_config(
            &serde_json::json!({ "version": "1.0", "instances": {}, "settings": {} })
        ));
        assert!(!is_valid_mxu_config(
            &serde_json::json!({ "version": "1.0", "instances": [], "settings": [] })
        ));
    }

    #[test]
    fn backup_listing_is_newest_first_and_project_scoped() {
        let data_path = make_temp_dir("listing");
        let dir = backup_dir(&data_path);
        std::fs::create_dir_all(&dir).unwrap();

        for name in [
            "mxu-MaaEnd-20260101-000000.json",
            "mxu-MaaEnd-20260103-120000.json",
            "mxu-MaaEnd-20260102-000000.json",
            // 属于其他项目，不应出现在结果里
            "mxu-Other-20260104-000000.json",
            // 文件名里没有合法时间戳，不是备份
            "mxu-MaaEnd-notatimestamp.json",
        ] {
            std::fs::write(dir.join(name), "{}").unwrap();
        }

        let names: Vec<String> = list_backups_newest_first(&data_path, "mxu-MaaEnd.json")
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert_eq!(
            names,
            vec![
                "mxu-MaaEnd-20260103-120000.json",
                "mxu-MaaEnd-20260102-000000.json",
                "mxu-MaaEnd-20260101-000000.json",
            ]
        );

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    #[test]
    fn prune_keeps_only_the_newest_backups() {
        let data_path = make_temp_dir("prune");
        let dir = backup_dir(&data_path);
        std::fs::create_dir_all(&dir).unwrap();

        let total = BACKUP_KEEP_COUNT + 3;
        for day in 1..=total {
            std::fs::write(
                dir.join(format!("mxu-MaaEnd-202601{:02}-000000.json", day)),
                "{}",
            )
            .unwrap();
        }

        prune_backups(&data_path, "mxu-MaaEnd.json");

        let remaining = list_backups_newest_first(&data_path, "mxu-MaaEnd.json");
        assert_eq!(remaining.len(), BACKUP_KEEP_COUNT);
        assert_eq!(
            remaining[0].name,
            format!("mxu-MaaEnd-202601{:02}-000000.json", total)
        );

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    #[test]
    fn recovery_falls_back_to_older_backup_and_keeps_evidence() {
        let data_path = make_temp_dir("recover");
        let config_path = write_config_file(&data_path, &"\0".repeat(128));

        let dir = backup_dir(&data_path);
        std::fs::create_dir_all(&dir).unwrap();
        // 最新那份备份被同一次崩溃一起打成全零，必须能继续往前退
        std::fs::write(dir.join("mxu-MaaEnd-20260103-000000.json"), "\0".repeat(64)).unwrap();
        let good = sample_config_json();
        std::fs::write(dir.join("mxu-MaaEnd-20260102-000000.json"), &good).unwrap();

        let state = AppConfigState::default();
        let recovered = state
            .try_recover_config(&data_path, "mxu-MaaEnd.json", &config_path)
            .expect("应回退到更早的那份有效备份");

        assert_eq!(recovered["settings"]["theme"], "dark");
        // 磁盘上的配置也被真正恢复，随后读盘的前端能直接拿到好文件
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), good);

        let evidence_kept = std::fs::read_dir(data_path.join("config"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(evidence_kept, "损坏文件应被改名保留");

        assert!(matches!(
            state
                .recovery_notice
                .lock()
                .unwrap()
                .as_ref()
                .map(|n| n.kind),
            Some(ConfigRecoveryKind::Restored)
        ));

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    #[test]
    fn recovery_without_usable_backup_reports_reset() {
        let data_path = make_temp_dir("reset");
        let config_path = write_config_file(&data_path, &"\0".repeat(32));

        let state = AppConfigState::default();
        assert!(state
            .try_recover_config(&data_path, "mxu-MaaEnd.json", &config_path)
            .is_none());
        assert!(matches!(
            state
                .recovery_notice
                .lock()
                .unwrap()
                .as_ref()
                .map(|n| n.kind),
            Some(ConfigRecoveryKind::Reset)
        ));

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    #[test]
    fn rolling_backup_respects_daily_interval() {
        let data_path = make_temp_dir("rolling");
        let content = sample_config_json();
        let config_path = write_config_file(&data_path, &content);

        let dir = backup_dir(&data_path);
        std::fs::create_dir_all(&dir).unwrap();

        // 刚刚备份过，本次应直接跳过
        let just_now = Local::now().naive_local().format(BACKUP_TIMESTAMP_FORMAT);
        std::fs::write(dir.join(format!("mxu-MaaEnd-{}.json", just_now)), "{}").unwrap();

        AppConfigState::default().rolling_backup(&data_path, "mxu-MaaEnd.json", &config_path);
        assert_eq!(
            list_backups_newest_first(&data_path, "mxu-MaaEnd.json").len(),
            1
        );

        // 上一份备份已是两天前，应写入新备份
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let two_days_ago = (Local::now().naive_local() - chrono::Duration::days(2))
            .format(BACKUP_TIMESTAMP_FORMAT);
        std::fs::write(dir.join(format!("mxu-MaaEnd-{}.json", two_days_ago)), "{}").unwrap();

        AppConfigState::default().rolling_backup(&data_path, "mxu-MaaEnd.json", &config_path);
        let backups = list_backups_newest_first(&data_path, "mxu-MaaEnd.json");
        assert_eq!(backups.len(), 2);
        // 备份的是磁盘上的当前配置，而不是 "{}"
        assert_eq!(std::fs::read_to_string(&backups[0].path).unwrap(), content);

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    /// 覆盖启动时的完整自愈路径：磁盘上的损坏配置被换成备份内容，
    /// 内存里拿到的也是恢复后的配置，通知的序列化形状与前端类型一致。
    #[test]
    fn load_config_heals_corrupt_file_on_startup() {
        let data_path = make_temp_dir("startup-heal");
        // 与 issue #4710 的真实样本同形态：71578 字节全 0x00
        let config_path = write_config_file(&data_path, &"\0".repeat(71578));

        let dir = backup_dir(&data_path);
        std::fs::create_dir_all(&dir).unwrap();
        let good = sample_config_json();
        std::fs::write(dir.join("mxu-MaaEnd-20260801-120000.json"), &good).unwrap();

        let state = AppConfigState::default();
        // 真实启动顺序里 load_interface 先跑，project_name 已就位
        *state.project_name.lock().unwrap() = Some("MaaEnd".to_string());
        state.load_config(&data_path);

        assert_eq!(state.config.lock().unwrap()["settings"]["theme"], "dark");
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), good);

        let notice = state.recovery_notice.lock().unwrap().take().unwrap();
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"kind":"restored","backupTime":"2026-08-01 12:00"}"#
        );

        std::fs::remove_dir_all(&data_path).unwrap();
    }

    #[test]
    fn rolling_backup_skips_corrupt_current_config() {
        let data_path = make_temp_dir("rolling-corrupt");
        let config_path = write_config_file(&data_path, &"\0".repeat(256));

        AppConfigState::default().rolling_backup(&data_path, "mxu-MaaEnd.json", &config_path);

        assert!(
            list_backups_newest_first(&data_path, "mxu-MaaEnd.json").is_empty(),
            "损坏内容不应被灌进备份池"
        );

        std::fs::remove_dir_all(&data_path).unwrap();
    }
}
