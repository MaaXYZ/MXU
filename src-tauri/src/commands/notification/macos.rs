//! 使用实际 .app 的身份和现代 UserNotifications 接口，不替换 NSBundle 标识。

use std::ptr::NonNull;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{Bool, ProtocolObject},
    sel, AnyThread,
};
use objc2_foundation::{
    NSArray, NSBundle, NSDate, NSError, NSObject, NSObjectProtocol, NSString, NSUUID,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSetting, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use super::badge::{BadgeState, DeliveredNotification, ReadAction};

enum BadgeCommand {
    Refresh,
    ReadThrough(f64),
    ReadOne(String),
    Stop,
}

static BADGE_COMMANDS: Mutex<Option<mpsc::Sender<BadgeCommand>>> = Mutex::new(None);

fn badge_command(command: BadgeCommand) {
    if let Ok(guard) = BADGE_COMMANDS.lock() {
        if let Some(sender) = guard.as_ref() {
            let _ = sender.send(command);
        }
    }
}

pub(super) fn mark_all_read() {
    badge_command(BadgeCommand::ReadThrough(
        NSDate::timeIntervalSinceReferenceDate_class(),
    ));
}

pub(super) fn stop_badge_monitor() {
    if let Ok(mut guard) = BADGE_COMMANDS.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(BadgeCommand::Stop);
        }
    }
}

fn delivered_notifications() -> Result<Vec<DeliveredNotification>, String> {
    let (tx, rx) = mpsc::channel();
    UNUserNotificationCenter::currentNotificationCenter()
        .getDeliveredNotificationsWithCompletionHandler(&RcBlock::new(
            move |notifications: NonNull<NSArray<UNNotification>>| {
                // SAFETY: 系统在此回调期间保证数组有效，只复制标识和实际送达时间。
                let notifications = unsafe { notifications.as_ref() };
                let identifiers = (0..notifications.count())
                    .map(|index| {
                        let notification = notifications.objectAtIndex(index);
                        DeliveredNotification {
                            id: notification.request().identifier().to_string(),
                            delivered_at: notification.date().timeIntervalSinceReferenceDate(),
                        }
                    })
                    .collect();
                let _ = tx.send(identifiers);
            },
        ));
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to query delivered notifications: {e}"))
}

fn badge_allowed() -> Result<bool, String> {
    let (tx, rx) = mpsc::channel();
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&RcBlock::new(
            move |settings: NonNull<UNNotificationSettings>| {
                // SAFETY: 系统在此回调期间保证设置对象有效。
                let settings = unsafe { settings.as_ref() };
                let authorized = matches!(
                    settings.authorizationStatus(),
                    UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional
                );
                let _ = tx
                    .send(authorized && settings.badgeSetting() == UNNotificationSetting::Enabled);
            },
        ));
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to query badge authorization: {e}"))
}

fn set_system_badge(count: usize) -> Result<(), String> {
    let center = UNUserNotificationCenter::currentNotificationCenter();
    // 旧 macOS 没有此方法时，由调用方使用 Dock API 显示同一计数。
    if !center.respondsToSelector(sel!(setBadgeCount:withCompletionHandler:)) {
        return Ok(());
    }
    let bundle_id = NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string())
        .unwrap_or_default();
    let (tx, rx) = mpsc::channel();
    center.setBadgeCount_withCompletionHandler(
        count.min(isize::MAX as usize) as isize,
        Some(&RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(
                callback_error("badge synchronization", &bundle_id, error).map_or(Ok(()), Err),
            );
        })),
    );
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Failed to update system notification badge: {e}"))?
}

pub(super) fn start_badge_monitor(
    update_dock: impl Fn(usize) + Send + 'static,
) -> Result<(), String> {
    let mut commands = BADGE_COMMANDS.lock().map_err(|e| e.to_string())?;
    if commands.is_some() {
        return Ok(());
    }
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        return Err("macOS badge synchronization requires an .app bundle".into());
    }
    install_delegate(&UNUserNotificationCenter::currentNotificationCenter());
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new().name("mxu-notification-badge".into()).spawn(move || {
        let mut state = BadgeState::default();
        let mut last_badge = None;
        let mut command = BadgeCommand::Refresh;
        loop {
            let action = match command {
                BadgeCommand::Refresh => ReadAction::None,
                BadgeCommand::ReadThrough(cutoff) => ReadAction::Through(cutoff),
                BadgeCommand::ReadOne(id) => ReadAction::One(id),
                BadgeCommand::Stop => break,
            };
            // 查询和写入串行完成，避免旧的异步结果把刚清除的角标重新写回。
            let result = autoreleasepool(|_| -> Result<(), String> {
                let unread = state.synchronize(delivered_notifications()?, action);
                let allowed = badge_allowed()?;
                let count = if allowed { unread } else { 0 };
                if last_badge != Some((count, allowed)) {
                    if allowed {
                        if let Err(error) = set_system_badge(count) {
                            if count == 0 { update_dock(0); }
                            return Err(error);
                        }
                    }
                    update_dock(count);
                    last_badge = Some((count, allowed));
                    log::debug!("[MXU_NOTIFY] Notification badge synchronized: unread={unread}, badge={count}, allowed={allowed}");
                }
                Ok(())
            });
            if let Err(error) = result { log::warn!("[MXU_NOTIFY] Badge synchronization failed: {error}"); }
            // “全部清除”并不保证逐条触发 dismiss 回调，定期核对通知中心的实际记录。
            command = match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => BadgeCommand::Refresh,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
        }
    }).map_err(|e| format!("Failed to start notification badge monitor: {e}"))?;
    *commands = Some(tx);
    Ok(())
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "MXUNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::Badge,));
            badge_command(BadgeCommand::Refresh);
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            completion.call(());
            badge_command(BadgeCommand::ReadOne(id));
        }
    }
);

