//! 文件操作命令
//!
//! 提供本地文件读取和路径检查功能

use log::debug;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::utils::{get_app_data_dir, get_exe_directory, normalize_path};

/// 单个分卷 zip 的大小上限（字节）。
const MAX_VOLUME_BYTES: u64 = 24_500_000;
/// EOCD 记录（zip 末尾）固定大小。
const ZIP_EOCD_BYTES: u64 = 22;
/// 中央目录每条记录的固定字段大小（不含文件名）。
const ZIP_CENTRAL_DIR_FIXED_BYTES: u64 = 46;
/// 保留最近 N 次导出（含本次），多余的会在每次导出完成后清理。
const MAX_EXPORTS_TO_KEEP: usize = 10;
/// 需要随日志一起清空的调试产物子目录（内容由 MaaFW 的 save_on_error / save_draw 写入）。
const DEBUG_ARTIFACT_DIRS: [&str; 2] = ["on_error", "vision"];
/// 日志目录名（位于应用数据目录下）。
const DEBUG_DIR: &str = "debug";
/// 日志导出产物目录名，与 `debug/` 同级，避免下次导出把上次的产物扫进去。
const DEBUG_EXPORTS_DIR: &str = "debug_exports";
/// tauri-plugin-log 从进程启动起一直握着这个文件（见 `lib.rs` 的 `file_name: mxu-tauri`）。
/// Windows 上删除已打开文件只会摘掉目录项，后续写入进已删除句柄，导出就看不到启动日志。
const ACTIVE_TAURI_LOG_FILE: &str = "mxu-tauri.log";

#[derive(Clone)]
struct ExportEntry {
    source_path: PathBuf,
    archive_name: String,
}

/// 包装真实 writer，统计已写字节数，用于在写入分卷过程中实时查询当前卷大小。
struct CountingWriter<W: Write + Seek> {
    inner: W,
    counter: Arc<AtomicU64>,
}

impl<W: Write + Seek> CountingWriter<W> {
    fn new(inner: W) -> (Self, Arc<AtomicU64>) {
        let counter = Arc::new(AtomicU64::new(0));
        (
            Self {
                inner,
                counter: counter.clone(),
            },
            counter,
        )
    }
}

impl<W: Write + Seek> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.counter.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write + Seek> Seek for CountingWriter<W> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        // counter 是已写字节的**上界**：zip crate 会 seek 回去重写 local header（CRC、
        // 压缩前后大小），重写的字节被 write() 重复计入；写入失败留下的占位 header
        // 也已经进了 counter。上界对分卷预算判断是安全的（只会更早切卷）。
        self.inner.seek(pos)
    }
}

fn add_file_to_zip<W>(
    zip: &mut zip::ZipWriter<W>,
    path: &Path,
    archive_name: &str,
    options: zip::write::SimpleFileOptions,
) -> bool
where
    W: Write + Seek,
{
    use std::fs::File;

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("无法打开文件 {:?}: {}", path, e);
            return false;
        }
    };

    if let Err(e) = zip.start_file(archive_name, options) {
        log::warn!("创建 zip 条目失败 {}: {}", archive_name, e);
        return false;
    }

    let text_file = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            [
                "log", "txt", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv",
            ]
            .contains(&ext.to_ascii_lowercase().as_str())
        });
    if text_file {
        use std::io::BufRead;
        let mut reader = std::io::BufReader::new(file);
        let mut line = Vec::new();
        loop {
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => return false,
            }
            if zip
                .write_all(super::log_secrets::redact(&String::from_utf8_lossy(&line)).as_bytes())
                .is_err()
            {
                return false;
            }
            line.clear();
        }
        return true;
    }

    if let Err(e) = io::copy(&mut file, zip) {
        log::warn!("写入 zip 失败 {}: {}", archive_name, e);
        return false;
    }

    true
}

/// zip 每条目的 local header 固定开销（30）+ DEFLATE 帧头 + 余量。
/// 文件名部分在 local header 和中央目录各出现一次：
/// - local header 侧：包含在此常量余量内（本应用文件名短，够用）
/// - 中央目录侧：由 `entry_cd_bytes`（ZIP_CENTRAL_DIR_FIXED_BYTES + 文件名长度）计入
const ZIP_LOCAL_HEADER_OVERHEAD: u64 = 64;

/// 按扩展名估算压缩后**数据**大小的保守上界。
///
/// 注意：仅估计压缩数据，不含 zip local header / 中央目录等开销，调用侧自行加。
fn estimate_compressed_upper_bound(path: &Path, file_size: u64) -> u64 {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "dmp" => file_size, // 已压缩或二进制，DEFLATE 无效
        "log" | "json" | "txt" | "toml" | "yaml" | "yml" | "xml" | "csv" => {
            file_size.saturating_div(4) // 实测 10-25x，4x 留有足够余量
        }
        _ => file_size, // 未知类型，不假设压缩
    }
}

/// 用 flate2 预压缩文件到内存，返回 deflate 后字节数——与 zip crate 内部压缩同算法。
///
/// 只在保守估算触线时才调用（每卷最多一次），避免每个文件都压两遍。
fn pre_compress_measure(path: &Path) -> io::Result<u64> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;

    let mut src = std::fs::File::open(path)?;
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    std::io::copy(&mut src, &mut encoder)?;
    let compressed = encoder.finish()?;
    Ok(compressed.len() as u64)
}

