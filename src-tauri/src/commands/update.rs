//! 更新安装相关命令
//!
//! 提供解压、增量/全量更新、文件移动等功能

use log::{info, warn};

use super::file_ops::get_exe_dir;
use super::types::ChangesJson;

/// 解压压缩文件到指定目录，支持 zip 和 tar.gz/tgz 格式
#[tauri::command]
pub fn extract_zip(zip_path: String, dest_dir: String) -> Result<(), String> {
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
fn extract_zip_file(zip_path: &str, dest_dir: &str) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("无法打开 ZIP 文件 [{}]: {}", zip_path, e))?;

    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("无法解析 ZIP 文件: {}", e))?;

    // 确保目标目录存在
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("无法创建目录 [{}]: {}", dest_dir, e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("无法读取 ZIP 条目 {}: {}", i, e))?;

        let outpath = match file.enclosed_name() {
            Some(path) => std::path::Path::new(dest_dir).join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            // 目录
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("无法创建目录 [{}]: {}", outpath.display(), e))?;
        } else {
            // 文件
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)
                        .map_err(|e| format!("无法创建父目录 [{}]: {}", p.display(), e))?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("无法创建文件 [{}]: {}", outpath.display(), e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("无法写入文件 [{}]: {}", outpath.display(), e))?;
        }
    }

    info!("extract_zip success");
    Ok(())
}

/// 解压 tar.gz/tgz 文件
fn extract_tar_gz(tar_path: &str, dest_dir: &str) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let file = std::fs::File::open(tar_path)
        .map_err(|e| format!("无法打开 tar.gz 文件 [{}]: {}", tar_path, e))?;

    let gz = GzDecoder::new(file);
    let mut archive = Archive::new(gz);

    // 确保目标目录存在
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("无法创建目录 [{}]: {}", dest_dir, e))?;

    archive
        .unpack(dest_dir)
        .map_err(|e| format!("解压 tar.gz 失败: {}", e))?;

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

/// 将文件或目录移动到程序目录下的 cache/old 文件夹，处理重名冲突
/// 供前端调用，统一文件移动逻辑
#[tauri::command]
pub fn move_file_to_old(file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    move_to_old_folder(path)
}

