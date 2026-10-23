use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::ImageEncoder;
use maa_framework::common::ControllerFeature;
use maa_framework::custom_controller::CustomControllerCallback;
use serde_json::{json, Value};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::System::Memory::{MapViewOfFile, UnmapViewOfFile, FILE_MAP_READ};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

#[path = "cloud_web_transport.rs"]
mod transport;

const WIDTH: usize = 1280;
const HEIGHT: usize = 720;
const FRAME_BYTES: usize = WIDTH * HEIGHT * 4;

pub struct CloudWebController {
    process_id: u32,
    keys: Mutex<BTreeSet<i32>>,
    contacts: Mutex<BTreeMap<i32, (i32, i32)>>,
    frame_lock: Mutex<()>,
    request_lock: Mutex<()>,
    cancellation: Arc<AtomicU64>,
}

impl CloudWebController {
    pub fn new(process_id: u32) -> Self {
        let cancellation = Arc::new(AtomicU64::new(0));
        cancellations()
            .lock()
            .unwrap()
            .push((process_id, Arc::downgrade(&cancellation)));
        Self {
            process_id,
            keys: Mutex::new(BTreeSet::new()),
            contacts: Mutex::new(BTreeMap::new()),
            frame_lock: Mutex::new(()),
            request_lock: Mutex::new(()),
            cancellation,
        }
    }

    fn request_with<T>(
        &self,
        message: Value,
        consume: impl FnOnce(Value) -> io::Result<T>,
    ) -> Option<T> {
        // Capture before locking so a queued request is cancelled with the
        // in-flight request, without disabling later key/button releases.
        let generation = self.cancellation.load(Ordering::Acquire);
        let _guard = self.request_lock.lock().unwrap();
        match transport::request(
            self.process_id,
            &message,
            &self.cancellation,
            generation,
            consume,
        ) {
            Ok(value) => Some(value),
            Err(error) => {
                log::warn!(
                    "Cloud controller {} RPC {} failed: {}",
                    self.process_id,
                    message["op"],
                    error
                );
                None
            }
        }
    }

    fn request(&self, message: Value) -> Option<Value> {
        self.request_with(message, Ok)
    }

