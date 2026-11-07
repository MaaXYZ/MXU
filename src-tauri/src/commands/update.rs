//! 更新安装相关命令
//!
//! 提供解压、增量/全量更新、文件移动等功能

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use log::{error, info, warn};
use serde::Serialize;

use super::types::ChangesJson;
use super::utils::{get_app_data_dir, get_exe_directory};

/// 包内覆盖更新会破坏资源封印和宿主通知身份，必须使用完整应用包安装流程。
#[tauri::command]
pub fn validate_update_target(target_dir: String) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&target_dir))
}

fn ensure_update_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    {
        // 同时检查词法路径和最近的已存在父目录，覆盖新目录与资源符号链接。
        let in_bundle = |candidate: &std::path::Path| {
            candidate.ancestors().any(|ancestor| {
                ancestor
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
                    && ancestor.join("Contents/Info.plist").is_file()
            })
        };
        if in_bundle(path) {
            return Err("SIGNED_APP_UPDATE_UNSUPPORTED".into());
        }
        for ancestor in path.ancestors() {
            if let Ok(resolved) = ancestor.canonicalize() {
                if in_bundle(&resolved) {
                    return Err("SIGNED_APP_UPDATE_UNSUPPORTED".into());
                }
                break;
            }
        }
    }
    #[cfg(not(any(target_os = "macos", test)))]
    let _ = path;
    Ok(())
}

/// 安装目录 cache/old 目录锁：全量更新期间旧文件作为回滚备份放在那里，
/// 启动时的异步清理必须与之互斥，避免备份在回滚前被删掉
pub static OLD_DIR_LOCK: Mutex<()> = Mutex::new(());

/// 文件操作失败时的重试次数（间隔从 200ms 开始翻倍，总计约 3 秒）
const FILE_OP_MAX_ATTEMPTS: u32 = 5;
const FILE_OP_INITIAL_DELAY_MS: u64 = 200;

/// 解压失败时返回给前端的错误
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractError {
    message: String,
    /// 是否为更新包本身损坏（截断、校验失败等），损坏的包需要重新下载
    corrupt: bool,
}

impl ExtractError {
    fn corrupt(message: String) -> Self {
        Self {
            message,
            corrupt: true,
        }
    }

    fn other(message: String) -> Self {
        Self {
            message,
            corrupt: false,
        }
    }
}

/// 全量更新失败时返回给前端的错误
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyUpdateError {
    message: String,
    /// 是否已回滚到更新前的状态
    rolled_back: bool,
}

/// 判断 IO 错误是否由压缩数据损坏引起
fn is_corrupt_data_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::InvalidData
            | std::io::ErrorKind::InvalidInput
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// 将 ZIP 读取错误转换为解压错误：IO 错误按类型判断，其余（格式错误等）视为包损坏
fn zip_read_error(message: String, e: &zip::result::ZipError) -> ExtractError {
    match e {
        zip::result::ZipError::Io(io) if !is_corrupt_data_error(io) => ExtractError::other(message),
        _ => ExtractError::corrupt(message),
    }
}

/// 解压压缩文件到指定目录，支持 zip 和 tar.gz/tgz 格式
#[tauri::command]
pub fn extract_zip(zip_path: String, dest_dir: String) -> Result<(), ExtractError> {
    ensure_update_path(std::path::Path::new(&dest_dir)).map_err(ExtractError::other)?;
    info!("extract_zip called: {} -> {}", zip_path, dest_dir);

    let path_lower = zip_path.to_lowercase();

    // 根据文件扩展名判断格式
    if path_lower.ends_with(".tar.gz") || path_lower.ends_with(".tgz") {
        extract_tar_gz(&zip_path, &dest_dir)
    } else {
        extract_zip_file(&zip_path, &dest_dir)
    }
}