/// 将文件或目录移动到程序目录下的 cache/old 文件夹，处理重名冲突（内部函数）
pub fn move_to_old_folder(source: &std::path::Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    // 统一移动到 exe_dir/cache/old
    let exe_dir = get_exe_dir()?;
    let old_dir = std::path::Path::new(&exe_dir).join("cache").join("old");

    // 在移动前先尝试清理 old 目录，避免同名文件冲突
    if old_dir.exists() {
        // 1. 尝试删除整个目录
        if std::fs::remove_dir_all(&old_dir).is_err() {
            // 2. 如果失败，遍历删除里面每个文件/子目录
            let (deleted, failed) = cleanup_dir_contents(&old_dir);
            if deleted > 0 || failed > 0 {
                info!(
                    "Cleanup cache/old before move: {} deleted, {} failed",
                    deleted, failed
                );
            }
        }
    }

    // 确保目录存在（刚删掉的话需要重新创建）
    std::fs::create_dir_all(&old_dir)
        .map_err(|e| format!("无法创建 old 目录 [{}]: {}", old_dir.display(), e))?;

    let file_name = source
        .file_name()
        .ok_or_else(|| format!("无法获取文件名: {}", source.display()))?;

    let mut dest = old_dir.join(file_name);

    // 如果目标仍然存在（清理没删掉），添加 .bak001 等后缀
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
    Ok(())
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

/// 应用增量更新：要删除或覆盖的文件先移到 cache/old/incremental-<时间戳>，再复制新文件。
/// 任何一步失败都会把改动过的文件全部还原，安装目录保持旧版本，不会变成新旧混合。
/// changes.json 带 base（旧版本文件的 SHA-256）时，先确认本地文件与旧版本一致，否则不做任何改动。
#[tauri::command]
pub fn apply_incremental_update(
    extract_dir: String,
    target_dir: String,
    deleted_files: Vec<String>,
) -> Result<(), String> {
    info!("apply_incremental_update called");
    info!("extract_dir: {}, target_dir: {}", extract_dir, target_dir);
    info!("deleted_files: {:?}", deleted_files);

    let old_dir = std::path::Path::new(&get_exe_dir()?)
        .join("cache")
        .join("old");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    apply_incremental(
        std::path::Path::new(&extract_dir),
        std::path::Path::new(&target_dir),
        &deleted_files,
        &old_dir.join(format!("incremental-{}", stamp)),
    )?;
    info!("apply_incremental_update success");
    Ok(())
}

/// 增量更新改动过的文件，用于失败时还原
struct UpdateJournal {
    backup: std::path::PathBuf,
    /// (安装目录中的路径, 备份目录中的旧文件)
    set_aside: Vec<(std::path::PathBuf, std::path::PathBuf)>,
    /// 更新新增的文件（原本不存在）
    created: Vec<std::path::PathBuf>,
}

impl UpdateJournal {
    /// 将 path（文件或文件夹）移到备份目录下的 rel；无法移动的文件改为复制一份
    fn set_aside(&mut self, rel: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
        let dest = self.backup.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建备份目录 [{}]: {}", parent.display(), e))?;
        }
        if let Err(e) = std::fs::rename(path, &dest) {
            if !path.is_file() {
                return Err(format!("无法备份 [{}]: {}", path.display(), e));
            }
            std::fs::copy(path, &dest)
                .map_err(|e| format!("无法备份 [{}]: {}", path.display(), e))?;
        }
        self.set_aside.push((path.to_path_buf(), dest));
        Ok(())
    }

    fn rollback(&self) {
        for path in self.created.iter().rev() {
            if let Err(e) = remove_path(path) {
                warn!("还原：无法删除新增的 [{}]: {}", path.display(), e);
            }
        }
        for (path, saved) in self.set_aside.iter().rev() {
            if path.exists() {
                let _ = remove_path(path);
            }
            let restored = std::fs::rename(saved, path).is_ok()
                || (saved.is_file() && std::fs::copy(saved, path).is_ok());
            if !restored {
                warn!("还原失败: [{}] <- [{}]", path.display(), saved.display());
            }
        }
    }
}

