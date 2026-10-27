use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

/// 全局设置：关闭时是否最小化到托盘
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// 全局托盘图标引用，用于动态更新图标
static TRAY_ICON: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();

/// 设置最小化到托盘选项
pub fn set_minimize_to_tray(enabled: bool) {
    MINIMIZE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// 获取最小化到托盘选项
pub fn get_minimize_to_tray() -> bool {
    MINIMIZE_TO_TRAY.load(Ordering::SeqCst)
}

/// 初始化系统托盘
pub fn init_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 创建托盘菜单项
    let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let start_i = MenuItem::with_id(app, "start", "开始任务", true, None::<&str>)?;
    let stop_i = MenuItem::with_id(app, "stop", "停止任务", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_i, &start_i, &stop_i, &quit_i])?;

    // 获取图标
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap());

    // 创建托盘图标
    let tray = TrayIconBuilder::<Wry>::new()
        .icon(icon)
        .tooltip("MXU")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => {
                    show_main_window(app);
                }
                "start" => {
                    // 发送开始任务事件到前端
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("tray-start-tasks", ());
                    }
                }
                "stop" => {
                    // 发送停止任务事件到前端
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit("tray-stop-tasks", ());
                    }
                }
                "quit" => {
                    // 真正退出应用
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击显示窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // 保存托盘引用，用于后续动态更新图标
    let tray_mutex = TRAY_ICON.get_or_init(|| Mutex::new(None));
    let mut guard = tray_mutex.lock().map_err(|e| {
        log::error!("Failed to lock tray mutex during init: {}", e);
        format!("Failed to initialize tray: {}", e)
    })?;
    *guard = Some(tray);

    Ok(())
}

/// 显示主窗口
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 处理窗口关闭请求，返回 true 表示应该阻止关闭（最小化到托盘）
pub fn handle_close_requested(app: &AppHandle) -> bool {
    if get_minimize_to_tray() {
        // 最小化到托盘而不是关闭
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        true // 阻止关闭
    } else {
        false // 允许关闭
    }
}

/// 更新托盘图标
/// icon_path: 图标文件的相对路径（相对于 exe 目录）
pub fn update_tray_icon(icon_path: &str) -> Result<(), String> {
    // 路径安全校验：禁止路径遍历
    if icon_path.contains("..") {
        return Err("Invalid icon path: path traversal not allowed".to_string());
    }

    // 获取 exe 目录
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or("Failed to get exe directory")?
        .to_path_buf();

    let full_path = exe_dir.join(icon_path);

    // 校验最终路径是否在 exe 目录内
    let canonical_path = full_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve icon path: {}", e))?;
    let canonical_exe_dir = exe_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve exe directory: {}", e))?;

    let allowed = canonical_path.starts_with(&canonical_exe_dir);
    #[cfg(target_os = "macos")]
    let allowed = allowed
        || crate::commands::utils::get_macos_bundle_resource_dir(&exe_dir)
            .is_some_and(|resources| canonical_path.starts_with(resources));
    if !allowed {
        return Err("Invalid icon path: must be within application directory".to_string());
    }

    // 读取图标文件
    let icon_data = std::fs::read(&canonical_path)
        .map_err(|e| format!("Failed to read icon file {:?}: {}", canonical_path, e))?;

    // 创建图标
    let icon = Image::from_bytes(&icon_data).map_err(|e| format!("Failed to parse icon: {}", e))?;

    // 更新托盘图标
    let tray_mutex = TRAY_ICON.get_or_init(|| Mutex::new(None));
    let guard = tray_mutex
        .lock()
        .map_err(|e| format!("Failed to lock tray mutex: {}", e))?;

    if let Some(tray) = guard.as_ref() {
        tray.set_icon(Some(icon))
            .map_err(|e| format!("Failed to set tray icon: {}", e))?;
        log::info!("Tray icon updated: {}", icon_path);
        Ok(())
    } else {
        Err("Tray icon not initialized".to_string())
    }
}

/// 更新托盘 tooltip
pub fn update_tray_tooltip(tooltip: &str) -> Result<(), String> {
    let tray_mutex = TRAY_ICON.get_or_init(|| Mutex::new(None));
    let guard = tray_mutex
        .lock()
        .map_err(|e| format!("Failed to lock tray mutex: {}", e))?;

    if let Some(tray) = guard.as_ref() {
        tray.set_tooltip(Some(tooltip))
            .map_err(|e| format!("Failed to set tray tooltip: {}", e))?;
        log::info!("Tray tooltip updated: {}", tooltip);
        Ok(())
    } else {
        Err("Tray icon not initialized".to_string())
    }
}
