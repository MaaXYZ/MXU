//! 系统通知命令
//!
//! 供需要通过 Tauri 命令发送系统通知的调用方使用。
//! 特殊任务和前端共用发送入口，Windows 支持无需安装的独立 EXE。

use tauri::AppHandle;
#[cfg(not(any(windows, target_os = "macos")))]
use tauri_plugin_notification::NotificationExt;

#[cfg(any(target_os = "macos", test))]
mod badge;
#[cfg(windows)]
mod branding;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub(crate) fn initialize_macos_notifications(app: &AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app = app.clone();
    macos::start_badge_monitor(move |count| {
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                let badge = (count > 0).then_some(count.min(i64::MAX as usize) as i64);
                if let Err(error) = window.set_badge_count(badge) {
                    log::warn!("[MXU_NOTIFY] Failed to update Dock badge: {error}");
                }
            }
        }) {
            log::warn!("[MXU_NOTIFY] Failed to schedule Dock badge update: {error}");
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn mark_macos_notifications_read() {
    macos::mark_all_read();
}

#[cfg(target_os = "macos")]
pub(crate) fn shutdown_macos_notifications() {
    macos::stop_badge_monitor();
}

/// 发送系统通知
///
/// 注意：标题与正文可能包含任务数据，出于日志敏感信息与日志伪造（换行注入）考虑，
/// 不将其写入持久化日志，仅记录发送结果。
#[tauri::command]
pub async fn send_system_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    // macOS 授权和发送会等待系统回调，不能阻塞主线程的事件循环。
    tauri::async_runtime::spawn_blocking(move || send_notification(&app, &title, &body))
        .await
        .map_err(|e| format!("Notification worker failed: {e}"))?
}

pub(crate) fn send_notification(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let result = show_notification(app, title, body);
    match &result {
        Ok(()) => log::debug!("[MXU_NOTIFY] Notification submitted successfully"),
        Err(e) => log::error!("[MXU_NOTIFY] Failed to send notification: {}", e),
    }
    result
}

#[cfg(windows)]
fn show_notification(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let identity = branding::resolve(app)?;
    windows::show(
        &identity.app_id,
        &identity.name,
        &identity.icon,
        title,
        body,
    )
}

#[cfg(target_os = "macos")]
fn show_notification(_app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    macos::show(title, body)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_notification(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