/// 解压 ZIP 文件
fn extract_zip_file(zip_path: &str, dest_dir: &str) -> Result<(), ExtractError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| ExtractError::other(format!("无法打开 ZIP 文件 [{}]: {}", zip_path, e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| zip_read_error(format!("无法解析 ZIP 文件: {}", e), &e))?;

    // 确保目标目录存在
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| ExtractError::other(format!("无法创建目录 [{}]: {}", dest_dir, e)))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| zip_read_error(format!("无法读取 ZIP 条目 {}: {}", i, e), &e))?;

        let outpath = match file.enclosed_name() {
            Some(path) => std::path::Path::new(dest_dir).join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            // 目录
            std::fs::create_dir_all(&outpath).map_err(|e| {
                ExtractError::other(format!("无法创建目录 [{}]: {}", outpath.display(), e))
            })?;
        } else {
            // 文件
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).map_err(|e| {
                        ExtractError::other(format!("无法创建父目录 [{}]: {}", p.display(), e))
                    })?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| {
                ExtractError::other(format!("无法创建文件 [{}]: {}", outpath.display(), e))
            })?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| {
                let message = format!("无法写入文件 [{}]: {}", outpath.display(), e);
                if is_corrupt_data_error(&e) {
                    ExtractError::corrupt(message)
                } else {
                    ExtractError::other(message)
                }
            })?;
        }
    }

    info!("extract_zip success");
    Ok(())
}

/// 解压 tar.gz/tgz 文件
fn extract_tar_gz(tar_path: &str, dest_dir: &str) -> Result<(), ExtractError> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let file = std::fs::File::open(tar_path)
        .map_err(|e| ExtractError::other(format!("无法打开 tar.gz 文件 [{}]: {}", tar_path, e)))?;

    let gz = GzDecoder::new(file);
    let mut archive = Archive::new(gz);

    // 确保目标目录存在
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| ExtractError::other(format!("无法创建目录 [{}]: {}", dest_dir, e)))?;

    archive.unpack(dest_dir).map_err(|e| {
        let message = format!("解压 tar.gz 失败: {}", e);
        if is_corrupt_data_error(&e) {
            ExtractError::corrupt(message)
        } else {
            ExtractError::other(message)
        }
    })?;

    info!("extract_tar_gz success");
    Ok(())
}

/// 检查解压目录中是否存在 changes.json（增量包标识）
#[tauri::command]
pub fn check_changes_json(extract_dir: String) -> Result<Option<ChangesJson>, String> {
    let changes_path = std::path::Path::new(&extract_dir).join("changes.json");

    if !changes_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&changes_path)
        .map_err(|e| format!("无法读取 changes.json: {}", e))?;

    let changes: ChangesJson =
        serde_json::from_str(&content).map_err(|e| format!("无法解析 changes.json: {}", e))?;

    Ok(Some(changes))
}

/// 递归清理目录内容，逐个删除文件和空目录，返回 (成功数, 失败数)
pub fn cleanup_dir_contents(dir: &std::path::Path) -> (usize, usize) {
    let mut deleted = 0;
    let mut failed = 0;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // 递归清理子目录
                let (d, f) = cleanup_dir_contents(&path);
                deleted += d;
                failed += f;
                // 尝试删除空目录
                if std::fs::remove_dir(&path).is_ok() {
                    deleted += 1;
                }
            } else {
                // 删除文件
                match std::fs::remove_file(&path) {
                    Ok(()) => deleted += 1,
                    Err(_) => failed += 1,
                }
            }
        }
    }

    // 尝试删除根目录本身
    let _ = std::fs::remove_dir(dir);

    (deleted, failed)
}

/// 将更新包归档到数据目录下的 cache/old 文件夹
#[tauri::command]
pub fn move_update_package_to_old(file_path: String) -> Result<(), String> {
    archive_to_data_old(Path::new(&file_path))
}

/// 将数据目录中的文件归档到同一文件系统的 cache/old
pub fn archive_to_data_old(source: &Path) -> Result<(), String> {
    move_to_old_folder_in_dir(source, &get_data_old_dir()?).map(|_| ())
}

/// 获取安装目录 cache/old 路径（程序旧文件与回滚备份）
pub fn get_old_dir() -> Result<PathBuf, String> {
    old_dir_for_executable(&get_exe_directory()?, get_app_data_dir)
}