fn normalize_archive_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 按原生路径组件保留层级，避免 Unix 的字面反斜杠与真实子目录重名。
/// 转义符自身也编码，非 UTF-8 名称按原始编码字节保留，避免有损转换漏图。
fn encode_image_archive_path(path: &Path) -> Option<String> {
    let mut components = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            return None;
        };
        let encoded = match name.to_str() {
            Some(name) => name
                .replace('%', "%25")
                .replace('\\', "%5C")
                .replace(':', "%3A"),
            None => urlencoding::encode_binary(name.as_encoded_bytes()).into_owned(),
        };
        components.push(encoded);
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn collect_files_recursively(dir: &Path, archive_prefix: &str) -> Result<Vec<ExportEntry>, String> {
    if !std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.is_dir()) {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let entries = std::fs::read_dir(&current_dir)
            .map_err(|e| format!("读取目录失败 [{}]: {}", current_dir.display(), e))?;

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            // 不跟随符号链接，避免导出数据目录以外的文件或陷入目录环。
            if !file_type.is_file() {
                continue;
            }

            let relative_path = match path.strip_prefix(dir) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            let archive_name = if archive_prefix.is_empty() {
                normalize_archive_path(relative_path)
            } else {
                format!(
                    "{}/{}",
                    archive_prefix.trim_end_matches('/'),
                    normalize_archive_path(relative_path)
                )
            };

            files.push(ExportEntry {
                source_path: path,
                archive_name,
            });
        }
    }

    files.sort_by(|a, b| a.archive_name.cmp(&b.archive_name));
    Ok(files)
}

fn is_image_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    path.extension()
        .map(|ext| {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            ext_lower == "png" || ext_lower == "jpg" || ext_lower == "jpeg"
        })
        .unwrap_or(false)
}

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .map(|ext| {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            extensions.iter().any(|e| ext_lower == *e)
        })
        .unwrap_or(false)
}

/// 收集 debug 目录下各子文件夹内以指定后缀结尾的文件（递归）
/// 压缩包内路径保留子文件夹层级，例如 on_error/xxx.json
fn collect_debug_subdir_files(
    debug_dir: &Path,
    extensions: &[&str],
) -> Result<Vec<ExportEntry>, String> {
    let entries = std::fs::read_dir(debug_dir)
        .map_err(|e| format!("读取日志目录失败 [{}]: {}", debug_dir.display(), e))?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }
        let Some(dir_name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };

        for export in collect_files_recursively(&path, &dir_name)? {
            if has_extension(&export.source_path, extensions) {
                files.push(export);
            }
        }
    }

    files.sort_by(|a, b| a.archive_name.cmp(&b.archive_name));
    Ok(files)
}

pub fn resolve_local_file_path(filename: &str) -> Result<PathBuf, String> {
    let exe_dir = get_exe_directory()?;
    let file_path = normalize_path(&exe_dir.join(filename).to_string_lossy());
    // 防止路径穿越，确保仍在 exe 目录下
    if !file_path.starts_with(&exe_dir) {
        return Err(format!("非法文件路径: {}", filename));
    }
    Ok(file_path)
}

/// 读取 exe 同目录下的文本文件
#[tauri::command]
pub fn read_local_file(filename: String) -> Result<String, String> {
    let file_path = resolve_local_file_path(&filename)?;
    debug!("Reading local file: {:?}", file_path);

    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("读取文件失败 [{}]: {}", file_path.display(), e))
}

/// 读取 exe 同目录下的二进制文件，返回 base64 编码
#[tauri::command]
pub fn read_local_file_base64(filename: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let file_path = resolve_local_file_path(&filename)?;
    debug!("Reading local file (base64): {:?}", file_path);

    let data = std::fs::read(&file_path)
        .map_err(|e| format!("读取文件失败 [{}]: {}", file_path.display(), e))?;

    Ok(STANDARD.encode(&data))
}

/// 检查 exe 同目录下的文件是否存在
#[tauri::command]
pub fn local_file_exists(filename: String) -> Result<bool, String> {
    let file_path = resolve_local_file_path(&filename)?;
    Ok(file_path.exists())
}

/// 获取 exe 所在目录路径
#[tauri::command]
pub fn get_exe_dir() -> Result<String, String> {
    let exe_dir = get_exe_directory()?;
    Ok(exe_dir.to_string_lossy().to_string())
}

/// 获取应用数据目录路径
/// - macOS: ~/Library/Application Support/MXU/
/// - Windows/Linux: exe 所在目录
#[tauri::command]
pub fn get_data_dir() -> Result<String, String> {
    let data_dir = get_app_data_dir()?;
    Ok(data_dir.to_string_lossy().to_string())
}

/// 清空目录内容，保留目录本身。返回成功删除的条目数（子目录整体计 1 条）。
///
/// 保留根目录只是为了不改动既有目录结构；MaaFW 写调试产物前会自建父目录，缺失也不会写入失败。
fn clear_dir_contents(dir: &Path) -> u64 {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::debug!("Failed to read debug dir [{}]: {}", dir.display(), e);
            return 0;
        }
    };

    let mut deleted = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };

        match result {
            Ok(()) => deleted = deleted.saturating_add(1),
            Err(e) => log::debug!("Failed to delete debug entry [{}]: {}", path.display(), e),
        }
    }

    deleted
}

