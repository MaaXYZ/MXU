//! Optional iOS API bridge until the Rust binding exposes MaaIOSControllerCreate.
//! The inner controller uses raw pixels; the outer custom controller owns the PI scaling.
use super::types::MaaState;
use maa_framework::{
    buffer::{MaaImageBuffer, MaaStringBuffer},
    controller::Controller,
    custom_controller::CustomControllerCallback,
    sys,
};
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::ptr::NonNull;

fn library(state: &MaaState) -> Result<sys::CompositeLibrary, String> {
    let path = state
        .lib_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or(super::utils::get_maafw_dir()?);
    #[cfg(windows)]
    let name = "MaaFramework.dll";
    #[cfg(target_os = "macos")]
    let name = "libMaaFramework.dylib";
    #[cfg(target_os = "linux")]
    let name = "libMaaFramework.so";
    let path: PathBuf = if path.is_file() {
        path
    } else {
        path.join(name)
    };
    // SAFETY: loads the same caller-selected MaaFramework directory as maa_init.
    unsafe { sys::CompositeLibrary::new(path) }.map_err(|_| "IOS_MAAFW_UNAVAILABLE".into())
}

struct IosController {
    handle: NonNull<sys::MaaController>,
    _library: sys::CompositeLibrary,
}
// MaaController's public post/wait API is thread-safe, as in maa-framework::Controller.
unsafe impl Send for IosController {}
unsafe impl Sync for IosController {}
impl Drop for IosController {
    fn drop(&mut self) {
        unsafe {
            sys::MaaControllerDestroy(self.handle.as_ptr());
        }
    }
}
impl IosController {
    fn wait(&self, id: i64) -> bool {
        id > 0
            && unsafe {
                sys::MaaControllerWait(self.handle.as_ptr(), id)
                    == sys::MaaStatusEnum_MaaStatus_Succeeded as sys::MaaStatus
            }
    }
}