fn old_dir_for_executable(
    exe_dir: &Path,
    app_data_dir: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    // macOS 的可执行文件可能在已签名的 .app 内，归档和回滚备份必须放在包外。
    // 包外便携程序仍使用同卷目录，避免旧文件移动到用户目录时跨文件系统失败。
    let root = if ensure_update_path(exe_dir).is_err() {
        app_data_dir()?
    } else {
        exe_dir.to_path_buf()
    };
    let old_dir = root.join("cache").join("old");
    ensure_update_path(&old_dir)?;
    Ok(old_dir)
}

/// 获取数据目录 cache/old 路径（更新包归档）
pub fn get_data_old_dir() -> Result<PathBuf, String> {
    Ok(get_app_data_dir()?.join("cache").join("old"))
}

/// 清空 cache/old 目录，返回 (成功数, 失败数)。
/// 删不掉的文件（如仍被旧进程占用）会保留，后续移动遇到重名时自动加后缀
fn clear_old_folder(old_dir: &Path) -> (usize, usize) {
    if !old_dir.exists() || std::fs::remove_dir_all(old_dir).is_ok() {
        return (0, 0);
    }
    cleanup_dir_contents(old_dir)
}

/// 将文件或目录移动到 cache/old 文件夹，处理重名冲突（内部函数）
///
/// 不在这里清理 cache/old：全量更新期间 cache/old 中的文件是回滚备份，
/// 清理只在更新开始时和程序启动时进行
pub fn move_to_old_folder(source: &std::path::Path) -> Result<(), String> {
    move_to_old_folder_dest(source).map(|_| ())
}

/// 将文件或目录移动到安装目录的 cache/old，返回移动后的路径（源不存在时返回 None）
fn move_to_old_folder_dest(source: &Path) -> Result<Option<PathBuf>, String> {
    move_to_old_folder_in_dir(source, &get_old_dir()?)
}

/// 将文件或目录移动到指定 cache/old，返回移动后的路径（源不存在时返回 None）
fn move_to_old_folder_in_dir(source: &Path, old_dir: &Path) -> Result<Option<PathBuf>, String> {
    ensure_update_path(source)?;
    // 只有确认不存在才跳过；其他错误（如权限不足）不能当作不存在，否则回滚时无从还原
    match source.symlink_metadata() {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法读取 [{}] 的文件信息: {}", source.display(), e)),
    }

    ensure_update_path(old_dir)?;
    std::fs::create_dir_all(old_dir)
        .map_err(|e| format!("无法创建 old 目录 [{}]: {}", old_dir.display(), e))?;

    let file_name = source
        .file_name()
        .ok_or_else(|| format!("无法获取文件名: {}", source.display()))?;

    let mut dest = old_dir.join(file_name);

    // 如果目标已存在，添加 .bak001 等后缀
    if dest.exists() {
        let base_name = file_name.to_string_lossy();
        for i in 1..=999 {
            let new_name = format!("{}.bak{:03}", base_name, i);
            dest = old_dir.join(&new_name);
            if !dest.exists() {
                break;
            }
        }
        // 如果 999 个备份都存在，覆盖最后的
    }

    // 执行移动（重命名）
    std::fs::rename(source, &dest).map_err(|e| {
        format!(
            "无法移动 [{}] -> [{}]: {}",
            source.display(),
            dest.display(),
            e
        )
    })?;

    info!("Moved to old: {} -> {}", source.display(), dest.display());
    Ok(Some(dest))
}