    fn input(&self, op: &str, mut params: Value) -> bool {
        params["modifiers"] = json!(modifiers(&self.keys.lock().unwrap()));
        self.request(json!({"op": op, "params": params}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn frame(&self) -> Option<Vec<u8>> {
        let _guard = self.frame_lock.lock().unwrap();
        let (response, pixels) = self.request_with(json!({"op":"frame_shared"}), |response| {
            let pixels = if response.get("ok").and_then(Value::as_bool) == Some(true) {
                Some(copy_shared_frame(&response["value"])?)
            } else {
                None
            };
            Ok((response, pixels))
        })?;
        if !response.get("ok")?.as_bool()? {
            if response.get("error")?.as_str()? == "video_unavailable" {
                return self.landing_screenshot();
            }
            return None;
        }
        let pixels = pixels?;
        // These pixels stay on this machine. Filtering/compressing each frame
        // costs both encoder time and another filter pass in the framework.
        let mut png = Vec::with_capacity(FRAME_BYTES + HEIGHT + 1024);
        let result = image::codecs::png::PngEncoder::new_with_quality(
            &mut png,
            image::codecs::png::CompressionType::Uncompressed,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(
            &pixels,
            WIDTH as u32,
            HEIGHT as u32,
            image::ColorType::Rgba8.into(),
        );
        result.ok()?;
        Some(png)
    }

    fn landing_screenshot(&self) -> Option<Vec<u8>> {
        let status = self.request(json!({"op":"status"}))?;
        let state = status.get("value")?;
        if state.get("account")?.as_str()? != "signed_in"
            || state.get("page")?.as_str()? != "landing"
            || !state.get("start_available")?.as_bool()?
        {
            return None;
        }

        let response = self.request(json!({"op":"screencap"}))?;
        if !response.get("ok")?.as_bool()? {
            return None;
        }
        let png = STANDARD
            .decode(response.get("value")?.get("data")?.as_str()?)
            .ok()?;
        // WebView page screenshots use physical viewport pixels, while CDP
        // input and decoded game frames use the fixed 1280 x 720 coordinates.
        let screenshot = image::load_from_memory(&png).ok()?;
        if screenshot.width() == WIDTH as u32 && screenshot.height() == HEIGHT as u32 {
            return Some(png);
        }
        let pixels = screenshot
            .resize_exact(
                WIDTH as u32,
                HEIGHT as u32,
                image::imageops::FilterType::Triangle,
            )
            .to_rgba8();
        let mut normalized = Vec::new();
        image::codecs::png::PngEncoder::new(&mut normalized)
            .write_image(
                pixels.as_raw(),
                WIDTH as u32,
                HEIGHT as u32,
                image::ColorType::Rgba8.into(),
            )
            .ok()?;
        Some(normalized)
    }
}

impl CustomControllerCallback for CloudWebController {
    fn request_uuid(&self) -> Option<String> {
        Some(format!("cloud-webview-{}", self.process_id))
    }

    fn connect(&self) -> bool {
        self.request(json!({"op":"status"}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn connected(&self) -> bool {
        self.request(json!({"op":"status"}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn get_features(&self) -> ControllerFeature {
        // Preserve contact (including -1 for hover), duration and held buttons.
        // The legacy click/swipe callbacks do not receive these parameters.
        ControllerFeature::USE_MOUSE_DOWN_UP_INSTEAD_OF_CLICK
            | ControllerFeature::USE_KEY_DOWN_UP_INSTEAD_OF_CLICK
    }

    fn screencap(&self) -> Option<Vec<u8>> {
        self.frame()
    }

    fn click(&self, x: i32, y: i32) -> bool {
        let down = self.touch_down(0, x, y, 0);
        let up = self.touch_up(0);
        down && up
    }

    fn swipe(&self, x1: i32, y1: i32, x2: i32, y2: i32, duration: i32) -> bool {
        if !self.touch_down(0, x1, y1, 0) {
            return false;
        }
        let steps = (duration.max(1) / 16).max(1);
        let started = std::time::Instant::now();
        for step in 1..=steps {
            let due = Duration::from_millis((duration.max(0) as u64 * step as u64) / steps as u64);
            std::thread::sleep(due.saturating_sub(started.elapsed()));
            let x = x1 + ((x2 as i64 - x1 as i64) * step as i64 / steps as i64) as i32;
            let y = y1 + ((y2 as i64 - y1 as i64) * step as i64 / steps as i64) as i32;
            if !self.touch_move(0, x, y, 0) {
                let _ = self.touch_up(0);
                return false;
            }
        }
        self.touch_up(0)
    }

    fn click_key(&self, keycode: i32) -> bool {
        let down = self.key_down(keycode);
        let up = self.key_up(keycode);
        down && up
    }

    fn key_down(&self, keycode: i32) -> bool {
        let key = key_identity(keycode);
        let mut keys = self.keys.lock().unwrap();
        let repeated = !keys.insert(keycode);
        let ok = self.request(json!({"op":"key","params":{"type":"keyDown","key":key.0,"code":key.1,"windowsVirtualKeyCode":keycode,"modifiers":modifiers(&keys),"autoRepeat":repeated}}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool)).unwrap_or(false);
        if !ok && !repeated {
            keys.remove(&keycode);
        }
        ok
    }

    fn key_up(&self, keycode: i32) -> bool {
        let key = key_identity(keycode);
        let mut keys = self.keys.lock().unwrap();
        let was_down = keys.remove(&keycode);
        let ok = self.request(json!({"op":"key","params":{"type":"keyUp","key":key.0,"code":key.1,"windowsVirtualKeyCode":keycode,"modifiers":modifiers(&keys)}}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool)).unwrap_or(false);
        if !ok && was_down {
            keys.insert(keycode);
        }
        ok
    }

    fn touch_down(&self, contact: i32, x: i32, y: i32, _pressure: i32) -> bool {
        if contact == -1 {
            return true;
        }
        let Some(button) = mouse_button(contact) else {
            return false;
        };
        let mut contacts = self.contacts.lock().unwrap();
        if self.input(
            "mouse",
            json!({"type":"mousePressed","x":x,"y":y,"button":button,"buttons":mouse_buttons(&contacts) | (1 << contact),"clickCount":1}),
        ) {
            contacts.insert(contact, (x, y));
            true
        } else {
            false
        }
    }

    fn touch_move(&self, contact: i32, x: i32, y: i32, _pressure: i32) -> bool {
        if contact != -1 && mouse_button(contact).is_none() {
            return false;
        }
        let mut contacts = self.contacts.lock().unwrap();
        let buttons = mouse_buttons(&contacts);
        if self.input(
            "mouse",
            json!({"type":"mouseMoved","x":x,"y":y,"button":"none","buttons":buttons}),
        ) {
            if contacts.contains_key(&contact) {
                contacts.insert(contact, (x, y));
            }
            true
        } else {
            false
        }
    }

    fn touch_up(&self, contact: i32) -> bool {
        if contact == -1 {
            return true;
        }
        let Some(button) = mouse_button(contact) else {
            return false;
        };
        let mut contacts = self.contacts.lock().unwrap();
        let (x, y) = contacts.get(&contact).copied().unwrap_or((640, 360));
        if self.input(
            "mouse",
            json!({"type":"mouseReleased","x":x,"y":y,"button":button,"buttons":mouse_buttons(&contacts) & !(1 << contact),"clickCount":1}),
        ) {
            contacts.remove(&contact);
            true
        } else {
            false
        }
    }

    fn input_text(&self, text: &str) -> bool {
        self.request(json!({"op":"text","text":text}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn relative_move(&self, dx: i32, dy: i32) -> bool {
        let contacts = self.contacts.lock().unwrap();
        let keys = self.keys.lock().unwrap();
        self.request(json!({"op":"relative","dx":dx,"dy":dy,"buttons":mouse_buttons(&contacts),"modifiers":modifiers(&keys)}))
            .and_then(|v| v.get("ok").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    fn scroll(&self, dx: i32, dy: i32) -> bool {
        let contacts = self.contacts.lock().unwrap();
        self.input(
            "mouse",
            json!({"type":"mouseWheel","x":640,"y":360,"deltaX":dx,"deltaY":dy,"buttons":mouse_buttons(&contacts)}),
        )
    }

    fn inactive(&self) -> bool {
        let keys: Vec<_> = self.keys.lock().unwrap().iter().copied().collect();
        let contacts: Vec<_> = self.contacts.lock().unwrap().keys().copied().collect();
        let mut ok = true;
        for key in keys {
            ok = self.key_up(key) && ok;
        }
        for contact in contacts {
            ok = self.touch_up(contact) && ok;
        }
        ok
    }
}

fn copy_shared_frame(value: &Value) -> io::Result<Vec<u8>> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid shared frame");
    let handle = value
        .get("mapping_handle")
        .and_then(Value::as_i64)
        .ok_or_else(invalid)? as usize;
    if handle == 0 || handle == usize::MAX {
        return Err(invalid());
    }
    // Take ownership before validating any remaining field, including errors.
    let mapping = unsafe { OwnedHandle::from_raw_handle(handle as *mut _) };
    if value["byte_size"].as_u64() != Some(FRAME_BYTES as u64)
        || value["width"].as_u64() != Some(WIDTH as u64)
        || value["height"].as_u64() != Some(HEIGHT as u64)
        || value["stride"].as_u64() != Some((WIDTH * 4) as u64)
        || value["format"].as_str() != Some("RGBA8")
        || value["protocol"].as_u64() != Some(1)
    {
        return Err(invalid());
    }
    let view = unsafe {
        MapViewOfFile(
            HANDLE(mapping.as_raw_handle()),
            FILE_MAP_READ,
            0,
            0,
            FRAME_BYTES,
        )
    };
    if view.Value.is_null() {
        return Err(io::Error::last_os_error());
    }
    let pixels =
        unsafe { std::slice::from_raw_parts(view.Value.cast::<u8>(), FRAME_BYTES).to_vec() };
    unsafe { UnmapViewOfFile(view) }?;
    Ok(pixels)
}

type Cancellations = Vec<(u32, Weak<AtomicU64>)>;

fn cancellations() -> &'static Mutex<Cancellations> {
    static REGISTRY: OnceLock<Mutex<Cancellations>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn cancel_pending(handle: u64) {
    let process_id = process_id(handle);
    cancellations().lock().unwrap().retain(|(pid, weak)| {
        if let Some(generation) = weak.upgrade() {
            if *pid == process_id {
                generation.fetch_add(1, Ordering::AcqRel);
            }
            true
        } else {
            false
        }
    });
}

fn process_id(handle: u64) -> u32 {
    let mut process_id = 0;
    unsafe { GetWindowThreadProcessId(HWND(handle as *mut _), Some(&mut process_id)) };
    process_id
}

// A lease belongs to a single task run, not a window title or installation.
// The host validates both client PID and token before releasing/closing it.
pub struct CloudRun {
    process_id: u32,
    token: String,
    finished: bool,
}

impl CloudRun {
    pub fn acquire(handle: u64) -> Result<Self, String> {
        static NEXT_RUN: AtomicU64 = AtomicU64::new(1);
        let lease = Self {
            process_id: process_id(handle),
            finished: false,
            token: format!(
                "{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                NEXT_RUN.fetch_add(1, Ordering::Relaxed)
            ),
        };
        lease.command("run_acquire")?;
        Ok(lease)
    }

    fn command(&self, op: &str) -> Result<(), String> {
        let cancellation = AtomicU64::new(0);
        let response = transport::request(
            self.process_id,
            &json!({"op":op,"token":self.token}),
            &cancellation,
            0,
            Ok,
        )
        .map_err(|error| error.to_string())?;
        if response["ok"].as_bool() != Some(true) {
            return Err(format!("Cloud run {} failed: {}", op, response["error"]));
        }
        Ok(())
    }

    pub fn finish(mut self) {
        if let Err(error) = self.command("run_close") {
            log::warn!("{}", error);
        } else {
            self.finished = true;
        }
    }
}

impl Drop for CloudRun {
    fn drop(&mut self) {
        // Best effort on disconnect/post_task failure. A successful run_close
        // may already have exited the host; that is not a release failure.
        if !self.finished {
            let _ = self.command("run_release");
        }
    }
}

fn mouse_buttons(contacts: &BTreeMap<i32, (i32, i32)>) -> i32 {
    contacts
        .keys()
        .fold(0, |buttons, contact| buttons | (1 << contact))
}

fn modifiers(keys: &BTreeSet<i32>) -> i32 {
    let held = |codes: &[i32]| codes.iter().any(|key| keys.contains(key)) as i32;
    held(&[18, 164, 165])
        | (held(&[17, 162, 163]) << 1)
        | (held(&[91, 92]) << 2)
        | (held(&[16, 160, 161]) << 3)
}

fn mouse_button(contact: i32) -> Option<&'static str> {
    match contact {
        0 => Some("left"),
        1 => Some("right"),
        2 => Some("middle"),
        _ => None,
    }
}

fn key_identity(keycode: i32) -> (String, String) {
    match keycode {
        8 => ("Backspace".into(), "Backspace".into()),
        9 => ("Tab".into(), "Tab".into()),
        13 => ("Enter".into(), "Enter".into()),
        16 => ("Shift".into(), "ShiftLeft".into()),
        17 => ("Control".into(), "ControlLeft".into()),
        18 => ("Alt".into(), "AltLeft".into()),
        27 => ("Escape".into(), "Escape".into()),
        32 => (" ".into(), "Space".into()),
        37 => ("ArrowLeft".into(), "ArrowLeft".into()),
        38 => ("ArrowUp".into(), "ArrowUp".into()),
        39 => ("ArrowRight".into(), "ArrowRight".into()),
        40 => ("ArrowDown".into(), "ArrowDown".into()),
        91 => ("Meta".into(), "MetaLeft".into()),
        92 => ("Meta".into(), "MetaRight".into()),
        112..=135 => {
            let key = format!("F{}", keycode - 111);
            (key.clone(), key)
        }
        160 => ("Shift".into(), "ShiftLeft".into()),
        161 => ("Shift".into(), "ShiftRight".into()),
        162 => ("Control".into(), "ControlLeft".into()),
        163 => ("Control".into(), "ControlRight".into()),
        164 => ("Alt".into(), "AltLeft".into()),
        165 => ("Alt".into(), "AltRight".into()),
        48..=57 => {
            let ch = char::from_u32(keycode as u32).unwrap_or('0');
            (ch.to_string(), format!("Digit{ch}"))
        }
        65..=90 => {
            let ch = char::from_u32(keycode as u32).unwrap_or('A');
            (ch.to_ascii_lowercase().to_string(), format!("Key{ch}"))
        }
        _ => (format!("U+{keycode:04X}"), String::new()),
    }
}
