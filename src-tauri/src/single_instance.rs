//! 单实例限制（仅 Windows）
//!
//! 以安装目录哈希命名，同一安装目录只允许运行一个实例；不同安装目录、不同项目互不影响。
//!
//! 参考 tauri-plugin-single-instance 与 Chromium ProcessSingleton 的做法：
//! - 用命名互斥量检测已有实例（内核保证原子性，同时启动也只有一个能创建成功）；
//! - 已有实例在 UI 线程上创建隐藏的消息窗口，重复启动的进程向它发送唤起消息，
//!   由已有实例自己显示并前置窗口，而不是跨进程直接操作对方窗口；
//! - 发送前调用 `AllowSetForegroundWindow` 把前台权限交给已有实例；
//! - 用 `SendMessageTimeoutW` + `SMTO_ABORTIFHUNG`，已有实例卡死时不会把新进程一起拖住；
//! - 任何唤起失败都弹窗提示并写日志，避免"双击没反应"。
//!
//! 可在设置中关闭（配置 `settings.singleInstance`，默认开启），重启后生效。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM,
    LRESULT, WPARAM,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, ChangeWindowMessageFilterEx, CreateWindowExW, DefWindowProcW,
    FindWindowExW, GetWindowThreadProcessId, MessageBoxW, RegisterClassExW, RegisterWindowMessageW,
    SendMessageTimeoutW, HWND_MESSAGE, MB_ICONINFORMATION, MB_OK, MSGFLT_ALLOW, SMTO_ABORTIFHUNG,
    SMTO_BLOCK, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW,
};

/// 等待已有实例创建消息窗口（仍在启动中）或释放互斥量（重启中）的最长时间
const WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 发送唤起消息的超时
const SEND_TIMEOUT_MS: u32 = 3000;
/// 唤起消息的处理结果：已收到
const ACTIVATE_ACK: usize = 1;

/// 当前进程持有的互斥量句柄
static MUTEX_HANDLE: Mutex<Option<isize>> = Mutex::new(None);
/// 消息窗口回调中用于唤起主窗口
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

enum TryAcquire {
    Acquired,
    AlreadyRunning,
}

/// 重复启动时的弹窗提示
#[derive(Clone, Copy)]
enum Prompt {
    /// 已有实例未响应
    NotResponding,
    /// 找不到已有实例的消息窗口
    WindowNotFound,
}

enum Notify {
    /// 已有实例已收到唤起消息
    Activated,
    /// 已有实例未响应（卡死或超时）
    NotResponding,
}

/// 启动时调用：返回 true 表示继续启动；返回 false 表示已有实例在运行（已唤起或已提示），应退出。
pub fn acquire_or_activate() -> bool {
    if !is_enabled() {
        return true;
    }

    let start = Instant::now();
    loop {
        if let TryAcquire::Acquired = try_acquire() {
            return true;
        }

        if let Some(hwnd) = find_message_window() {
            match notify(hwnd) {
                Notify::Activated => {
                    write_log("INFO", "检测到重复启动，已通知已有实例唤起窗口");
                }
                Notify::NotResponding => {
                    write_log("WARN", "检测到重复启动，已有实例未响应，弹窗提示");
                    show_message(Prompt::NotResponding);
                }
            }
            return false;
        }

        // 已有实例尚未创建消息窗口（启动中）或正在退出（重启中），稍等再试
        if start.elapsed() >= WAIT_TIMEOUT {
            write_log("WARN", "检测到重复启动，未找到已有实例的消息窗口，弹窗提示");
            show_message(Prompt::WindowNotFound);
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 释放互斥量，用于即将拉起新进程替换自身的场景（提权重启、更新重启、退出）
pub fn release() {
    if let Some(handle) = MUTEX_HANDLE.lock().unwrap().take() {
        unsafe {
            let _ = CloseHandle(HANDLE(handle as *mut _));
        }
    }
}

/// 释放后重新获取（如提权失败、当前进程继续运行），返回是否成功
pub fn reacquire() -> bool {
    if !is_enabled() {
        return true;
    }
    matches!(try_acquire(), TryAcquire::Acquired)
}

/// 是否启用多开检测：读取配置 `settings.singleInstance`，默认启用。
/// 在 Tauri 初始化前调用，不依赖 AppConfigState；结果在进程内缓存，修改后重启生效。
pub fn is_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| read_enabled_setting().unwrap_or(true))
}

fn read_enabled_setting() -> Option<bool> {
    use crate::commands::app_config::{make_config_filename, parse_jsonc};
    use crate::commands::utils::{get_app_data_dir, get_exe_directory};

    // 配置文件名由 interface.json 的 name 决定，与 AppConfigState 保持一致
    let interface = std::fs::read_to_string(get_exe_directory().ok()?.join("interface.json"))
        .ok()
        .and_then(|content| parse_jsonc(&content).ok());
    let project_name = interface
        .as_ref()
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str());
    let config_path = get_app_data_dir()
        .ok()?
        .join("config")
        .join(make_config_filename(project_name));

    let content = std::fs::read_to_string(config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&content).ok()?;
    config.get("settings")?.get("singleInstance")?.as_bool()
}