/// 递归删除 `dir` 及其所有子目录下的 .log 文件，返回删除数量。
/// `exclude_file_name` 匹配的文件名会被跳过（当前会话正在写入的前端日志）。
/// 活动文件 `mxu-tauri.log` 同样跳过：日志插件全程握着它，删掉后写入会进已删除句柄。
/// 已关闭的轮转文件 `mxu-tauri_*.log` 仍删除。只删文件不回收空目录，避免改动既有目录结构。
fn remove_log_files_recursively(dir: &Path, exclude_file_name: Option<&str>) -> u64 {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::debug!("Failed to read log dir [{}]: {}", dir.display(), e);
            return 0;
        }
    };

    let mut deleted = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();

        if path.is_dir() {
            deleted =
                deleted.saturating_add(remove_log_files_recursively(&path, exclude_file_name));
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if !name.ends_with(".log")
            || exclude_file_name == Some(name)
            || name == ACTIVE_TAURI_LOG_FILE
        {
            continue;
        }

        match std::fs::remove_file(&path) {
            Ok(()) => deleted = deleted.saturating_add(1),
            Err(e) => log::debug!("Failed to delete log file [{}]: {}", path.display(), e),
        }
    }

    deleted
}

/// `clear_log_files` 的可测核心，接收具体目录而不依赖应用数据目录。
fn clear_log_dirs(debug_dir: &Path, exports_dir: &Path, exclude_file_name: Option<&str>) -> u64 {
    let mut deleted = remove_log_files_recursively(debug_dir, exclude_file_name);

    for dir_name in DEBUG_ARTIFACT_DIRS {
        let artifact_dir = debug_dir.join(dir_name);
        if !artifact_dir.is_dir() {
            continue;
        }
        deleted = deleted.saturating_add(clear_dir_contents(&artifact_dir));
    }

    if exports_dir.is_dir() {
        deleted = deleted.saturating_add(clear_dir_contents(exports_dir));
    }

    deleted
}

/// 递归删除 debug 目录（含所有子目录）中的 .log 文件，清空 on_error/、vision/ 内的调试产物
/// 以及 debug_exports/ 下的日志导出产物（保留这几个目录本身）。
/// 可选择排除一个当前正在使用的前端日志文件。活动文件 `mxu-tauri.log` 始终保留。
/// 返回删除的文件与产物总数。
#[tauri::command]
pub fn clear_log_files(exclude_file_name: Option<String>) -> Result<u64, String> {
    let data_dir = get_app_data_dir()?;

    Ok(clear_log_dirs(
        &data_dir.join(DEBUG_DIR),
        &data_dir.join(DEBUG_EXPORTS_DIR),
        exclude_file_name.as_deref(),
    ))
}

/// 获取当前工作目录
#[tauri::command]
pub fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get current directory: {}", e))
}

/// 检查 exe 路径是否存在问题
/// 返回: None 表示正常, Some("root") 表示在磁盘根目录, Some("temp") 表示在临时目录
#[tauri::command]
pub fn check_exe_path() -> Option<String> {
    let exe_dir = match get_exe_directory() {
        Ok(dir) => dir,
        Err(_) => return None,
    };

    let path_str = exe_dir.to_string_lossy().to_lowercase();

    // 检查是否在磁盘根目录（如 C:\, D:\ 等）
    // Windows 根目录特征：路径只有盘符和反斜杠，如 "c:\" 或 "d:\"
    if exe_dir.parent().is_none() || exe_dir.parent() == Some(std::path::Path::new("")) {
        return Some("root".to_string());
    }

    // Windows 下额外检查：盘符根目录（如 C:\）
    #[cfg(target_os = "windows")]
    {
        let components: Vec<_> = exe_dir.components().collect();
        // 根目录只有一个组件（盘符前缀）
        if components.len() == 1 {
            return Some("root".to_string());
        }
    }

    // 检查是否在临时目录
    // 常见的临时目录特征
    let temp_indicators = [
        "\\temp\\",
        "/temp/",
        "\\tmp\\",
        "/tmp/",
        "\\appdata\\local\\temp",
        "/appdata/local/temp",
        // Windows 压缩包临时解压目录
        "\\temporary internet files\\",
        // 7-Zip 临时目录
        "\\7zocab",
        "\\7zo",
        // WinRAR 临时目录
        "\\rar$",
        // WinZip 临时目录
        "\\wz",
        // 360压缩临时目录
        "\\360zip$",
        "\\360zip_tmp",
        "\\360xtract",
        // 2345好压临时目录
        "\\2345zip",
        "\\haozip$",
        // 快压临时目录
        "\\kuaizip$",
        // Bandizip 临时目录
        "\\bztmp",
        "\\bandizip$",
        // 百度网盘下载临时目录
        "\\baiduyundownload",
        "\\baidupcs",
        // 迅雷下载临时目录
        "\\thundernetwork",
        "\\xunlei\\downloads\\.tmp",
        // QQ/微信 文件临时目录
        "\\tencent\\qq\\temp",
        "\\tencent files\\",
        "\\weixin files\\",
        // 通用临时目录特征
        "\\temp_",
        "\\.tmp\\",
    ];

    for indicator in &temp_indicators {
        if path_str.contains(indicator) {
            return Some("temp".to_string());
        }
    }

    // 检查系统临时目录
    if let Ok(temp_dir) = std::env::var("TEMP") {
        let temp_lower = temp_dir.to_lowercase();
        if path_str.starts_with(&temp_lower) {
            return Some("temp".to_string());
        }
    }
    if let Ok(tmp_dir) = std::env::var("TMP") {
        let tmp_lower = tmp_dir.to_lowercase();
        if path_str.starts_with(&tmp_lower) {
            return Some("temp".to_string());
        }
    }

    None
}