/// 执行文件操作，失败时按退避间隔重试（应对安全软件扫描等短暂占用）
fn retry_file_op<T>(what: &str, mut op: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut delay = FILE_OP_INITIAL_DELAY_MS;
    let mut attempt = 1;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < FILE_OP_MAX_ATTEMPTS => {
                warn!(
                    "{} 失败（第 {} 次），{}ms 后重试: {}",
                    what, attempt, delay, e
                );
                std::thread::sleep(Duration::from_millis(delay));
                delay *= 2;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// 删除文件或目录（目录递归删除）
fn remove_path(path: &std::path::Path) -> std::io::Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// 规范化增量包中的相对路径，移除常见前缀（./ .\ / \）
fn normalize_relative_path(raw: &str) -> &str {
    let mut s = raw.trim();
    loop {
        if let Some(stripped) = s.strip_prefix("./") {
            s = stripped;
        } else if let Some(stripped) = s.strip_prefix(".\\") {
            s = stripped;
        } else if let Some(stripped) = s.strip_prefix('/') {
            s = stripped;
        } else if let Some(stripped) = s.strip_prefix('\\') {
            s = stripped;
        } else {
            break;
        }
    }
    s
}

/// 应用增量更新：将 deleted 中的文件移动到 old 文件夹，然后复制新文件
/// 即使移动旧文件失败，也会继续复制新文件，确保程序可用
#[tauri::command]
pub fn apply_incremental_update(
    extract_dir: String,
    target_dir: String,
    deleted_files: Vec<String>,
) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&target_dir))?;
    info!("apply_incremental_update called");
    info!("extract_dir: {}, target_dir: {}", extract_dir, target_dir);
    info!("deleted_files: {:?}", deleted_files);

    let target_path = std::path::Path::new(&target_dir);
    let mut move_errors: Vec<String> = Vec::new();

    // 1. 尝试将 deleted 中列出的文件移动到 old 文件夹（失败时兜底直接删除）
    for file in &deleted_files {
        // 规范化 changes.json 里的相对路径，避免前导分隔符导致 join 偏离 target_dir
        let normalized = normalize_relative_path(file);
        let file_path = target_path.join(normalized);
        if file_path.exists() {
            if let Err(e) = move_to_old_folder(&file_path) {
                warn!("移动旧文件失败（将继续更新）: {}", e);
                move_errors.push(e);
                // 兜底：即使无法备份到 old，也要确保 deleted 文件被删除
                let remove_result = remove_path(&file_path);
                if let Err(remove_err) = remove_result {
                    warn!(
                        "兜底删除失败（可能残留旧文件）: {} -> {}",
                        file_path.display(),
                        remove_err
                    );
                } else {
                    info!("已兜底删除 deleted 文件: {}", file_path.display());
                }
            }
        }
    }

    // 2. 复制新包内容到目标目录（覆盖）- 这一步必须执行
    copy_dir_contents(&extract_dir, &target_dir, Some(&["changes.json"]))?;

    if !move_errors.is_empty() {
        info!(
            "apply_incremental_update completed with {} move warnings",
            move_errors.len()
        );
    } else {
        info!("apply_incremental_update success");
    }
    Ok(())
}

/// 应用全量更新：将与新包根目录同名的文件夹/文件移动到 old 文件夹，然后复制新文件
///
/// 任何一步失败都会回滚：删除已复制的新文件，并把移走的旧文件挪回原位，
/// 保证安装目录要么全部是新版本，要么保持更新前的状态
#[tauri::command]
pub fn apply_full_update(extract_dir: String, target_dir: String) -> Result<(), ApplyUpdateError> {
    ensure_update_path(std::path::Path::new(&target_dir)).map_err(|message| ApplyUpdateError {
        message,
        rolled_back: false,
    })?;
    info!("apply_full_update called");
    info!("extract_dir: {}, target_dir: {}", extract_dir, target_dir);

    let _old_dir_guard = OLD_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // 只在更新开始时清空一次 cache/old，之后移入的旧文件作为本次更新的回滚备份
    if let Ok(old_dir) = get_old_dir() {
        let (deleted, failed) = clear_old_folder(&old_dir);
        if deleted > 0 || failed > 0 {
            info!(
                "Cleanup cache/old before update: {} deleted, {} failed",
                deleted, failed
            );
        }
    }

    let mut journal = FullUpdateJournal::default();
    match run_full_update(
        Path::new(&extract_dir),
        Path::new(&target_dir),
        &mut journal,
    ) {
        Ok(()) => {
            info!("apply_full_update success");
            Ok(())
        }
        Err(message) => {
            warn!("全量更新失败，开始回滚: {}", message);
            let rolled_back = journal.rollback();
            if rolled_back {
                info!("回滚完成，已恢复到更新前的状态");
            } else {
                error!("回滚未完成，安装目录可能处于不完整状态");
            }
            Err(ApplyUpdateError {
                message,
                rolled_back,
            })
        }
    }
}

