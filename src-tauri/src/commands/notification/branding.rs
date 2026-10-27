use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use image::ImageFormat;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::AppConfigState;

const DEFAULT_ICON: &[u8] = include_bytes!("../../../icons/icon.png");
static ICON_CACHE_LOCK: Mutex<()> = Mutex::new(());

pub(super) struct Identity {
    pub app_id: String,
    pub name: String,
    pub icon: PathBuf,
}

pub(super) fn resolve(app: &AppHandle) -> Result<Identity, String> {
    let mut name = "mxu".to_string();
    let mut icon_path = None;
    let mut project_root = crate::commands::utils::get_exe_directory()?;
    if let Some(state) = app.try_state::<Arc<AppConfigState>>() {
        let (project_name, project_icon) = {
            let interface = state.project_interface.lock().map_err(|e| e.to_string())?;
            let field = |key| {
                interface
                    .as_ref()
                    .and_then(|v| v.get(key))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            };
            (field("name"), field("icon"))
        };
        name = display_name(project_name.as_deref()).to_string();
        let base_path = PathBuf::from(state.base_path.lock().map_err(|e| e.to_string())?.clone());
        if !base_path.as_os_str().is_empty() {
            project_root = base_path.clone();
        }
        let preference = state
            .config
            .lock()
            .map_err(|e| e.to_string())?
            .pointer("/settings/language")
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string();
        let locale = if preference == "system" {
            system_locale()
        } else {
            preference
        };
        let translations = state.translations.lock().map_err(|e| e.to_string())?;
        icon_path = project_icon_path(
            project_icon.as_deref(),
            translations.get(interface_language(&locale)),
            &base_path,
        );
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("notification-icons");
    let icon = cache_icon(icon_path.as_deref(), &cache)?;
    let app_id = application_id(&app.config().identifier, &project_root)?;
    Ok(Identity { app_id, name, icon })
}

fn application_id(identifier: &str, project_root: &Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    // 项目目录决定身份；同名项目互不覆盖，修改名称或图标不丢失系统通知设置。
    let root = dunce::canonicalize(project_root).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    for unit in root.as_os_str().encode_wide() {
        hash.update(unit.to_le_bytes());
    }
    Ok(format!(
        "{identifier}.notifications.{:.16}",
        format!("{:x}", hash.finalize())
    ))
}

fn display_name(name: Option<&str>) -> &str {
    name.map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("mxu")
}

fn interface_language(locale: &str) -> &'static str {
    match locale.to_ascii_lowercase().replace('-', "_").as_str() {
        "zh_tw" => "zh_tw",
        lang if lang.starts_with("zh") => "zh_cn",
        lang if lang.starts_with("ja") => "ja_jp",
        lang if lang.starts_with("ko") => "ko_kr",
        _ => "en_us",
    }
}

fn system_locale() -> String {
    // 锁定的 WinSafe 0.0.28 未封装这两个 API，保留最小的 windows 调用。
    use windows::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName};
    let mut buffer = [0u16; 85];
    // SAFETY: 使用当前用户的 UI 语言，输出缓冲区有效且长度已传给 Windows。
    let len =
        unsafe { LCIDToLocaleName(u32::from(GetUserDefaultUILanguage()), Some(&mut buffer), 0) };
    if len > 0 {
        String::from_utf16_lossy(&buffer[..len as usize - 1])
    } else {
        "en-US".into()
    }
}

fn project_icon_path(
    icon: Option<&str>,
    translations: Option<&serde_json::Value>,
    base: &Path,
) -> Option<PathBuf> {
    let icon = icon?.trim();
    let icon = if let Some(key) = icon.strip_prefix('$') {
        translations?.get(key)?.as_str()?
    } else {
        icon
    };
    if icon.is_empty() {
        return None;
    }
    // 来源图标只接受项目内的 PNG/ICO；网页图标支持的 URL/SVG 不适用于此入口。
    if !Path::new(icon)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png") || ext.eq_ignore_ascii_case("ico"))
        || icon.starts_with("https://")
        || icon.starts_with("http://")
    {
        log::warn!(
            "[MXU_NOTIFY] Notification source icons require a local PNG or ICO; using MXU icon"
        );
        return None;
    }
    let base = base.canonicalize().ok()?;
    let path = base.join(icon).canonicalize().ok()?;
    (path.starts_with(base) && path.is_file()).then_some(path)
}