/// 为文件设置可执行权限（仅 Unix 系统）
/// Windows 上此命令不做任何操作
#[tauri::command]
pub fn set_executable(file_path: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&file_path)
            .map_err(|e| format!("无法获取文件元数据 [{}]: {}", file_path, e))?;
        let mut permissions = metadata.permissions();
        // 添加可执行权限 (owner, group, others)
        let mode = permissions.mode() | 0o111;
        permissions.set_mode(mode);
        std::fs::set_permissions(&file_path, permissions)
            .map_err(|e| format!("无法设置执行权限 [{}]: {}", file_path, e))?;
        log::info!("Set executable permission: {}", file_path);
    }
    #[cfg(not(unix))]
    {
        let _ = file_path; // 避免未使用警告
    }
    Ok(())
}

/// 从指定目录收集图片，按 mtime 从新到旧排序。不做任何数量或大小截断。
/// Screencap 可指定子目录，因此可选择递归收集；不跟随符号链接。
fn collect_debug_images(dir: &Path, archive_prefix: &str, recursive: bool) -> Vec<ExportEntry> {
    if !std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.is_dir()) {
        return Vec::new();
    }

    let mut images = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current_dir) = stack.pop() {
        let rd = match std::fs::read_dir(&current_dir) {
            Ok(rd) => rd,
            Err(e) => {
                log::warn!(
                    "读取 {} 目录失败 [{}]: {}",
                    archive_prefix,
                    current_dir.display(),
                    e
                );
                continue;
            }
        };

        for entry in rd.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() && recursive {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_image_file(&path) {
                continue;
            }
            let Ok(relative_path) = path.strip_prefix(dir) else {
                continue;
            };
            let Some(relative_name) = encode_image_archive_path(relative_path) else {
                continue;
            };
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            images.push((
                ExportEntry {
                    source_path: path,
                    archive_name: format!("{}/{}", archive_prefix, relative_name),
                },
                modified,
            ));
        }
    }

    images.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.archive_name.cmp(&b.0.archive_name))
    });
    images.into_iter().map(|(entry, _)| entry).collect()
}

/// 导出日志文件为分卷 zip 压缩包目录
/// 返回 part01.zip 路径（其同级目录下还有后续分卷）
///
/// 注：`vision/` 是否有内容由 `maa_set_save_draw` 控制；导出时只要 `vision/`
/// 下有文件就一并打包，因此本命令不接收 save_draw 参数。
#[tauri::command]
pub async fn export_logs(
    project_name: Option<String>,
    project_version: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || export_logs_blocking(project_name, project_version))
        .await
        .map_err(|e| format!("导出任务执行失败: {}", e))?
}

fn export_logs_blocking(
    project_name: Option<String>,
    project_version: Option<String>,
) -> Result<String, String> {
    // 日志在数据目录下（macOS: ~/Library/Application Support/MXU/debug）
    export_logs_from_dir(&get_app_data_dir()?, project_name, project_version)
}

