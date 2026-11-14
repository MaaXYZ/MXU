//! Shared discovery/connection/submission checks. Never ignore an invalid filter.
use regex::Regex;

use super::types::{ControllerConfig, InstanceRuntime};

pub struct WindowFilters {
    class: Option<Regex>,
    title: Option<Regex>,
}

impl WindowFilters {
    pub fn new(class: Option<&str>, title: Option<&str>) -> Result<Self, String> {
        fn compile(value: Option<&str>, field: &str) -> Result<Option<Regex>, String> {
            value
                .map(|pattern| {
                    Regex::new(pattern)
                        .map_err(|err| format!("WINDOW_FILTER_INVALID: {field}: {err}"))
                })
                .transpose()
        }
        Ok(Self {
            class: compile(class, "class_regex")?,
            title: compile(title, "window_regex")?,
        })
    }

    pub fn matches(&self, class: &str, title: &str) -> bool {
        self.class.as_ref().is_none_or(|re| re.is_match(class))
            && self.title.as_ref().is_none_or(|re| re.is_match(title))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub handle: u64,
    pub process_id: u32,
    pub class_name: String,
}

pub fn capture(config: &ControllerConfig) -> Result<Option<WindowIdentity>, String> {
    let ControllerConfig::Win32 {
        handle,
        class_regex,
        window_regex,
        ..
    } = config
    else {
        return Ok(None);
    };
    let filters = WindowFilters::new(class_regex.as_deref(), window_regex.as_deref())?;
    #[cfg(windows)]
    {
        use winsafe::HWND;

        let hwnd = unsafe { HWND::from_ptr(*handle as *mut _) };
        let (_, process_id) = hwnd.GetWindowThreadProcessId();
        if process_id == 0 {
            return Err(format!("WINDOW_NOT_FOUND: hwnd={handle}"));
        }
        let class_name = hwnd.GetClassName().map_err(|err| format!("WINDOW_NOT_FOUND: {err}"))?;
        let window_name = hwnd.GetWindowText().map_err(|err| format!("WINDOW_NOT_FOUND: {err}"))?;
        if !filters.matches(&class_name, &window_name) {
            return Err(format!(
                "WINDOW_TARGET_MISMATCH: hwnd={handle}, class={}, title={}",
                class_name, window_name
            ));
        }
        if hwnd.GetWindowThreadProcessId().1 != process_id {
            return Err("WINDOW_TARGET_CHANGED".into());
        }
        Ok(Some(WindowIdentity {
            handle: *handle,
            process_id,
            class_name,
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = (handle, filters);
        Err("WINDOW_NOT_FOUND: Win32 requires Windows".into())
    }
}

fn check_identity(
    expected: Option<&WindowIdentity>,
    actual: Option<&WindowIdentity>,
) -> Result<(), String> {
    if expected != actual {
        return Err("WINDOW_TARGET_CHANGED".into());
    }
    Ok(())
}

pub fn validate_instance(instance: &InstanceRuntime) -> Result<(), String> {
    if let Some(config) = &instance.controller_config {
        let actual = capture(config)?;
        check_identity(instance.window_target.as_ref(), actual.as_ref())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_filters_fail_instead_of_matching_every_window() {
        assert!(WindowFilters::new(None, Some("^(?!.*助手).*$"))
            .err()
            .unwrap()
            .starts_with("WINDOW_FILTER_INVALID: window_regex:"));
        assert!(WindowFilters::new(Some("["), None).is_err());
        assert!(WindowFilters::new(None, None).unwrap().matches("", ""));
        assert!(WindowFilters::new(Some(""), Some(""))
            .unwrap()
            .matches("anything", "anything"));
    }

    #[test]
    fn both_class_and_title_must_match() {
        let filters = WindowFilters::new(Some("^UnityWndClass$"), Some("^Example Game$"))
            .unwrap();
        assert!(filters.matches("UnityWndClass", "Example Game"));
        assert!(!filters.matches("CabinetWClass", "Example Game"));
        assert!(!filters.matches("UnityWndClass", "Another Game"));
        assert!(!filters.matches("ThumbnailDeviceHelperWnd", ""));
    }

    #[test]
    fn recycled_handles_and_missing_connection_identity_are_rejected() {
        let original = WindowIdentity {
            handle: 42,
            process_id: 100,
            class_name: "UnityWndClass".into(),
        };
        assert!(check_identity(Some(&original), Some(&original)).is_ok());
        for changed in [
            WindowIdentity { process_id: 101, ..original.clone() },
            WindowIdentity { handle: 43, ..original.clone() },
            WindowIdentity { class_name: "CabinetWClass".into(), ..original.clone() },
        ] {
            assert!(check_identity(Some(&original), Some(&changed)).is_err());
        }
        assert!(check_identity(None, Some(&original)).is_err());
        assert!(check_identity(Some(&original), None).is_err());
        assert!(check_identity(None, None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn live_window_is_rechecked_before_submission() {
        use winsafe::{co, AtomStr, HINSTANCE, HWND, IdMenu, POINT, SIZE};

        // A hidden test-owned STATIC window requires neither a game nor Maa DLLs.
        let hwnd = unsafe {
            HWND::CreateWindowEx(
                co::WS_EX::NoValue,
                AtomStr::from_str("STATIC"),
                Some("Window target fixture"),
                co::WS::OVERLAPPED,
                POINT::default(),
                SIZE { cx: 100, cy: 100 },
                None,
                IdMenu::None,
                &HINSTANCE::NULL,
                None,
            )
        }.unwrap();
        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) { let _ = self.0.DestroyWindow(); }
        }
        let window = TestWindow(hwnd);
        let config: ControllerConfig = serde_json::from_value(serde_json::json!({
            "type": "Win32", "handle": window.0.ptr() as u64,
            "screencap_method": 1, "mouse_method": 1, "keyboard_method": 1,
            "class_regex": "(?i)^static$", "window_regex": "^Window target fixture$"
        })).unwrap();
        let mut instance = InstanceRuntime::default();
        instance.window_target = capture(&config).unwrap();
        instance.controller_config = Some(config);
        assert!(validate_instance(&instance).is_ok());

        window.0.SetWindowText("Wrong window").unwrap();
        assert!(validate_instance(&instance).unwrap_err().starts_with("WINDOW_TARGET_MISMATCH"));
        window.0.SetWindowText("Window target fixture").unwrap();
        assert!(validate_instance(&instance).is_ok());
        window.0.DestroyWindow().unwrap();
        assert!(validate_instance(&instance).unwrap_err().starts_with("WINDOW_NOT_FOUND"));
    }
}
