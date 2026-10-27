//! 更新安装相关命令
//!
//! 提供解压、增量/全量更新、文件移动等功能

use log::{info, warn};

use super::file_ops::get_exe_dir;
use super::types::ChangesJson;

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

/// 解压压缩文件到指定目录，支持 zip 和 tar.gz/tgz 格式
#[tauri::command]
pub fn extract_zip(zip_path: String, dest_dir: String) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&dest_dir))?;
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
    ensure_update_path(source)?;
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
/// 即使移动旧文件失败，也会继续复制新文件，确保程序可用
#[tauri::command]
pub fn apply_full_update(extract_dir: String, target_dir: String) -> Result<(), String> {
    ensure_update_path(std::path::Path::new(&target_dir))?;
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
            extract_zip(missing_archive.clone(), target_string.clone()),
            apply_incremental_update(
                missing_archive.clone(),
                target_string.clone(),
                vec!["interface.json".into()],
            ),
            apply_full_update(missing_archive.clone(), target_string.clone()),
            fallback_update(missing_archive, target_string.clone(), "2".into()).map(|_| ()),
            cleanup_extract_dir(target_string.clone()),
            cleanup_update_artifacts(target_string.clone(), target_string),
            move_to_old_folder(&target.join("interface.json")),
        ] {
            assert_eq!(result.unwrap_err(), "SIGNED_APP_UPDATE_UNSUPPORTED");
        }
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