/// 创建接收唤起消息的隐藏窗口。须在 UI 线程（Tauri setup）中调用，
/// 消息由 Tauri 事件循环分发；UI 线程卡死时发送方能通过 SMTO_ABORTIFHUNG 感知。
pub fn create_message_window(app: &AppHandle) {
    if !is_enabled() {
        log::info!("single_instance: 多开检测已关闭");
        return;
    }

    let _ = APP_HANDLE.set(app.clone());

    let class_name = HSTRING::from(instance_name());
    unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(e) => {
                log::warn!("single_instance: GetModuleHandleW 失败: {}", e);
                return;
            }
        };
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: module.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            log::warn!(
                "single_instance: RegisterClassExW 失败: {:?}",
                GetLastError()
            );
            return;
        }

        // 仅消息窗口：不可见，只用于接收消息
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(module.into()),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(e) => {
                log::warn!("single_instance: 创建消息窗口失败: {}", e);
                return;
            }
        };

        // 允许低权限进程（如取消 UAC 后以普通权限启动）向管理员实例发送唤起消息
        if let Err(e) = ChangeWindowMessageFilterEx(hwnd, activate_message(), MSGFLT_ALLOW, None) {
            log::warn!("single_instance: ChangeWindowMessageFilterEx 失败: {}", e);
        }
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == activate_message() {
        log::info!("single_instance: 收到重复启动的唤起消息，显示主窗口");
        if let Some(app) = APP_HANDLE.get() {
            crate::tray::show_main_window(app);
        }
        return LRESULT(ACTIVATE_ACK as isize);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn try_acquire() -> TryAcquire {
    let name = HSTRING::from(format!("Local\\{}", instance_name()));
    unsafe {
        let result = CreateMutexW(None, false, PCWSTR(name.as_ptr()));
        let last_error = GetLastError();
        match result {
            Ok(handle) if last_error == ERROR_ALREADY_EXISTS => {
                let _ = CloseHandle(handle);
                TryAcquire::AlreadyRunning
            }
            Ok(handle) => {
                *MUTEX_HANDLE.lock().unwrap() = Some(handle.0 as isize);
                TryAcquire::Acquired
            }
            // 已有实例以管理员权限运行，普通权限进程无权打开其互斥量
            Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => TryAcquire::AlreadyRunning,
            // 其他错误无法判断，按无实例处理，不阻止启动
            Err(_) => TryAcquire::Acquired,
        }
    }
}

fn find_message_window() -> Option<HWND> {
    let class_name = HSTRING::from(instance_name());
    unsafe {
        FindWindowExW(
            Some(HWND_MESSAGE),
            None,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
        )
        .ok()
    }
}

fn notify(hwnd: HWND) -> Notify {
    unsafe {
        // 当前进程由用户启动，持有前台权限，转交给已有实例，使其能把窗口置于前台
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            let _ = AllowSetForegroundWindow(pid);
        }

        let mut result = 0usize;
        let sent = SendMessageTimeoutW(
            hwnd,
            activate_message(),
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            SEND_TIMEOUT_MS,
            Some(&mut result),
        );
        if sent.0 != 0 && result == ACTIVATE_ACK {
            Notify::Activated
        } else {
            Notify::NotResponding
        }
    }
}

/// 唤起消息 ID，系统范围内按名称唯一
fn activate_message() -> u32 {
    static MSG: OnceLock<u32> = OnceLock::new();
    *MSG.get_or_init(|| {
        let name = HSTRING::from("MXU-SingleInstance-Activate");
        unsafe { RegisterWindowMessageW(PCWSTR(name.as_ptr())) }
    })
}