/// 全量更新过程记录，用于失败时回滚
#[derive(Default)]
struct FullUpdateJournal {
    /// 已移入 cache/old 的旧条目：(原路径, 备份路径)
    moved: Vec<(PathBuf, PathBuf)>,
    /// 已开始复制的新条目（目标目录下的根级路径）
    copied: Vec<PathBuf>,
}

impl FullUpdateJournal {
    /// 删除已复制的新条目，并把旧条目挪回原位。全部还原成功时返回 true
    fn rollback(&self) -> bool {
        let mut ok = true;

        for path in self.copied.iter().rev() {
            if path.symlink_metadata().is_err() {
                continue;
            }
            let result = retry_file_op(&format!("删除新文件 [{}]", path.display()), || {
                remove_path(path).map_err(|e| e.to_string())
            });
            if let Err(e) = result {
                error!("回滚时无法删除新文件 [{}]: {}", path.display(), e);
                ok = false;
            }
        }

        for (original, backup) in self.moved.iter().rev() {
            if original.symlink_metadata().is_ok() {
                error!(
                    "回滚时原位置仍被占用，无法还原 [{}] -> [{}]",
                    backup.display(),
                    original.display()
                );
                ok = false;
                continue;
            }
            let result =
                retry_file_op(&format!("还原旧文件 [{}]", original.display()), || {
                    std::fs::rename(backup, original).map_err(|e| e.to_string())
                });
            match result {
                Ok(()) => info!("已还原: {} -> {}", backup.display(), original.display()),
                Err(e) => {
                    error!(
                        "回滚时无法还原 [{}] -> [{}]: {}",
                        backup.display(),
                        original.display(),
                        e
                    );
                    ok = false;
                }
            }
        }

        ok
    }
}

/// 判断根级条目是否为 interface 文件（记录版本号，需要最后复制）
fn is_interface_file(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy()
        .to_lowercase()
        .starts_with("interface.json")
}