/// dir 下的所有文件（相对路径，已排序）
fn relative_files(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries =
            std::fs::read_dir(&d).map_err(|e| format!("无法读取目录 [{}]: {}", d.display(), e))?;
        for entry in entries {
            let path = entry
                .map_err(|e| format!("无法读取目录条目: {}", e))?
                .path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(rel) = path.strip_prefix(dir) {
                out.push(rel.to_path_buf());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 文件的 SHA-256（小写十六进制）
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("{}: {}", path.display(), e))?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// target 中与旧版本不一致的文件（base：相对路径 → 旧版本 SHA-256）；缺失或无法读取也算不一致
fn files_not_at_base(
    target: &std::path::Path,
    base: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut differ: Vec<String> = base
        .iter()
        .filter(|(rel, sha)| {
            sha256_file(&target.join(normalize_relative_path(rel)))
                .map_or(true, |actual| !actual.eq_ignore_ascii_case(sha))
        })
        .map(|(rel, _)| rel.clone())
        .collect();
    differ.sort();
    differ
}

fn apply_incremental(
    extract: &std::path::Path,
    target: &std::path::Path,
    deleted_files: &[String],
    backup: &std::path::Path,
) -> Result<(), String> {
    // 用户改过的文件、上次没更新完的文件：在其上应用增量包只会得到新旧混合的安装
    let base = std::fs::read_to_string(extract.join("changes.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<ChangesJson>(&s).ok())
        .map(|c| c.base)
        .unwrap_or_default();
    let differ = files_not_at_base(target, &base);
    if !differ.is_empty() {
        return Err(format!(
            "本地文件与更新前的版本不一致，无法应用增量更新，请下载完整包: {}",
            differ.join(", ")
        ));
    }

    let mut journal = UpdateJournal {
        backup: backup.to_path_buf(),
        set_aside: Vec::new(),
        created: Vec::new(),
    };
    let mut run = || -> Result<(), String> {
        for file in deleted_files {
            let rel = normalize_relative_path(file);
            let path = target.join(rel);
            if path.exists() {
                if let Err(e) = journal.set_aside(std::path::Path::new(rel), &path) {
                    // 残留一个旧文件无害，不因此让整个更新失败
                    warn!("无法移除旧文件（保留）: {}", e);
                }
            }
        }
        for rel in relative_files(extract)? {
            if rel.as_os_str() == "changes.json" {
                continue;
            }
            let src = extract.join(&rel);
            let dst = target.join(&rel);
            let existed = dst.exists();
            if existed {
                journal.set_aside(&rel, &dst)?;
            }
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("无法创建目录 [{}]: {}", parent.display(), e))?;
            }
            std::fs::copy(&src, &dst)
                .map_err(|e| format!("无法复制文件 [{}]: {}", dst.display(), e))?;
            if !existed {
                journal.created.push(dst.clone());
            }
            if sha256_file(&dst)? != sha256_file(&src)? {
                return Err(format!("复制后内容不一致 [{}]", dst.display()));
            }
        }
        Ok(())
    };
    let result = run();
    if let Err(e) = &result {
        warn!("增量更新失败，已还原为原版本: {}", e);
        journal.rollback();
    }
    result
}

/// 应用全量更新：将与新包根目录同名的文件夹/文件移动到 old 文件夹，然后复制新文件
/// 即使移动旧文件失败，也会继续复制新文件，确保程序可用
#[tauri::command]
pub fn apply_full_update(extract_dir: String, target_dir: String) -> Result<(), String> {
    info!("apply_full_update called");
    info!("extract_dir: {}, target_dir: {}", extract_dir, target_dir);

    let extract_path = std::path::Path::new(&extract_dir);
    let target_path = std::path::Path::new(&target_dir);
    let mut move_errors: Vec<String> = Vec::new();

    // 1. 获取解压目录中的根级条目
    let entries: Vec<_> = std::fs::read_dir(extract_path)
        .map_err(|e| format!("无法读取解压目录: {}", e))?
        .filter_map(|e| e.ok())
        .collect();

    // 2. 尝试将目标目录中与新包同名的文件/文件夹移动到 old 文件夹（失败不阻断）
    for entry in &entries {
        let name = entry.file_name();
        let target_item = target_path.join(&name);

        // 跳过 changes.json
        if name == "changes.json" {
            continue;
        }

        if target_item.exists() {
            if let Err(e) = move_to_old_folder(&target_item) {
                warn!("移动旧文件失败（将继续更新）: {}", e);
                move_errors.push(e);
                // 兜底：全量更新若无法备份旧目录，直接删除后再复制，避免残留已移除文件
                if let Err(remove_err) = remove_path(&target_item) {
                    warn!(
                        "全量更新兜底删除失败（可能残留旧文件）: {} -> {}",
                        target_item.display(),
                        remove_err
                    );
                } else {
                    info!("全量更新已兜底删除旧条目: {}", target_item.display());
                }
            }
        }
    }

    // 3. 复制新包内容到目标目录 - 这一步必须执行
    copy_dir_contents(&extract_dir, &target_dir, Some(&["changes.json"]))?;

    if !move_errors.is_empty() {
        info!(
            "apply_full_update completed with {} move warnings",
            move_errors.len()
        );
    } else {
        info!("apply_full_update success");
    }
    Ok(())
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
    info!(
        "fallback_update called: extract_dir={}, target_dir={}, new_version={}",
        extract_dir, target_dir, new_version
    );

    let target_path = std::path::Path::new(&target_dir);

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

    // 复制解压的新文件到兜底目录
    copy_dir_contents(
        &extract_dir,
        final_fallback_dir.to_str().unwrap_or(""),
        Some(&["changes.json"]),
    )?;

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

#[cfg(test)]
mod incremental_update_tests {
    use super::*;

    fn tree(root: &std::path::Path) -> Vec<(std::path::PathBuf, String)> {
        relative_files(root)
            .unwrap()
            .into_iter()
            .map(|r| {
                let text = std::fs::read_to_string(root.join(&r)).unwrap();
                (r, text)
            })
            .collect()
    }

    fn setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("mxu-incr-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (target, extract) = (root.join("install"), root.join("extract"));
        std::fs::create_dir_all(target.join("sub")).unwrap();
        std::fs::create_dir_all(extract.join("sub")).unwrap();
        std::fs::write(target.join("a.txt"), "old a").unwrap();
        std::fs::write(target.join("gone.txt"), "old gone").unwrap();
        std::fs::write(target.join("sub/b.txt"), "old b").unwrap();
        std::fs::write(extract.join("a.txt"), "new a").unwrap();
        std::fs::write(extract.join("sub/b.txt"), "new b").unwrap();
        std::fs::write(extract.join("sub/c.txt"), "new c").unwrap();
        std::fs::write(extract.join("changes.json"), "{}").unwrap();
        (root.clone(), target, extract)
    }

    fn sha_of(root: &std::path::Path, text: &str) -> String {
        std::fs::write(root.join("probe"), text).unwrap();
        sha256_file(&root.join("probe")).unwrap()
    }

    #[test]
    fn applies_the_patch() {
        let (root, target, extract) = setup("ok");
        apply_incremental(
            &extract,
            &target,
            &["gone.txt".into()],
            &root.join("backup"),
        )
        .unwrap();
        let p = |s: &str| std::path::PathBuf::from_iter(s.split('/'));
        assert_eq!(
            tree(&target),
            vec![
                (p("a.txt"), "new a".to_string()),
                (p("sub/b.txt"), "new b".to_string()),
                (p("sub/c.txt"), "new c".to_string()),
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failing_midway_puts_everything_back() {
        let (root, target, extract) = setup("fail");
        // 安装目录里 z 是文件、增量包里是文件夹：写 z/x.txt 失败时，
        // gone.txt 已移走，a.txt、sub/b.txt、sub/c.txt 已写入
        std::fs::write(target.join("z"), "old z").unwrap();
        std::fs::create_dir_all(extract.join("z")).unwrap();
        std::fs::write(extract.join("z").join("x.txt"), "new x").unwrap();
        let before = tree(&target);

        let r = apply_incremental(
            &extract,
            &target,
            &["gone.txt".into()],
            &root.join("backup"),
        );
        assert!(r.is_err());
        assert_eq!(tree(&target), before);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_base_file_stops_the_patch_before_anything_is_touched() {
        let (root, target, extract) = setup("base");
        let base = serde_json::json!({
            "a.txt": sha_of(&root, "old a"),
            "sub/b.txt": sha_of(&root, "old b"),
        });
        std::fs::write(
            extract.join("changes.json"),
            serde_json::json!({ "modified": ["a.txt", "sub/b.txt"], "base": base }).to_string(),
        )
        .unwrap();

        // 用户改过 sub/b.txt：不做任何改动，错误信息列出该文件
        std::fs::write(target.join("sub/b.txt"), "edited b").unwrap();
        let before = tree(&target);
        let err = apply_incremental(
            &extract,
            &target,
            &["gone.txt".into()],
            &root.join("backup"),
        )
        .unwrap_err();
        assert!(err.contains("sub/b.txt"), "{err}");
        assert_eq!(tree(&target), before);

        // 改回旧版本内容后可以正常应用
        std::fs::write(target.join("sub/b.txt"), "old b").unwrap();
        apply_incremental(
            &extract,
            &target,
            &["gone.txt".into()],
            &root.join("backup2"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("sub/b.txt")).unwrap(),
            "new b"
        );

        // 缺失的文件也算不一致
        std::fs::remove_file(target.join("a.txt")).unwrap();
        let only_a: std::collections::HashMap<_, _> =
            [("a.txt".to_string(), sha_of(&root, "old a"))]
                .into_iter()
                .collect();
        assert_eq!(
            files_not_at_base(&target, &only_a),
            vec!["a.txt".to_string()]
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