fn export_logs_from_dir(
    data_dir: &Path,
    project_name: Option<String>,
    project_version: Option<String>,
) -> Result<String, String> {
    use std::fs::File;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let debug_dir = data_dir.join(DEBUG_DIR);

    if !debug_dir.exists() {
        return Err("日志目录不存在".to_string());
    }

    let now = chrono::Local::now();
    let date_str = now.format("%Y%m%d-%H%M%S");
    let name = project_name.unwrap_or_else(|| "mxu".to_string());
    let version = project_version.unwrap_or_default();
    let dir_name = if version.is_empty() {
        format!("{}-logs-{}", name, date_str)
    } else {
        format!("{}-logs-{}-{}", name, version, date_str)
    };
    // 产物放在 debug_exports/ 下而不是 debug/，避免下次导出把上次的产物扫进去。
    let exports_root = data_dir.join(DEBUG_EXPORTS_DIR);
    let out_dir = exports_root.join(&dir_name);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("创建导出目录失败 [{}]: {}", out_dir.display(), e))?;

    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // ─── 1. 收集常规文件（log / dmp / config / 子目录下的 log/json/dmp） ───
    let mut regular_entries: Vec<ExportEntry> = Vec::new();

    let entries = std::fs::read_dir(&debug_dir).map_err(|e| format!("读取日志目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|file_type| file_type.is_file()) {
            continue;
        }
        if !has_extension(&path, &["log", "dmp"]) {
            continue;
        }
        let Some(archive_name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        regular_entries.push(ExportEntry {
            source_path: path,
            archive_name,
        });
    }
    regular_entries.sort_by(|a, b| a.archive_name.cmp(&b.archive_name));

    let config_dir = data_dir.join("config");
    regular_entries.extend(collect_files_recursively(&config_dir, "config")?);
    regular_entries.extend(collect_debug_subdir_files(
        &debug_dir,
        &["log", "json", "dmp"],
    )?);

    // ─── 2. 收集图片（on_error + vision + screencap，各组按 mtime 新→旧） ───
    let on_error_images = collect_debug_images(&debug_dir.join("on_error"), "on_error", false);
    let vision_images = collect_debug_images(&debug_dir.join("vision"), "vision", false);
    let screencap_images = collect_debug_images(&debug_dir.join("screencap"), "screencap", true);

    // ─── 3. 合并入卷条目：先 regular，再 on_error，再 vision，最后 screencap ───
    // 保持既有日志、崩溃图和绘制图的优先级；截图也进入同一分卷流程。
    let mut all_entries: Vec<ExportEntry> = Vec::new();
    all_entries.extend(regular_entries);
    all_entries.extend(on_error_images);
    all_entries.extend(vision_images);
    all_entries.extend(screencap_images);

    let total_entries = all_entries.len();
    if total_entries == 0 {
        return Err("没有可导出的日志文件".to_string());
    }

    // ─── 4. 分卷打包 ───
    // 卷数硬上界 = 总条目数（每文件独占一卷的退化情形）；据此选零填充宽度。
    let width = if total_entries >= 100 { 3 } else { 2 };

    let mut volume_idx: usize = 1;
    let mut iter = all_entries.into_iter().peekable();
    let mut total_files_written: usize = 0;
    let mut first_volume_path: Option<PathBuf> = None;

    while iter.peek().is_some() {
        let volume_path = out_dir.join(format!(
            "{}-part{:0width$}.zip",
            dir_name,
            volume_idx,
            width = width
        ));
        let file = File::create(&volume_path)
            .map_err(|e| format!("创建分卷文件失败 [{}]: {}", volume_path.display(), e))?;
        // 64 KB 缓冲：deflate 输出的 chunk 经常几十到几百 KB，默认 8 KB 太小。
        let (counting, counter) = CountingWriter::new(BufWriter::with_capacity(64 * 1024, file));
        let mut zip = ZipWriter::new(counting);
        let mut wrote_any = false;
        let mut volume_file_count: usize = 0;
        // 预留 finish() 时要写入的 EOCD + 累计的中央目录字节，避免卷写超。
        let mut central_dir_reserve: u64 = ZIP_EOCD_BYTES;

        while let Some(entry) = iter.peek() {
            let entry_cd_bytes = ZIP_CENTRAL_DIR_FIXED_BYTES + entry.archive_name.len() as u64;
            let file_size = entry
                .source_path
                .metadata()
                .ok()
                .map(|m| m.len())
                .unwrap_or(u64::MAX); // metadata 失败用极大值，保守触发预压缩

            // 两阶段容量检查：先用保守估算快速通过大多数文件，
            // 估算触线时才实际预压缩一次拿精确值，避免每个文件都压两遍。
            let est_delta = estimate_compressed_upper_bound(&entry.source_path, file_size)
                .saturating_add(ZIP_LOCAL_HEADER_OVERHEAD);
            let current_total = counter
                .load(Ordering::Relaxed)
                .saturating_add(central_dir_reserve);
            if wrote_any
                && current_total
                    .saturating_add(est_delta)
                    .saturating_add(entry_cd_bytes)
                    > MAX_VOLUME_BYTES
            {
                match pre_compress_measure(&entry.source_path) {
                    Ok(exact_delta) => {
                        let exact_delta = exact_delta.saturating_add(ZIP_LOCAL_HEADER_OVERHEAD);
                        if current_total
                            .saturating_add(exact_delta)
                            .saturating_add(entry_cd_bytes)
                            > MAX_VOLUME_BYTES
                        {
                            break;
                        }
                    }
                    Err(_) => {
                        // IO 错误打不开文件，保守切卷
                        break;
                    }
                }
            }

            let entry = iter.next().expect("peek 已确认存在");
            if add_file_to_zip(&mut zip, &entry.source_path, &entry.archive_name, options) {
                central_dir_reserve = central_dir_reserve.saturating_add(entry_cd_bytes);
                wrote_any = true;
                volume_file_count += 1;
                total_files_written += 1;
            }
        }

        zip.finish()
            .map_err(|e| format!("完成分卷压缩失败 [{}]: {}", volume_path.display(), e))?;

        if let Ok(metadata) = std::fs::metadata(&volume_path) {
            log::info!(
                "分卷 {} 完成：{} 个文件，{} bytes",
                volume_path.display(),
                volume_file_count,
                metadata.len()
            );
        }

        if first_volume_path.is_none() {
            first_volume_path = Some(volume_path);
        }
        volume_idx += 1;
    }

    log::info!(
        "日志导出完成：{} 个文件分为 {} 个分卷，输出目录 {}",
        total_files_written,
        volume_idx - 1,
        out_dir.display()
    );

    // 只保留最近 MAX_EXPORTS_TO_KEEP 次导出。清理失败仅 warn，不影响本次结果。
    prune_old_exports(&exports_root, &out_dir);

    // 返回 part01.zip 路径，让前端 revealItemInDir 选中第一个分卷.
    // total_entries == 0 已早返，所以循环至少跑过一次。
    let reveal_target = first_volume_path.expect("至少应有一个分卷写入成功");
    Ok(reveal_target.to_string_lossy().to_string())
}

/// 扫描 `exports_root` 下子目录，按目录名里的时间戳新→旧排序，
/// 删除超出 `MAX_EXPORTS_TO_KEEP` 的旧目录。`current_export` 始终保留。
///
/// 用目录名解时间戳而不是 mtime：Windows 上目录 mtime 不稳定，
/// 且备份/同步工具可能改写。
fn prune_old_exports(exports_root: &Path, current_export: &Path) {
    let rd = match std::fs::read_dir(exports_root) {
        Ok(rd) => rd,
        Err(e) => {
            log::warn!(
                "枚举导出目录失败 [{}]: {}，跳过旧导出清理",
                exports_root.display(),
                e
            );
            return;
        }
    };

    // 解不出时间戳的子目录直接跳过（既不删也不算名额）。
    let mut dirs: Vec<(PathBuf, String)> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| e.path() != current_export)
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            let ts = parse_export_timestamp(&name)?;
            Some((path, ts))
        })
        .collect();

    // 本次产物始终保留，所以历史最多留 MAX_EXPORTS_TO_KEEP - 1 个
    let keep_others = MAX_EXPORTS_TO_KEEP - 1;
    if dirs.len() <= keep_others {
        return;
    }

    // 时间戳字符串的字典序就是时间序
    dirs.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in dirs.into_iter().skip(keep_others) {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => log::info!("已清理旧导出: {}", path.display()),
            Err(e) => log::warn!("清理旧导出失败 [{}]: {}", path.display(), e),
        }
    }
}