fn run_full_update(
    extract_path: &Path,
    target_path: &Path,
    journal: &mut FullUpdateJournal,
) -> Result<(), String> {
    // 1. 获取解压目录中的根级条目（跳过 changes.json），interface 文件排到最后：
    // 即使中途异常退出，版本号也仍是旧的，下次启动会继续提示更新
    let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(extract_path)
        .map_err(|e| format!("无法读取解压目录: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .filter(|name| name != "changes.json")
        .collect();
    names.sort_by_key(|name| is_interface_file(name));

    // 2. 将目标目录中与新包同名的文件/文件夹移动到 old 文件夹，移不走则中止
    for name in &names {
        let target_item = target_path.join(name);
        let moved = retry_file_op(
            &format!("移动旧文件 [{}]", target_item.display()),
            || move_to_old_folder_dest(&target_item),
        )?;
        if let Some(backup) = moved {
            journal.moved.push((target_item, backup));
        }
    }

    // 3. 复制新包内容到目标目录
    for name in &names {
        let src_item = extract_path.join(name);
        let dst_item = target_path.join(name);
        journal.copied.push(dst_item.clone());
        if src_item.is_dir() {
            copy_dir_recursive(&src_item, &dst_item)?;
        } else {
            std::fs::copy(&src_item, &dst_item).map_err(|e| {
                format!(
                    "无法复制文件 [{}] -> [{}]: {}",
                    src_item.display(),
                    dst_item.display(),
                    e
                )
            })?;
        }
    }

    // 4. 稍等片刻再核对新文件是否都在，防止复制后被安全软件删除或隔离
    std::thread::sleep(Duration::from_secs(1));
    for name in &names {
        verify_copied(&extract_path.join(name), &target_path.join(name))?;
    }

    Ok(())
}

/// 核对源路径下的每个文件在目标位置都存在
fn verify_copied(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("无法读取目录 [{}]: {}", src.display(), e))?;
        for entry in entries.flatten() {
            verify_copied(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else if dst.is_file() {
        Ok(())
    } else {
        Err(format!(
            "新文件 [{}] 在复制后丢失，可能被安全软件删除或隔离",
            dst.display()
        ))
    }
}

/// 复制单个文件，先尝试将目标文件移动到 old 目录再复制
/// 如果移动失败，直接尝试覆盖（确保新文件能被复制）
fn copy_file_with_move_old(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    // 如果目标文件存在，先尝试移动到 old 目录
    if dst.exists() {
        if let Err(e) = move_to_old_folder(dst) {
            warn!("移动旧文件到 old 目录失败，将直接覆盖: {}", e);
            // 移动失败时，尝试直接删除旧文件以便覆盖
            if let Err(del_err) = std::fs::remove_file(dst) {
                warn!("删除旧文件也失败: {}，尝试直接覆盖", del_err);
            }
        }
    }

    // 复制新文件
    std::fs::copy(src, dst).map_err(|e| {
        format!(
            "无法复制文件 [{}] -> [{}]: {}",
            src.display(),
            dst.display(),
            e
        )
    })?;

    Ok(())
}

/// 递归复制目录内容（不包含根目录本身）
fn copy_dir_contents(src: &str, dst: &str, skip_files: Option<&[&str]>) -> Result<(), String> {
    let src_path = std::path::Path::new(src);
    let dst_path = std::path::Path::new(dst);

    // 确保目标目录存在
    std::fs::create_dir_all(dst_path).map_err(|e| format!("无法创建目录 [{}]: {}", dst, e))?;

    for entry in
        std::fs::read_dir(src_path).map_err(|e| format!("无法读取目录 [{}]: {}", src, e))?
    {
        let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();

        // 检查是否需要跳过
        if let Some(skip) = skip_files {
            if skip.iter().any(|s| *s == file_name_str) {
                continue;
            }
        }

        let src_item = entry.path();
        let dst_item = dst_path.join(&file_name);

        if src_item.is_dir() {
            copy_dir_recursive(&src_item, &dst_item)?;
        } else {
            copy_file_with_move_old(&src_item, &dst_item)?;
        }
    }

    Ok(())
}

/// 递归复制整个目录
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("无法创建目录 [{}]: {}", dst.display(), e))?;

    for entry in
        std::fs::read_dir(src).map_err(|e| format!("无法读取目录 [{}]: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("无法读取目录条目: {}", e))?;
        let src_item = entry.path();
        let dst_item = dst.join(entry.file_name());

        if src_item.is_dir() {
            copy_dir_recursive(&src_item, &dst_item)?;
        } else {
            copy_file_with_move_old(&src_item, &dst_item)?;
        }
    }

    Ok(())
}

/// 更新完成后清理残留产物：
/// 1. 删除 target_dir/changes.json（增量包标识，更新后无需保留）
/// 2. 删除 cache_dir 下所有 *.downloading 临时文件
#[tauri::command]
pub fn cleanup_update_artifacts(target_dir: String, cache_dir: String) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&target_dir))?;
    ensure_update_path(std::path::Path::new(&cache_dir))?;
    // 删除 target_dir/changes.json
    let changes_path = std::path::Path::new(&target_dir).join("changes.json");
    if changes_path.exists() {
        match std::fs::remove_file(&changes_path) {
            Ok(()) => info!("已删除 changes.json: {}", changes_path.display()),
            Err(e) => warn!("删除 changes.json 失败（忽略）: {}", e),
        }
    }

    // 删除 cache_dir 下所有 *.downloading 文件
    let cache_path = std::path::Path::new(&cache_dir);
    if cache_path.exists() {
        if let Ok(entries) = std::fs::read_dir(cache_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let name = path.file_name().unwrap_or_default().to_string_lossy();
                    if name.ends_with(".downloading") {
                        match std::fs::remove_file(&path) {
                            Ok(()) => info!("已删除临时下载文件: {}", path.display()),
                            Err(e) => warn!("删除临时下载文件失败（忽略）: {}", e),
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// 清理临时解压目录
#[tauri::command]
pub fn cleanup_extract_dir(extract_dir: String) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&extract_dir))?;
    info!("cleanup_extract_dir: {}", extract_dir);

    let path = std::path::Path::new(&extract_dir);
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("无法清理目录 [{}]: {}", extract_dir, e))?;
    }

    Ok(())
}