fn install_delegate(center: &UNUserNotificationCenter) {
    // UNUserNotificationCenter 仅弱引用 delegate，必须保留至进程结束。
    static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();
    let delegate = DELEGATE.get_or_init(|| {
        let this = NotificationDelegate::alloc().set_ivars(());
        // SAFETY: 初始化新分配的 NSObject 子类，匹配其 init 的所有权约定。
        unsafe { msg_send![super(this), init] }
    });
    center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
}

fn content(title: &str, body: &str) -> Retained<UNMutableNotificationContent> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    // 不把固定的 1 写入系统：角标由通知中心实际记录和已读状态同步。
    content
}

fn callback_error(stage: &str, bundle_id: &str, error: *mut NSError) -> Option<String> {
    // SAFETY: 系统 completion handler 的 NSError 指针在回调期间有效，且允许为 nil。
    unsafe { error.as_ref() }.map(|e| {
        let domain = e.domain().to_string();
        let code = e.code();
        let mut message = format!(
            "macOS notification {stage} failed: bundle={bundle_id}, domain={domain}, code={code}: {}",
            e.localizedDescription()
        );
        if domain == "UNErrorDomain" && code == 1 {
            message.push_str(
                "; notifications are not allowed. If the executable was replaced, verify the .app layout and signature (scripts/macos-resign.mjs --repair-layout), then relaunch it. Otherwise check notification authorization for this bundle."
            );
        }
        message
    })
}

/// 仅从工作线程调用：等待授权/提交回调期间，Tauri 主线程继续处理系统事件。
pub(super) fn show(title: &str, body: &str) -> Result<(), String> {
    let bundle = NSBundle::mainBundle();
    let bundle_id = bundle
        .bundleIdentifier()
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
        .ok_or("macOS notifications require an .app bundle with CFBundleIdentifier")?;
    log::debug!(
        "[MXU_NOTIFY] macOS notification identity: bundle={}, path={}",
        bundle_id,
        bundle.bundlePath()
    );
    let center = UNUserNotificationCenter::currentNotificationCenter();
    install_delegate(&center);

    let (tx, rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let callback_cancelled = cancelled.clone();
    let title = title.to_owned();
    let body = body.to_owned();
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge,
        &RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if callback_cancelled.load(Ordering::Acquire) {
                return;
            }
            if let Some(error) = callback_error("authorization", &bundle_id, error) {
                let _ = tx.send(Err(error));
                return;
            }
            if !granted.as_bool() {
                let _ = tx.send(Err(format!(
                    "macOS notification authorization was denied: bundle={bundle_id}"
                )));
                return;
            }
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSUUID::UUID().UUIDString(),
                &content(&title, &body),
                None,
            );
            let completion_tx = tx.clone();
            let completion_bundle_id = bundle_id.clone();
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(
                    &request,
                    Some(&RcBlock::new(move |error: *mut NSError| {
                        let result = callback_error("submission", &completion_bundle_id, error)
                            .map_or(Ok(()), Err);
                        if result.is_ok() {
                            badge_command(BadgeCommand::Refresh);
                        }
                        let _ = completion_tx.send(result);
                    })),
                );
        }),
    );
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(result) => result,
        Err(error) => {
            cancelled.store(true, Ordering::Release);
            Err(format!("Timed out waiting for macOS notification: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_uses_sound_without_overwriting_the_synchronized_badge() {
        let notification = content("MXU", "任务完成");
        assert_eq!(notification.title().to_string(), "MXU");
        assert_eq!(notification.body().to_string(), "任务完成");
        assert!(notification.sound().is_some());
        assert!(notification.badge().is_none());
    }
}
