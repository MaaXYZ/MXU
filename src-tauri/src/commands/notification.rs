//! 系统通知命令
//!
//! 供前端 focus 的 `toast` / `notification` 渠道调用。
//! WebView2 下 Web Notification API 的权限恒为 `denied` 且无权限弹窗，
//! 因此桌面端通知统一经由本命令走 `notify-rust` 直接调用系统能力。

use notify_rust::Notification;

/// 发送系统通知
///
/// 注意：标题与正文可能包含任务数据，出于日志敏感信息与日志伪造（换行注入）考虑，
/// 不将其写入持久化日志，仅记录发送结果。
#[tauri::command]
pub fn send_system_notification(title: String, body: String) -> Result<(), String> {
    Notification::new()
        .summary(&title)
        .body(&body)
        .show()
        .map(|_| {
            log::debug!("[MXU_NOTIFY] Notification sent successfully");
        })
        .map_err(|e| {
            log::error!("[MXU_NOTIFY] Failed to send notification: {}", e);
            e.to_string()
        })
}