/// 兜底更新：当正常更新失败时，将新文件解压到 v版本号 文件夹
/// 并复制 config 文件夹，让用户可以临时使用新版本
#[tauri::command]
pub fn fallback_update(
    extract_dir: String,
    target_dir: String,
    new_version: String,
) -> Result<String, String> {
    ensure_update_path(std::path::Path::new(&target_dir))?;
    info!(
        "fallback_update called: extract_dir={}, target_dir={}, new_version={}",
        extract_dir, target_dir, new_version
    );

    let target_path = std::path::Path::new(&target_dir);

    // 解压目录不存在或为空时不创建兜底目录，避免留下空的版本文件夹
    let has_content = std::fs::read_dir(&extract_dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if !has_content {
        return Err(format!(
            "解压目录不存在或为空，跳过兜底更新: {}",
            extract_dir
        ));
    }

    // 创建 v版本号 文件夹（如 v1.2.3）
    let version_folder_name = format!("v{}", new_version.trim_start_matches('v'));
    let fallback_dir = target_path.join(&version_folder_name);

    // 如果已存在同名文件夹，加后缀
    let mut final_fallback_dir = fallback_dir.clone();
    let mut suffix = 0;
    while final_fallback_dir.exists() {
        suffix += 1;
        final_fallback_dir = target_path.join(format!("{}-{}", version_folder_name, suffix));
    }

    info!("创建兜底目录: {}", final_fallback_dir.display());

    // 创建兜底目录
    std::fs::create_dir_all(&final_fallback_dir).map_err(|e| format!("无法创建兜底目录: {}", e))?;

    // 复制解压的新文件到兜底目录，失败时删除不完整的兜底目录
    if let Err(e) = copy_dir_contents(
        &extract_dir,
        final_fallback_dir.to_str().unwrap_or(""),
        Some(&["changes.json"]),
    ) {
        if let Err(remove_err) = std::fs::remove_dir_all(&final_fallback_dir) {
            warn!(
                "清理不完整的兜底目录失败 [{}]: {}",
                final_fallback_dir.display(),
                remove_err
            );
        }
        return Err(e);
    }

    // 复制 config 文件夹（如果存在）
    let config_src = target_path.join("config");
    if config_src.exists() {
        let config_dst = final_fallback_dir.join("config");
        if let Err(e) = copy_dir_recursive(&config_src, &config_dst) {
            warn!("复制 config 文件夹失败: {}", e);
        } else {
            info!("已复制 config 文件夹到兜底目录");
        }
    }

    let result_path = final_fallback_dir.to_str().unwrap_or("").to_string();
    info!("fallback_update success: {}", result_path);

    Ok(result_path)
}

/// 检查当前程序文件是否仍然存在（重启前确认未被安全软件删除或隔离）
#[tauri::command]
pub fn current_exe_exists() -> bool {
    match std::env::current_exe() {
        Ok(path) => {
            let exists = path.is_file();
            if !exists {
                warn!("程序文件不存在: {}", path.display());
            }
            exists
        }
        // 无法获取路径时不阻止重启，交给原有流程处理
        Err(_) => true,
    }
}

#[cfg(test)]
mod bundle_update_tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mxu-update-policy-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn app_bundle_update_entry_points_refuse_before_mutating_files() {
        let temp = Fixture::new();
        let bundle = temp.0.join("Host.app");
        let target = bundle.join("Contents/MacOS");
        let resources = bundle.join("Contents/Resources/MXU-portable");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"original identity").unwrap();
        std::fs::write(target.join("interface.json"), b"original resource").unwrap();
        let target_string = target.to_string_lossy().into_owned();
        let missing_archive = temp.0.join("missing.zip").to_string_lossy().into_owned();
        for result in [
            validate_update_target(target_string.clone()),
            validate_update_target(resources.join("new/version").to_string_lossy().into_owned()),
            apply_incremental_update(
                missing_archive.clone(),
                target_string.clone(),
                vec!["interface.json".into()],
            ),
            fallback_update(missing_archive.clone(), target_string.clone(), "2".into()).map(|_| ()),
            cleanup_extract_dir(target_string.clone()),
            cleanup_update_artifacts(target_string.clone(), target_string.clone()),
            move_to_old_folder(&target.join("interface.json")),
            move_to_old_folder_dest(&target.join("interface.json")).map(|_| ()),
        ] {
            assert_eq!(result.unwrap_err(), "SIGNED_APP_UPDATE_UNSUPPORTED");
        }
        let extract_error =
            extract_zip(missing_archive.clone(), target_string.clone()).unwrap_err();
        assert_eq!(extract_error.message, "SIGNED_APP_UPDATE_UNSUPPORTED");
        assert!(!extract_error.corrupt);
        let apply_error = apply_full_update(missing_archive, target_string).unwrap_err();
        assert_eq!(apply_error.message, "SIGNED_APP_UPDATE_UNSUPPORTED");
        assert!(!apply_error.rolled_back);
        assert_eq!(
            std::fs::read(target.join("interface.json")).unwrap(),
            b"original resource"
        );
        assert_eq!(
            std::fs::read(bundle.join("Contents/Info.plist")).unwrap(),
            b"original identity"
        );
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
    }

    #[test]
    fn external_portable_directory_updates_still_work() {
        let temp = Fixture::new();
        let source = temp.0.join("extracted");
        let target = temp.0.join("portable");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("resource.json"), b"new resource").unwrap();
        validate_update_target(target.to_string_lossy().into_owned()).unwrap();
        apply_full_update(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(target.join("resource.json")).unwrap(),
            b"new resource"
        );
    }

    #[test]
    fn bundle_archives_use_app_data_while_portable_archives_stay_with_the_executable() {
        let temp = Fixture::new();
        let macos = temp.0.join("Host.app/Contents/MacOS");
        let app_data = temp.0.join("home/Library/Application Support/MXU");
        let portable = temp.0.join("external-volume/portable");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(macos.parent().unwrap().join("Info.plist"), b"identity").unwrap();
        assert_eq!(
            old_dir_for_executable(&macos, || Ok(app_data.clone())).unwrap(),
            app_data.join("cache/old")
        );
        assert_eq!(
            old_dir_for_executable(&portable, || panic!(
                "portable archives do not use app data"
            ))
            .unwrap(),
            portable.join("cache/old")
        );
        // 即便应用数据目录被错误设置在包内，也不允许归档或清理写入该目录。
        assert_eq!(
            old_dir_for_executable(&macos, || Ok(macos.clone())).unwrap_err(),
            "SIGNED_APP_UPDATE_UNSUPPORTED"
        );
    }

    #[test]
    fn external_downloads_are_archived_and_rotated_without_overwriting() {
        let temp = Fixture::new();
        let source = temp.0.join("download.zip");
        let archive = temp.0.join("data/cache/old");

        std::fs::write(&source, b"original download").unwrap();
        let first = move_to_old_folder_in_dir(&source, &archive)
            .unwrap()
            .unwrap();
        assert_eq!(first, archive.join("download.zip"));
        assert!(!source.exists());

        std::fs::write(&source, b"replacement download").unwrap();
        let second = move_to_old_folder_in_dir(&source, &archive)
            .unwrap()
            .unwrap();
        assert_eq!(second, archive.join("download.zip.bak001"));
        assert!(!source.exists());
        assert_eq!(std::fs::read(&first).unwrap(), b"original download");
        assert_eq!(std::fs::read(&second).unwrap(), b"replacement download");
    }

    #[cfg(unix)]
    #[test]
    fn aliases_into_an_app_bundle_are_also_protected() {
        let temp = Fixture::new();
        let bundle = temp.0.join("Host.app");
        std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), b"identity").unwrap();
        let alias = temp.0.join("alias");
        std::os::unix::fs::symlink(bundle.join("Contents/Resources"), &alias).unwrap();
        assert!(validate_update_target(alias.join("new").to_string_lossy().into_owned()).is_err());
    }
}