/// 按系统界面语言选择弹窗文案。
/// 弹窗出现在 Tauri 与前端初始化之前，无法读取前端 i18n，语言覆盖与 `src/i18n/locales/` 保持一致
fn prompt_text(prompt: Prompt) -> &'static str {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;

    // LANGID：低 10 位为主语言，高 6 位为子语言
    let lang_id = unsafe { GetUserDefaultUILanguage() };
    let primary = lang_id & 0x3ff;
    let sub = lang_id >> 10;

    const LANG_CHINESE: u16 = 0x04;
    const LANG_JAPANESE: u16 = 0x11;
    const LANG_KOREAN: u16 = 0x12;
    // 繁体：台湾 0x01、香港 0x03、澳门 0x05
    const TRADITIONAL_SUBLANGS: [u16; 3] = [0x01, 0x03, 0x05];

    match (primary, prompt) {
        (LANG_CHINESE, Prompt::NotResponding) if TRADITIONAL_SUBLANGS.contains(&sub) => {
            "程式已在執行，但沒有回應。\n請在工作管理員中結束該處理程序後重試。"
        }
        (LANG_CHINESE, Prompt::WindowNotFound) if TRADITIONAL_SUBLANGS.contains(&sub) => {
            "程式已在執行，但無法切換到現有視窗。\n請在工作列或系統匣中查看；如果程式沒有回應，請在工作管理員中結束該處理程序後重試。"
        }
        (LANG_CHINESE, Prompt::NotResponding) => {
            "程序已在运行，但没有响应。\n请在任务管理器中结束该进程后重试。"
        }
        (LANG_CHINESE, Prompt::WindowNotFound) => {
            "程序已在运行，但无法切换到已有窗口。\n请在任务栏或系统托盘中查看；如果程序无响应，请在任务管理器中结束该进程后重试。"
        }
        (LANG_JAPANESE, Prompt::NotResponding) => {
            "プログラムは既に実行中ですが、応答がありません。\nタスク マネージャーでプロセスを終了してから、再度お試しください。"
        }
        (LANG_JAPANESE, Prompt::WindowNotFound) => {
            "プログラムは既に実行中ですが、既存のウィンドウに切り替えられません。\nタスクバーまたはシステム トレイを確認してください。応答がない場合は、タスク マネージャーでプロセスを終了してから、再度お試しください。"
        }
        (LANG_KOREAN, Prompt::NotResponding) => {
            "프로그램이 이미 실행 중이지만 응답하지 않습니다.\n작업 관리자에서 해당 프로세스를 종료한 후 다시 시도하세요."
        }
        (LANG_KOREAN, Prompt::WindowNotFound) => {
            "프로그램이 이미 실행 중이지만 기존 창으로 전환할 수 없습니다.\n작업 표시줄이나 시스템 트레이를 확인하세요. 프로그램이 응답하지 않으면 작업 관리자에서 해당 프로세스를 종료한 후 다시 시도하세요."
        }
        (_, Prompt::NotResponding) => {
            "The program is already running but is not responding.\nPlease end the process in Task Manager and try again."
        }
        (_, Prompt::WindowNotFound) => {
            "The program is already running, but its window could not be brought to the front.\nPlease check the taskbar or system tray. If the program is not responding, end the process in Task Manager and try again."
        }
    }
}

fn show_message(prompt: Prompt) {
    let title = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "MXU".to_string());
    let title = HSTRING::from(title);
    let text = HSTRING::from(prompt_text(prompt));
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

/// 互斥量与消息窗口类共用的名称：按安装目录哈希区分
fn instance_name() -> String {
    use sha2::{Digest, Sha256};

    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let dir = crate::commands::utils::get_exe_directory().unwrap_or_default();
        // 规范化路径，避免同一目录因写法不同（相对路径、junction 等）算出不同哈希
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        // Windows 路径大小写不敏感，统一转小写
        let dir = dir.to_string_lossy().to_lowercase();

        let digest = Sha256::digest(dir.as_bytes());
        let hash: String = digest[..8].iter().map(|b| format!("{:02x}", b)).collect();
        format!("MXU-SingleInstance-{}", hash)
    })
    .clone()
}

/// 重复启动的进程在日志插件初始化前就会退出，直接按 mxu-tauri.log 的格式追加一行
fn write_log(level: &str, msg: &str) {
    use std::io::Write;

    let path = crate::commands::utils::get_logs_dir().join("mxu-tauri.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let now = chrono::Local::now().format("[%Y-%m-%d][%H:%M:%S]");
        let _ = writeln!(
            file,
            "{}[{}][mxu_lib::single_instance] {} (pid={})",
            now,
            level,
            msg,
            std::process::id()
        );
    }
}
