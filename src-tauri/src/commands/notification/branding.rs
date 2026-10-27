use std::{
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
    // 项目分别注册身份，避免同时运行不同项目时互相覆盖通知名称和图标。
    let name_hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    let app_id = format!(
        "{}.notifications.{}",
        app.config().identifier,
        &name_hash[..16]
    );
    Ok(Identity { app_id, name, icon })
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
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
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
            image::open(&custom).unwrap().to_rgba8().get_pixel(0, 0).0,
            [255, 0, 0, 255]
        );
        let default = cache_icon(None, &cache).unwrap();
        assert_ne!(custom, default);
        std::fs::write(&project_icon, b"not an icon").unwrap();
        assert_eq!(cache_icon(Some(&project_icon), &cache).unwrap(), default);
        assert!(default.is_absolute());
        assert!(!default.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(default.extension().unwrap(), "png");
    }
}