pub fn create(
    state: &MaaState,
    udid: &str,
    screencap: u64,
    connection: i32,
    config: &str,
) -> Result<Controller, String> {
    if udid.trim().is_empty() {
        return Err("IOS_UDID_REQUIRED".into());
    }
    if !(0..=2).contains(&connection) || screencap == 0 || screencap & !3 != 0 {
        return Err("IOS_CONFIG_INVALID".into());
    }
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(config)
        .map_err(|_| "IOS_CONFIG_INVALID")?;
    let lib = library(state)?;
    let udid = CString::new(udid).map_err(|_| "IOS_CONFIG_INVALID")?;
    let config = CString::new(config).map_err(|_| "IOS_CONFIG_INVALID")?;
    type Create =
        unsafe extern "C" fn(*const c_char, u64, i32, *const c_char) -> *mut sys::MaaController;
    // SAFETY: signature matches MaaController.h; lib is retained until the native handle is destroyed.
    let create = unsafe {
        *lib.get::<Create>(b"MaaIOSControllerCreate\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?
    };
    let handle =
        NonNull::new(unsafe { create(udid.as_ptr(), screencap, connection, config.as_ptr()) })
            .ok_or("IOS_CREATE_FAILED")?;
    let inner = IosController {
        handle,
        _library: lib,
    };
    let mut raw = true;
    let ok = unsafe {
        sys::MaaControllerSetOption(
            inner.handle.as_ptr(),
            sys::MaaCtrlOptionEnum_MaaCtrlOption_ScreenshotUseRawSize as sys::MaaCtrlOption,
            (&mut raw as *mut bool).cast(),
            std::mem::size_of::<bool>() as u64,
        )
    };
    if ok == 0 {
        return Err("IOS_CREATE_FAILED".into());
    }
    Controller::new_custom(inner).map_err(|e| format!("IOS_CREATE_FAILED: {e}"))
}

impl CustomControllerCallback for IosController {
    fn get_features(&self) -> maa_framework::common::ControllerFeature {
        maa_framework::common::ControllerFeature::USE_MOUSE_DOWN_UP_INSTEAD_OF_CLICK
            | maa_framework::common::ControllerFeature::USE_KEY_DOWN_UP_INSTEAD_OF_CLICK
    }
    fn connect(&self) -> bool {
        self.wait(unsafe { sys::MaaControllerPostConnection(self.handle.as_ptr()) })
    }
    fn connected(&self) -> bool {
        unsafe { sys::MaaControllerConnected(self.handle.as_ptr()) != 0 }
    }
    fn request_uuid(&self) -> Option<String> {
        let buffer = MaaStringBuffer::new().ok()?;
        (unsafe { sys::MaaControllerGetUuid(self.handle.as_ptr(), buffer.as_ptr()) } != 0)
            .then(|| buffer.as_str().to_owned())
    }
    fn get_info(&self) -> String {
        let Ok(buffer) = MaaStringBuffer::new() else {
            return "{}".into();
        };
        if unsafe { sys::MaaControllerGetInfo(self.handle.as_ptr(), buffer.as_ptr()) } != 0 {
            buffer.as_str().to_owned()
        } else {
            "{}".into()
        }
    }
    fn screencap(&self) -> Option<Vec<u8>> {
        if !self.wait(unsafe { sys::MaaControllerPostScreencap(self.handle.as_ptr()) }) {
            return None;
        }
        let buffer = MaaImageBuffer::new().ok()?;
        if unsafe { sys::MaaControllerCachedImage(self.handle.as_ptr(), buffer.as_ptr()) } == 0 {
            return None;
        }
        buffer.to_vec()
    }
    fn click(&self, x: i32, y: i32) -> bool {
        self.wait(unsafe { sys::MaaControllerPostClick(self.handle.as_ptr(), x, y) })
    }
    fn swipe(&self, x1: i32, y1: i32, x2: i32, y2: i32, duration: i32) -> bool {
        self.wait(unsafe {
            sys::MaaControllerPostSwipe(self.handle.as_ptr(), x1, y1, x2, y2, duration)
        })
    }
    fn touch_down(&self, contact: i32, x: i32, y: i32, pressure: i32) -> bool {
        self.wait(unsafe {
            sys::MaaControllerPostTouchDown(self.handle.as_ptr(), contact, x, y, pressure)
        })
    }
    fn touch_move(&self, contact: i32, x: i32, y: i32, pressure: i32) -> bool {
        self.wait(unsafe {
            sys::MaaControllerPostTouchMove(self.handle.as_ptr(), contact, x, y, pressure)
        })
    }
    fn touch_up(&self, contact: i32) -> bool {
        self.wait(unsafe { sys::MaaControllerPostTouchUp(self.handle.as_ptr(), contact) })
    }
    fn click_key(&self, keycode: i32) -> bool {
        self.wait(unsafe { sys::MaaControllerPostClickKey(self.handle.as_ptr(), keycode) })
    }
    fn key_down(&self, keycode: i32) -> bool {
        self.wait(unsafe { sys::MaaControllerPostKeyDown(self.handle.as_ptr(), keycode) })
    }
    fn key_up(&self, keycode: i32) -> bool {
        self.wait(unsafe { sys::MaaControllerPostKeyUp(self.handle.as_ptr(), keycode) })
    }
    fn input_text(&self, text: &str) -> bool {
        let Ok(text) = CString::new(text) else {
            return false;
        };
        self.wait(unsafe { sys::MaaControllerPostInputText(self.handle.as_ptr(), text.as_ptr()) })
    }
    fn start_app(&self, intent: &str) -> bool {
        let Ok(intent) = CString::new(intent) else {
            return false;
        };
        self.wait(unsafe { sys::MaaControllerPostStartApp(self.handle.as_ptr(), intent.as_ptr()) })
    }
    fn stop_app(&self, intent: &str) -> bool {
        let Ok(intent) = CString::new(intent) else {
            return false;
        };
        self.wait(unsafe { sys::MaaControllerPostStopApp(self.handle.as_ptr(), intent.as_ptr()) })
    }
}

#[derive(serde::Serialize)]
pub struct IosDevice {
    udid: String,
    name: String,
    state: String,
}

pub fn find_devices(
    state: &MaaState,
    connection: i32,
    config: &str,
) -> Result<Vec<IosDevice>, String> {
    if !(0..=2).contains(&connection) {
        return Err("IOS_CONFIG_INVALID".into());
    }
    let lib = library(state)?;
    type NewList = unsafe extern "C" fn() -> *mut c_void;
    type Destroy = unsafe extern "C" fn(*mut c_void);
    type Find = unsafe extern "C" fn(
        i32,
        *const c_char,
        Option<unsafe extern "C" fn(*mut c_void) -> u8>,
        *mut c_void,
        *mut c_void,
    ) -> u8;
    type Size = unsafe extern "C" fn(*const c_void) -> u64;
    type At = unsafe extern "C" fn(*const c_void, u64) -> *const c_void;
    type Text = unsafe extern "C" fn(*const c_void) -> *const c_char;
    // Copy typed symbols while keeping lib alive throughout discovery and list destruction.
    unsafe {
        let new = *lib
            .get::<NewList>(b"MaaToolkitIOSDeviceListCreate\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let destroy = *lib
            .get::<Destroy>(b"MaaToolkitIOSDeviceListDestroy\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let find = *lib
            .get::<Find>(b"MaaToolkitIOSDeviceFindWithOptions\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let size = *lib
            .get::<Size>(b"MaaToolkitIOSDeviceListSize\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let at = *lib
            .get::<At>(b"MaaToolkitIOSDeviceListAt\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let name = *lib
            .get::<Text>(b"MaaToolkitIOSDeviceGetName\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let udid = *lib
            .get::<Text>(b"MaaToolkitIOSDeviceGetUdid\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let status = *lib
            .get::<Text>(b"MaaToolkitIOSDeviceGetState\0")
            .map_err(|_| "IOS_MAAFW_UNAVAILABLE")?;
        let config: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(config).map_err(|_| "IOS_CONFIG_INVALID")?;
        let mut options = serde_json::json!({ "timeout_ms": 3000 });
        if let Some(port) = config.get("server_port") {
            options["server_port"] = port.clone();
        }
        let options = CString::new(options.to_string()).map_err(|_| "IOS_CONFIG_INVALID")?;
        let list = new();
        if list.is_null() {
            return Err("IOS_CREATE_FAILED".into());
        }
        let found = find(
            connection,
            options.as_ptr(),
            None,
            std::ptr::null_mut(),
            list,
        );
        let text = |ptr: *const c_char| {
            if ptr.is_null() {
                String::new()
            } else {
                CStr::from_ptr(ptr).to_string_lossy().into_owned()
            }
        };
        let mut devices = Vec::new();
        if found != 0 {
            for index in 0..size(list) {
                let device = at(list, index);
                if device.is_null() {
                    continue;
                }
                let id = text(udid(device));
                if !id.is_empty() {
                    devices.push(IosDevice {
                        udid: id,
                        name: text(name(device)),
                        state: text(status(device)),
                    });
                }
            }
        }
        destroy(list);
        if found == 0 {
            return Err("IOS_DISCOVERY_FAILED".into());
        }
        Ok(devices)
    }
}

#[tauri::command]
pub async fn maa_find_ios_devices(
    state: tauri::State<'_, std::sync::Arc<MaaState>>,
    connection: Option<i32>,
    config: Option<String>,
) -> Result<Vec<IosDevice>, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        find_devices(
            &state,
            connection.unwrap_or(0),
            &config.unwrap_or_else(|| "{}".into()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
