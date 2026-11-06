//! Tauri 通知插件按 EXE 路径推断是否已安装，且丢弃异步发送错误。
//! MXU 以独立 EXE 发布，因此显式注册 AUMID，并直接获取 WinRT 发送结果。

use std::path::Path;
use windows::{
    core::{Ref, HRESULT, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::Foundation::ERROR_NOT_FOUND,
    UI::Notifications::{
        NotificationSetting, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
    },
};
use winsafe::{co, RegistryValue, HKEY};

fn registration_path(app_id: &str) -> String {
    format!(r"Software\Classes\AppUserModelId\{app_id}")
}

fn register_application(app_id: &str, display_name: &str, icon: &Path) -> Result<(), String> {
    let (key, _) = HKEY::CURRENT_USER
        .RegCreateKeyEx(
            &registration_path(app_id),
            None,
            co::REG_OPTION::NON_VOLATILE,
            co::KEY::SET_VALUE,
            None,
        )
        .map_err(|e| format!("Failed to register notification application: {e}"))?;
    // Windows Shell 按 REG_EXPAND_SZ 读取显示资源；REG_SZ 可能回退为 AUMID。
    key.RegSetValueEx(
        Some("DisplayName"),
        RegistryValue::ExpandSz(display_name.into()),
    )
    .map_err(|e| format!("Failed to set notification application name: {e}"))?;
    key.RegSetValueEx(
        Some("IconUri"),
        RegistryValue::ExpandSz(icon.to_string_lossy().into_owned()),
    )
    .map_err(|e| format!("Failed to set notification application icon: {e}"))?;
    // 仅注册应用身份，不改写用户的通知开关。
    Ok(())
}

fn notification_xml(title: &str, body: &str) -> windows::core::Result<XmlDocument> {
    // windows-core 0.61 的工厂激活会在 CO_E_NOTINITIALIZED 时通过
    // CoIncrementMTAUsage 初始化隐式 MTA；无需改变调用线程已有的 apartment。
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(
        r#"<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>"#,
    ))?;
    let text_nodes = xml.GetElementsByTagName(&HSTRING::from("text"))?;
    for (index, text) in [title, body].iter().enumerate() {
        // 使用文本节点，避免任务内容中的 XML 特殊字符被解释为标记。
        text_nodes
            .Item(index as u32)?
            .AppendChild(&xml.CreateTextNode(&HSTRING::from(*text))?)?;
    }
    Ok(xml)
}