/// 从导出目录名末尾解出 `YYYYMMDD-HHMMSS` 时间戳作为排序键。
fn parse_export_timestamp(dir_name: &str) -> Option<String> {
    const TS_LEN: usize = 15;
    // 在字节层面取末尾，避免 dir_name 含非 ASCII 时被切到 UTF-8 码点中间 panic
    let bytes = dir_name.as_bytes();
    if bytes.len() < TS_LEN {
        return None;
    }
    let tail = &bytes[bytes.len() - TS_LEN..];
    let shape_ok = tail[..8].iter().all(|b| b.is_ascii_digit())
        && tail[8] == b'-'
        && tail[9..].iter().all(|b| b.is_ascii_digit());
    if !shape_ok {
        return None;
    }
    // 形状校验通过 ⇒ 全是 ASCII，from_utf8 必然成功
    Some(std::str::from_utf8(tail).ok()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mxu-screencap-export-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            path
        }

        fn export(&self) -> PathBuf {
            PathBuf::from(
                export_logs_from_dir(&self.0, Some("test".into()), Some("1.0".into())).unwrap(),
            )
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read_export(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|index| {
                let mut entry = archive.by_index(index).unwrap();
                assert!(entry.enclosed_name().is_some());
                assert!(!entry.name().contains('\\'));
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (entry.name().to_string(), bytes)
            })
            .collect()
    }

    fn set_modified(path: &Path, seconds: u64) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    /// 使用确定性伪随机数据模拟无法再次压缩的图片，无需外部资源或随机数依赖。
    fn write_incompressible_image(path: &Path, size: u64) {
        let mut writer = BufWriter::new(std::fs::File::create(path).unwrap());
        let mut state = 0x1234_5678_9abc_def0_u64;
        let mut remaining = size;
        let mut buffer = [0_u8; 64 * 1024];
        while remaining > 0 {
            for chunk in buffer.chunks_exact_mut(8) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                chunk.copy_from_slice(&state.to_le_bytes());
            }
            let len = remaining.min(buffer.len() as u64) as usize;
            writer.write_all(&buffer[..len]).unwrap();
            remaining -= len as u64;
        }
        writer.flush().unwrap();
    }

    #[test]
    fn missing_screencap_directory_does_not_prevent_log_export() {
        let root = TestDir::new();
        assert_eq!(
            export_logs_from_dir(&root.0, None, None).unwrap_err(),
            "日志目录不存在"
        );
        root.write("debug/maafw.log", b"log contents");
        assert!(
            collect_debug_images(&root.0.join("debug/screencap"), "screencap", true).is_empty()
        );
        assert_eq!(
            read_export(&root.export()),
            vec![("maafw.log".into(), b"log contents".to_vec())]
        );
        // 同名普通文件也不是截图目录。
        root.write("debug/screencap", b"not a directory");
        assert!(
            collect_debug_images(&root.0.join("debug/screencap"), "screencap", true).is_empty()
        );
    }

    #[test]
    fn screenshot_only_export_preserves_nested_paths_types_and_newest_first_order() {
        let root = TestDir::new();
        let oldest = root.write("debug/screencap/old.png", &[0, 255, 1]);
        let middle = root.write("debug/screencap/task/middle.JpG", &[2, 254, 3]);
        let newest = root.write("debug/screencap/task/子目录/new.PNG", &[4, 253, 5]);
        let jpeg = root.write("debug/screencap/other.jpeg", &[6, 252, 7]);
        set_modified(&oldest, 1);
        set_modified(&middle, 2);
        set_modified(&newest, 4);
        set_modified(&jpeg, 3);
        root.write("debug/screencap/private.txt", b"not an image");
        root.write(
            "debug/screencap/fake.png/readme.txt",
            b"directory, not an image",
        );
        root.write("debug/private.png", b"outside the image allowlist");
        root.write("debug/other/private.png", b"outside the image allowlist");
        root.write("debug_exports/previous.zip", b"previous export");

        let first_volume = root.export();
        assert_eq!(
            first_volume.parent().unwrap().parent().unwrap(),
            root.0.join(DEBUG_EXPORTS_DIR)
        );
        assert_eq!(
            read_export(&first_volume),
            vec![
                ("screencap/task/子目录/new.PNG".into(), vec![4, 253, 5]),
                ("screencap/other.jpeg".into(), vec![6, 252, 7]),
                ("screencap/task/middle.JpG".into(), vec![2, 254, 3]),
                ("screencap/old.png".into(), vec![0, 255, 1]),
            ]
        );
    }

    #[test]
    fn screenshots_follow_existing_logs_and_images_without_bypassing_redaction() {
        let root = TestDir::new();
        let secret = "unique-screencap-export-secret".to_string();
        super::super::log_secrets::register(&[secret.clone()]);
        root.write(
            "debug/maafw.log",
            format!("password={secret}\r\n").as_bytes(),
        );
        root.write(
            "config/settings.json",
            format!("{{\"token\":\"{secret}\"}}").as_bytes(),
        );
        root.write(
            "debug/screencap/task/details.json",
            format!("\"{secret}\"").as_bytes(),
        );
        root.write("debug/on_error/error.png", b"error image");
        root.write("debug/vision/draw.jpg", b"draw image");
        root.write("debug/screencap/capture.png", b"screenshot");

        assert_eq!(
            read_export(&root.export()),
            vec![
                ("maafw.log".into(), b"password=******\r\n".to_vec()),
                (
                    "config/settings.json".into(),
                    b"{\"token\":\"******\"}".to_vec()
                ),
                ("screencap/task/details.json".into(), b"\"******\"".to_vec()),
                ("on_error/error.png".into(), b"error image".to_vec()),
                ("vision/draw.jpg".into(), b"draw image".to_vec()),
                ("screencap/capture.png".into(), b"screenshot".to_vec()),
            ]
        );
    }

    #[test]
    fn screenshots_are_not_truncated_and_keep_existing_volume_numbering() {
        let root = TestDir::new();
        for index in 0..101 {
            root.write(&format!("debug/screencap/{index:03}.png"), b"image");
        }
        let first_volume = root.export();
        assert!(first_volume
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .ends_with("-part001.zip"));
        let entries = read_export(&first_volume);
        assert_eq!(entries.len(), 101);
        assert!(entries.iter().all(|(_, bytes)| bytes == b"image"));
    }

    #[test]
    fn screenshots_share_existing_volume_size_budget() {
        let root = TestDir::new();
        let first = root.write("debug/screencap/new.png", b"");
        let second = root.write("debug/screencap/old.png", b"");
        write_incompressible_image(&first, 13_000_000);
        write_incompressible_image(&second, 13_000_000);
        set_modified(&first, 2);
        set_modified(&second, 1);
        root.write("debug/maafw.log", b"log");

        let first_volume = root.export();
        let mut volumes: Vec<_> = std::fs::read_dir(first_volume.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        volumes.sort();
        assert_eq!(volumes.len(), 2);
        assert_eq!(volumes[0], first_volume);
        for (index, volume) in volumes.iter().enumerate() {
            assert!(volume.metadata().unwrap().len() <= MAX_VOLUME_BYTES);
            assert!(volume
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .ends_with(&format!("-part{:02}.zip", index + 1)));
            let mut entries = read_export(volume);
            if index == 0 {
                assert_eq!(entries.remove(0), ("maafw.log".into(), b"log".to_vec()));
            }
            let source = if index == 0 { &first } else { &second };
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].1, std::fs::read(source).unwrap());
        }
    }

    #[test]
    fn single_oversized_screenshot_keeps_existing_dedicated_volume_behavior() {
        let root = TestDir::new();
        let large = root.write("debug/screencap/large.png", b"");
        write_incompressible_image(&large, MAX_VOLUME_BYTES + 100_000);
        let small = root.write("debug/screencap/small.jpg", b"small image");
        set_modified(&large, 2);
        set_modified(&small, 1);

        let first_volume = root.export();
        let first_entries = read_export(&first_volume);
        assert_eq!(first_entries.len(), 1);
        assert_eq!(first_entries[0].0, "screencap/large.png");
        assert_eq!(first_entries[0].1, std::fs::read(&large).unwrap());
        // 现有规则不截断单个超大文件，单独一卷可超过常规卷预算。
        assert!(first_volume.metadata().unwrap().len() > MAX_VOLUME_BYTES);
        let volumes: Vec<_> = std::fs::read_dir(first_volume.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(volumes.len(), 2);
        let second_volume = volumes.iter().find(|path| **path != first_volume).unwrap();
        assert_eq!(
            read_export(second_volume),
            vec![("screencap/small.jpg".into(), b"small image".to_vec())]
        );
    }

    #[test]
    fn screenshot_export_preserves_retention_and_log_cleanup_scope() {
        let root = TestDir::new();
        root.write("debug/screencap/capture.png", b"keep screenshot");
        root.write(
            "debug/screencap/nested/capture.jpg",
            b"keep nested screenshot",
        );
        root.write("debug/maafw.log", b"remove log");
        root.write("debug/on_error/error.png", b"remove error image");
        root.write("debug/vision/draw.png", b"remove draw image");
        for index in 1..=12 {
            root.write(
                &format!("debug_exports/old-logs-202001{index:02}-000000/old.zip"),
                b"old export",
            );
        }
        root.write(
            "debug_exports/unrelated/keep.txt",
            b"unrecognized directory",
        );
        let current_export = root.export();
        let exports_dir = root.0.join(DEBUG_EXPORTS_DIR);
        let recognized_count = std::fs::read_dir(&exports_dir)
            .unwrap()
            .flatten()
            .filter(|entry| parse_export_timestamp(&entry.file_name().to_string_lossy()).is_some())
            .count();
        assert_eq!(recognized_count, MAX_EXPORTS_TO_KEEP);
        assert!(current_export.exists());
        assert!(!exports_dir.join("old-logs-20200103-000000").exists());
        assert!(exports_dir.join("old-logs-20200104-000000").exists());
        assert!(exports_dir.join("unrelated/keep.txt").exists());

        clear_log_dirs(&root.0.join(DEBUG_DIR), &exports_dir, None);
        assert_eq!(
            std::fs::read(root.0.join("debug/screencap/capture.png")).unwrap(),
            b"keep screenshot"
        );
        assert!(root.0.join("debug/screencap/nested/capture.jpg").exists());
        assert!(!root.0.join("debug/maafw.log").exists());
        assert!(!root.0.join("debug/on_error/error.png").exists());
        assert!(!root.0.join("debug/vision/draw.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_export_skips_links_and_special_files_and_encodes_unsafe_names() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let root = TestDir::new();
        let outside = TestDir::new();
        outside.write("secret.png", b"private image");
        outside.write("secret.json", b"private settings");
        root.write("debug/screencap/ok.png", b"ok");
        let screencap = root.0.join("debug/screencap");
        symlink(outside.0.join("secret.png"), screencap.join("linked.png")).unwrap();
        symlink(&outside.0, screencap.join("linked-dir")).unwrap();
        symlink(&screencap, screencap.join("loop")).unwrap();
        symlink(outside.0.join("missing.png"), screencap.join("broken.png")).unwrap();
        symlink(&outside.0, root.0.join("config")).unwrap();
        symlink(
            outside.0.join("secret.json"),
            root.0.join("debug/linked.log"),
        )
        .unwrap();
        root.write("debug/screencap/..\\..\\escape.png", b"unsafe archive path");
        let _socket = UnixListener::bind(screencap.join("socket.png")).unwrap();

        assert_eq!(
            read_export(&root.export())
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>(),
            std::collections::BTreeMap::from([
                ("screencap/ok.png".into(), b"ok".to_vec()),
                (
                    "screencap/..%5C..%5Cescape.png".into(),
                    b"unsafe archive path".to_vec(),
                ),
            ])
        );
        let linked_root = root.0.join("debug/linked-root");
        symlink(&outside.0, &linked_root).unwrap();
        assert!(collect_debug_images(&linked_root, "screencap", true).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_archive_names_preserve_distinct_native_paths_without_collisions() {
        use std::collections::BTreeMap;
        use std::os::unix::ffi::OsStringExt;

        let root = TestDir::new();
        root.write("debug/screencap/a\\b.png", b"literal backslash");
        root.write("debug/screencap/a/b.png", b"nested image");
        root.write("debug/screencap/a%5Cb.png", b"literal percent");
        root.write("debug/screencap/C:frame.png", b"literal colon");
        let invalid_name = std::ffi::OsString::from_vec(b"bad\xff.png".to_vec());
        std::fs::write(
            root.0.join("debug/screencap").join(invalid_name),
            b"non-UTF-8",
        )
        .unwrap();

        let entries = read_export(&root.export());
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries.into_iter().collect::<BTreeMap<_, _>>(),
            BTreeMap::from([
                ("screencap/a%5Cb.png".into(), b"literal backslash".to_vec()),
                ("screencap/a/b.png".into(), b"nested image".to_vec()),
                ("screencap/a%255Cb.png".into(), b"literal percent".to_vec()),
                ("screencap/C%3Aframe.png".into(), b"literal colon".to_vec()),
                ("screencap/bad%FF.png".into(), b"non-UTF-8".to_vec()),
            ])
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_screenshot_subdirectory_reports_existing_export_error() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDir::new();
        root.write("debug/maafw.log", b"log");
        root.write("debug/screencap/visible.png", b"visible image");
        root.write("debug/screencap/blocked/hidden.png", b"blocked image");
        let blocked = root.0.join("debug/screencap/blocked");
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = std::fs::read_dir(&blocked).is_err();
        let result = export_logs_from_dir(&root.0, None, None);
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
        if denied {
            // 常规 log/json/dmp 收集先遍历所有调试子目录，这是已有的错误边界。
            assert!(result.unwrap_err().contains("读取目录失败"));
        } else {
            assert!(result.is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_or_removed_screenshots_do_not_prevent_other_entries() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDir::new();
        let unreadable = root.write("debug/screencap/unreadable.png", b"unreadable");
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        if std::fs::File::open(&unreadable).is_err() {
            assert!(!add_file_to_zip(
                &mut zip,
                &unreadable,
                "screencap/unreadable.png",
                Default::default()
            ));
            root.write("debug/screencap/ok.png", b"ok");
            assert_eq!(
                read_export(&root.export()),
                vec![("screencap/ok.png".into(), b"ok".to_vec())]
            );
        }
        let removed = root.write("debug/screencap/removed.png", b"removed");
        let entries = collect_debug_images(&root.0.join("debug/screencap"), "screencap", true);
        let entry = entries
            .iter()
            .find(|entry| entry.source_path == removed)
            .unwrap();
        std::fs::remove_file(&removed).unwrap();
        assert!(!add_file_to_zip(
            &mut zip,
            &entry.source_path,
            &entry.archive_name,
            Default::default()
        ));
        zip.finish().unwrap();
    }

    #[test]
    fn exported_text_is_redacted_without_changing_line_endings_or_binary_files() {
        let secret = "unique-export-test-token".to_string();
        super::super::log_secrets::register(&[secret.clone()]);
        let root = std::env::temp_dir().join(format!(
            "mxu-export-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let log_path = root.join("maafw.log");
        let binary_path = root.join("evidence.bin");
        std::fs::write(&log_path, format!("first\r\npassword={secret}")).unwrap();
        let binary = vec![0, 255, 1, 2, 3];
        std::fs::write(&binary_path, &binary).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let text_added = add_file_to_zip(&mut zip, &log_path, "maafw.log", Default::default());
        let binary_added =
            add_file_to_zip(&mut zip, &binary_path, "evidence.bin", Default::default());
        std::fs::remove_dir_all(root).unwrap();
        assert!(text_added && binary_added);
        let mut archive = zip::ZipArchive::new(zip.finish().unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name("maafw.log")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "first\r\npassword=******");
        let mut bytes = Vec::new();
        archive
            .by_name("evidence.bin")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, binary);
    }
}