pub(super) fn cache_icon(project_icon: Option<&Path>, cache: &Path) -> Result<PathBuf, String> {
    let image = project_icon
        .and_then(|path| match image::open(path) {
            Ok(image) => Some(image),
            Err(e) => {
                log::warn!(
                    "[MXU_NOTIFY] Cannot load project notification icon, using MXU icon: {e}"
                );
                None
            }
        })
        .map(Ok)
        .unwrap_or_else(|| image::load_from_memory(DEFAULT_ICON))
        .map_err(|e| format!("Failed to decode notification icon: {e}"))?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .thumbnail(256, 256)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let bytes = png.into_inner();
    let filename = format!("{:x}.png", Sha256::digest(&bytes));
    let _guard = ICON_CACHE_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let path = cache.join(filename);
    // 内容寻址的缓存必须与预期 PNG 字节一致，不能信任旧版本留下的截断文件。
    if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        let mut temporary = tempfile::NamedTempFile::new_in(cache).map_err(|e| e.to_string())?;
        temporary.write_all(&bytes).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(&path).map_err(|e| e.to_string())?;
    }
    // Shell 图标资源使用普通绝对路径，避免把 Windows verbatim 前缀当成 URI。
    dunce::canonicalize(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mxu-notification-{}-{}",
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
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn uses_project_name_or_mxu() {
        assert_eq!(display_name(Some("MaaEnd")), "MaaEnd");
        assert_eq!(display_name(Some("  ")), "mxu");
        assert_eq!(display_name(None), "mxu");
    }

    #[test]
    fn project_identity_uses_the_directory_and_resolves_aliases() {
        let first = TestDir::new();
        let second = TestDir::new();
        let id = application_id("com.misteo.mxu", &first.0).unwrap();
        assert_ne!(id, application_id("com.misteo.mxu", &second.0).unwrap());
        assert_eq!(
            id,
            application_id("com.misteo.mxu", &first.0.join(".")).unwrap()
        );
    }

    #[test]
    fn localized_project_icon_is_resolved_inside_project() {
        let temp = TestDir::new();
        let icon = temp.0.join("logo.png");
        std::fs::write(&icon, DEFAULT_ICON).unwrap();
        let translations = serde_json::json!({"logo": "logo.png"});
        assert_eq!(
            project_icon_path(Some("$logo"), Some(&translations), &temp.0),
            Some(icon.canonicalize().unwrap())
        );
        assert!(project_icon_path(Some("$missing"), Some(&translations), &temp.0).is_none());
        assert!(project_icon_path(Some("missing.png"), None, &temp.0).is_none());
        std::fs::write(temp.0.join("logo.svg"), b"<svg/>").unwrap();
        assert!(project_icon_path(Some("logo.svg"), None, &temp.0).is_none());
        assert!(project_icon_path(Some("https://example.com/logo.png"), None, &temp.0).is_none());
    }

    #[test]
    fn caches_project_icon_as_png_and_falls_back_on_invalid_icon() {
        let temp = TestDir::new();
        let cache = temp.0.join("cache");
        let project_icon = temp.0.join("logo.ico");
        image::RgbaImage::from_pixel(32, 32, image::Rgba([255, 0, 0, 255]))
            .save(&project_icon)
            .unwrap();
        let custom = cache_icon(Some(&project_icon), &cache).unwrap();
        assert_eq!(
            image::load_from_memory_with_format(&std::fs::read(&custom).unwrap(), ImageFormat::Png)
                .unwrap()
                .to_rgba8()
                .get_pixel(0, 0)
                .0,
            [255, 0, 0, 255]
        );
        let default = cache_icon(None, &cache).unwrap();
        assert_ne!(custom, default);
        std::fs::write(&project_icon, b"not an icon").unwrap();
        assert_eq!(cache_icon(Some(&project_icon), &cache).unwrap(), default);
        assert!(default.is_absolute());
        assert!(!default.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(default.extension().unwrap(), "png");
        image::load_from_memory_with_format(&std::fs::read(&default).unwrap(), ImageFormat::Png)
            .unwrap();
    }

    #[test]
    fn repairs_truncated_and_wrong_format_cache_entries() {
        let temp = TestDir::new();
        let path = cache_icon(None, &temp.0).unwrap();
        let expected = std::fs::read(&path).unwrap();
        let mut ico = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(16, 16)
            .write_to(&mut ico, ImageFormat::Ico)
            .unwrap();
        for damaged in [expected[..8].to_vec(), ico.into_inner()] {
            std::fs::write(&path, damaged).unwrap();
            assert_eq!(cache_icon(None, &temp.0).unwrap(), path);
            assert_eq!(std::fs::read(&path).unwrap(), expected);
        }
    }
}