pub(super) fn show(
    app_id: &str,
    display_name: &str,
    icon: &Path,
    title: &str,
    body: &str,
) -> Result<(), String> {
    register_application(app_id, display_name, icon)?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .map_err(|e| format!("Failed to create Windows notifier: {e}"))?;
    match notifier.Setting() {
        Ok(NotificationSetting::Enabled) => {}
        Ok(setting) => return Err(format!("Windows notifications are disabled: {setting:?}")),
        // 独立 EXE 首次发送之前，Windows 尚未创建通知设置记录。
        Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => {}
        Err(e) => {
            return Err(format!(
                "Failed to query Windows notification settings: {e}"
            ))
        }
    }

    let xml = notification_xml(title, body).map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&xml).map_err(|e| e.to_string())?;
    toast
        .Failed(&TypedEventHandler::new(
            |_, args: Ref<'_, ToastFailedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    log::error!(
                        "[MXU_NOTIFY] Windows rejected notification: {:?}",
                        args.ErrorCode()
                    );
                }
                Ok(())
            },
        ))
        .map_err(|e| e.to_string())?;
    notifier
        .Show(&toast)
        .map_err(|e| format!("Failed to show Windows notification: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winrt_activation_works_on_fresh_workers_and_with_cached_factories() {
        // 不在测试中预先初始化 COM，覆盖 spawn_blocking / Maa 回调线程的实际入口。
        for _ in 0..2 {
            std::thread::spawn(|| {
                let xml = notification_xml("worker", "notification").unwrap();
                let _toast = ToastNotification::CreateToastNotification(&xml).unwrap();
                let _notifier = ToastNotificationManager::CreateToastNotifierWithId(
                    &HSTRING::from("com.misteo.mxu.worker-test"),
                )
                .unwrap();
            })
            .join()
            .unwrap();
        }
    }

    #[test]
    fn notification_text_preserves_unicode_and_xml_characters() {
        let title = "任务完成 <MXU> & \"通知\" 😀";
        let body = "第一行\n第二行 </text><image src='file:///x'/>";
        let xml = notification_xml(title, body).unwrap();
        let texts = xml.GetElementsByTagName(&HSTRING::from("text")).unwrap();
        assert_eq!(texts.Length().unwrap(), 2);
        assert_eq!(
            texts.Item(0).unwrap().InnerText().unwrap().to_string(),
            title
        );
        assert_eq!(
            texts.Item(1).unwrap().InnerText().unwrap().to_string(),
            body
        );
        assert_eq!(
            xml.GetElementsByTagName(&HSTRING::from("image"))
                .unwrap()
                .Length()
                .unwrap(),
            0
        );
    }

    #[test]
    fn notification_accepts_empty_body() {
        let xml = notification_xml("MXU", "").unwrap();
        let texts = xml.GetElementsByTagName(&HSTRING::from("text")).unwrap();
        assert_eq!(texts.Item(1).unwrap().InnerText().unwrap().to_string(), "");
    }

    #[test]
    #[ignore = "Requires an interactive Windows desktop and displays a notification"]
    fn portable_notification_reaches_windows_history() {
        struct TestApplication(String);
        impl Drop for TestApplication {
            fn drop(&mut self) {
                if let Ok(history) = ToastNotificationManager::History() {
                    let _ = history.ClearWithId(&HSTRING::from(&self.0));
                }
                // 只清理本次测试创建的唯一应用身份。
                let _ = HKEY::CURRENT_USER.RegDeleteTree(Some(&registration_path(&self.0)));
                let _ = std::fs::remove_dir_all(std::env::temp_dir().join(&self.0));
            }
        }

        let app = TestApplication(format!(
            "com.misteo.mxu.test.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let title = "Notification regression test";
        let body = "Portable EXE: 中文 <test> & notification";
        let icon =
            super::super::branding::cache_icon(None, &std::env::temp_dir().join(&app.0)).unwrap();
        show(&app.0, "MXU notification test", &icon, title, body).unwrap();
        let key = HKEY::CURRENT_USER
            .RegOpenKeyEx(
                Some(&registration_path(&app.0)),
                co::REG_OPTION::NoValue,
                co::KEY::QUERY_VALUE,
            )
            .unwrap();
        assert!(matches!(key.RegQueryValueEx(Some("DisplayName")).unwrap(),
            RegistryValue::ExpandSz(value) if value == "MXU notification test"));
        assert!(matches!(key.RegQueryValueEx(Some("IconUri")).unwrap(),
            RegistryValue::ExpandSz(value) if value == icon.to_string_lossy()));

        let history = ToastNotificationManager::History().unwrap();
        for _ in 0..50 {
            let notifications = history.GetHistoryWithId(&HSTRING::from(&app.0)).unwrap();
            if notifications.Size().unwrap() > 0 {
                let content = notifications.GetAt(0).unwrap().Content().unwrap();
                let texts = content
                    .GetElementsByTagName(&HSTRING::from("text"))
                    .unwrap();
                assert_eq!(
                    texts.Item(0).unwrap().InnerText().unwrap().to_string(),
                    title
                );
                assert_eq!(
                    texts.Item(1).unwrap().InnerText().unwrap().to_string(),
                    body
                );
                if std::env::var_os("MXU_NOTIFICATION_PREVIEW").is_some() {
                    eprintln!("Notification preview is visible for 15 seconds");
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("Notification was not delivered to Windows notification history");
    }
}
