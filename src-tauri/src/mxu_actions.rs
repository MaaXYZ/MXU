//! MXU 内置 Custom Actions
//!
//! 提供 MXU 特有的自定义动作实现，如 MXU_SLEEP 等

use chrono::TimeZone;
use log::{info, warn};
use maa_framework::custom::FnAction;
use maa_framework::resource::Resource;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ============================================================================
// MXU_SLEEP Custom Action
// ============================================================================

/// MXU_SLEEP 动作名称常量
const MXU_SLEEP_ACTION: &str = "MXU_SLEEP_ACTION";

/// MXU_SLEEP custom action 回调函数
/// 从 custom_action_param 中读取 sleep_time（秒），执行等待操作
fn is_tasker_stopping(ctx: &maa_framework::context::Context) -> bool {
    let tasker_ptr = ctx.tasker_handle();
    if tasker_ptr.is_null() {
        return false;
    }

    // SAFETY: tasker_ptr 来自 Context::tasker_handle()，生命周期由 MaaFramework 管理，
    // 在 custom action 回调期间保证有效。此处仅做只读状态查询。
    unsafe { maa_framework::sys::MaaTaskerStopping(tasker_ptr) != 0 }
}

fn request_tasker_stop(ctx: &maa_framework::context::Context) -> bool {
    let tasker_ptr = ctx.tasker_handle();
    if tasker_ptr.is_null() {
        warn!("[MXU] Tasker handle is null, cannot request stop");
        return false;
    }

    // SAFETY: tasker_ptr 来自 Context::tasker_handle()，生命周期由 MaaFramework 管理，
    // 在 custom action 回调期间保证有效。此处仅发送停止请求，不持有该指针。
    unsafe { maa_framework::sys::MaaTaskerPostStop(tasker_ptr) != 0 }
}

fn wait_with_stop_check(ctx: &maa_framework::context::Context, total_secs: u64) -> bool {
    const STEP: std::time::Duration = std::time::Duration::from_millis(200);
    let total = std::time::Duration::from_secs(total_secs);
    let start = std::time::Instant::now();

    while start.elapsed() < total {
        if is_tasker_stopping(ctx) {
            info!("[MXU_WAIT] Stop requested, interrupting wait");
            return false;
        }

        let remain = total.saturating_sub(start.elapsed());
        std::thread::sleep(remain.min(STEP));
    }
    true
}

fn mxu_sleep_action_fn(
    ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_SLEEP] Received param: {}", param_str);

    // 解析 JSON 获取 sleep_time
    let sleep_seconds: u64 = match serde_json::from_str::<serde_json::Value>(param_str) {
        Ok(json) => json.get("sleep_time").and_then(|v| v.as_u64()).unwrap_or(5),
        Err(e) => {
            warn!(
                "[MXU_SLEEP] Failed to parse param JSON: {}, using default 5s",
                e
            );
            5
        }
    };

    info!("[MXU_SLEEP] Sleeping for {} seconds...", sleep_seconds);

    // 执行可中断睡眠（响应 stop）
    if !wait_with_stop_check(ctx, sleep_seconds) {
        warn!("[MXU_SLEEP] Interrupted by stop request");
        return false;
    }

    info!("[MXU_SLEEP] Sleep completed");
    true
}

// ============================================================================
// MXU_WAITUNTIL Custom Action
// ============================================================================

/// MXU_WAITUNTIL 动作名称常量
const MXU_WAITUNTIL_ACTION: &str = "MXU_WAITUNTIL_ACTION";

/// MXU_WAITUNTIL custom action 回调函数
/// 从 custom_action_param 中读取 target_time（HH:MM 格式），等待到该时间点
/// 仅支持 24 小时内：若目标时间已过则等待到次日该时间
fn mxu_waituntil_action_fn(
    ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_WAITUNTIL] Received param: {}", param_str);

    let Ok(json) = serde_json::from_str::<serde_json::Value>(param_str) else {
        warn!("[MXU_WAITUNTIL] Failed to parse param JSON");
        return false;
    };

    let Some(target_time) = json
        .get("target_time")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    else {
        warn!("[MXU_WAITUNTIL] Missing or empty 'target_time' parameter");
        return false;
    };
    let target_time = target_time.to_string();

    // 解析 HH:MM 格式
    let parts: Vec<&str> = target_time.split(':').collect();
    if parts.len() < 2 {
        warn!("[MXU_WAITUNTIL] Invalid time format: {}", target_time);
        return false;
    }

    let target_hour: u32 = match parts[0].parse() {
        Ok(h) if h < 24 => h,
        _ => {
            warn!("[MXU_WAITUNTIL] Invalid hour: {}", parts[0]);
            return false;
        }
    };

    let target_minute: u32 = match parts[1].parse() {
        Ok(m) if m < 60 => m,
        _ => {
            warn!("[MXU_WAITUNTIL] Invalid minute: {}", parts[1]);
            return false;
        }
    };

    // 计算当前时间与目标时间的差值
    let now = chrono::Local::now();
    let Some(today_target) = now.date_naive().and_hms_opt(target_hour, target_minute, 0) else {
        warn!(
            "[MXU_WAITUNTIL] Invalid target time {:02}:{:02}",
            target_hour, target_minute
        );
        return false;
    };

    let today_target = match chrono::Local.from_local_datetime(&today_target).single() {
        Some(dt) => dt,
        None => {
            warn!(
                "[MXU_WAITUNTIL] Ambiguous or invalid local time for target {:02}:{:02} (e.g. due to DST transition)",
                target_hour, target_minute
            );
            return false;
        }
    };

    let wait_duration = if today_target > now {
        today_target - now
    } else {
        // 目标时间已过，等到明天
        let tomorrow_target = today_target + chrono::Duration::days(1);
        tomorrow_target - now
    };

    let wait_secs = wait_duration.num_seconds().max(0) as u64;
    info!(
        "[MXU_WAITUNTIL] Waiting until {}:{:02} ({}s from now)",
        target_hour, target_minute, wait_secs
    );

    if !wait_with_stop_check(ctx, wait_secs) {
        warn!("[MXU_WAITUNTIL] Interrupted by stop request");
        return false;
    }

    info!("[MXU_WAITUNTIL] Wait completed, target time reached");
    true
}

// ============================================================================
// MXU_LAUNCH Custom Action
// ============================================================================

/// MXU_LAUNCH 动作名称常量
const MXU_LAUNCH_ACTION: &str = "MXU_LAUNCH_ACTION";

/// MXU_LAUNCH custom action 回调函数
/// 从 custom_action_param 中读取 program, args, wait_for_exit，启动外部程序
fn mxu_launch_action_fn(
    _ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_LAUNCH] Received param: {}", param_str);

    let json: serde_json::Value = match serde_json::from_str(param_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("[MXU_LAUNCH] Failed to parse param JSON: {}", e);
            return false;
        }
    };

    let program = match json.get("program").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => {
            warn!("[MXU_LAUNCH] Missing or empty 'program' parameter");
            return false;
        }
    };

    let args_str = json
        .get("args")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let wait_for_exit = json
        .get("wait_for_exit")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let skip_if_running = json
        .get("skip_if_running")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let use_cmd = json
        .get("use_cmd")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 如果启用了跳过检查且程序已在运行，直接返回成功
    if skip_if_running {
        if crate::commands::system::check_process_running(&program) {
            info!(
                "[MXU_LAUNCH] Program '{}' is already running, skipping launch",
                program
            );
            return true;
        }
    }

    info!(
        "[MXU_LAUNCH] Launching: program={}, args={}, wait_for_exit={}",
        program, args_str, wait_for_exit
    );

    let args_vec: Vec<String> = if args_str.trim().is_empty() {
        Vec::new()
    } else {
        match shell_words::split(&args_str) {
            Ok(parsed) => parsed,
            Err(e) => {
                warn!(
                    "[MXU_LAUNCH] Failed to parse arguments with shell_words ({}); falling back to whitespace split: {}",
                    e, args_str
                );
                args_str.split_whitespace().map(|s| s.to_string()).collect()
            }
        }
    };

    let mut cmd = crate::commands::utils::build_launch_command(&program, &args_vec, use_cmd);

    // 默认使用程序所在目录作为工作目录
    if let Some(parent) = std::path::Path::new(&program).parent() {
        if parent.exists() {
            cmd.current_dir(parent);
        }
    }

    if wait_for_exit {
        match cmd.status() {
            Ok(status) => {
                let exit_code = status.code().unwrap_or(-1);
                info!("[MXU_LAUNCH] Process exited with code: {}", exit_code);
                true
            }
            Err(e) => {
                log::error!("[MXU_LAUNCH] Failed to run program: {}", e);
                false
            }
        }
    } else {
        match cmd.spawn() {
            Ok(_) => {
                info!("[MXU_LAUNCH] Process spawned (not waiting)");
                true
            }
            Err(e) => {
                log::error!("[MXU_LAUNCH] Failed to spawn program: {}", e);
                false
            }
        }
    }
}

// ============================================================================
// MXU_WEBHOOK Custom Action
// ============================================================================

/// MXU_WEBHOOK 动作名称常量
const MXU_WEBHOOK_ACTION: &str = "MXU_WEBHOOK_ACTION";

/// MXU_WEBHOOK custom action 回调函数
/// 从 custom_action_param 中读取 url，执行 HTTP GET 请求
fn mxu_webhook_action_fn(
    _ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_WEBHOOK] Received param: {}", param_str);

    let json: serde_json::Value = match serde_json::from_str(param_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("[MXU_WEBHOOK] Failed to parse param JSON: {}", e);
            return false;
        }
    };

    let url = match json.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.trim().is_empty() => u.to_string(),
        _ => {
            warn!("[MXU_WEBHOOK] Missing or empty 'url' parameter");
            return false;
        }
    };

    info!("[MXU_WEBHOOK] Sending GET request to: {}", url);

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[MXU_WEBHOOK] Failed to build HTTP client: {}", e);
            return false;
        }
    };

    match client.get(&url).send() {
        Ok(resp) => {
            let status = resp.status();
            info!("[MXU_WEBHOOK] Response status: {}", status);
            if status.is_success() {
                true
            } else {
                warn!("[MXU_WEBHOOK] Non-success status code: {}", status);
                true // 仍然返回成功，只要请求发出去了
            }
        }
        Err(e) => {
            log::error!("[MXU_WEBHOOK] Request failed: {}", e);
            false
        }
    }
}

// ============================================================================
// MXU_NOTIFY Custom Action
// ============================================================================

/// MXU_NOTIFY 动作名称常量
const MXU_NOTIFY_ACTION: &str = "MXU_NOTIFY_ACTION";

/// MXU_NOTIFY custom action 回调函数
/// 从 custom_action_param 中读取 title, body，发送系统通知
fn mxu_notify_action_fn(
    _ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_NOTIFY] Received param: {}", param_str);

    let json: serde_json::Value = match serde_json::from_str(param_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("[MXU_NOTIFY] Failed to parse param JSON: {}", e);
            return false;
        }
    };

    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("MXU")
        .to_string();

    let body = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    info!(
        "[MXU_NOTIFY] Sending notification: title={}, body={}",
        title, body
    );

    match notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .show()
    {
        Ok(_) => {
            info!("[MXU_NOTIFY] Notification sent successfully");
            true
        }
        Err(e) => {
            log::error!("[MXU_NOTIFY] Failed to send notification: {}", e);
            false
        }
    }
}

// ============================================================================
// MXU_KILLPROC Custom Action
// ============================================================================

/// MXU_KILLPROC 动作名称常量
const MXU_KILLPROC_ACTION: &str = "MXU_KILLPROC_ACTION";

const MXU_SELF_STOP_REQUESTED_EVENT: &str = "mxu-self-stop-requested";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfStopRequestedEvent {
    instance_id: String,
}

fn emit_self_stop_requested(app_handle: &AppHandle, instance_id: &str) -> bool {
    if let Err(e) = app_handle.emit(
        MXU_SELF_STOP_REQUESTED_EVENT,
        SelfStopRequestedEvent {
            instance_id: instance_id.to_string(),
        },
    ) {
        log::error!("[MXU_KILLPROC] Failed to emit self-stop event: {}", e);
        false
    } else {
        true
    }
}

fn mxu_killproc_action_impl(
    ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
    app_handle: Option<&AppHandle>,
    instance_id: Option<&str>,
) -> bool {
    let param_str = args.param;
    info!("[MXU_KILLPROC] Received param: {}", param_str);

    let json: serde_json::Value = match serde_json::from_str(param_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("[MXU_KILLPROC] Failed to parse param JSON: {}", e);
            return false;
        }
    };

    let kill_self = json
        .get("kill_self")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    if kill_self {
        info!("[MXU_KILLPROC] Requesting graceful self-stop");

        // 控制器已断开（如前序任务关闭了游戏）时 PostStop 投递停止任务会失败，
        // 但停止标志已置位，前端的停止流程也能兜底，因此不阻断退出。
        if !request_tasker_stop(ctx) {
            warn!(
                "[MXU_KILLPROC] MaaTaskerPostStop failed (controller may be disconnected), continue self-stop"
            );
        }

        return match (app_handle, instance_id) {
            (Some(app), Some(id)) => emit_self_stop_requested(app, id),
            _ => {
                warn!("[MXU_KILLPROC] Missing app handle or instance id for self-stop event");
                false
            }
        };
    }

    let process_name = match json.get("process_name").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => {
            warn!("[MXU_KILLPROC] Missing or empty 'process_name' parameter");
            return false;
        }
    };

    info!("[MXU_KILLPROC] Killing process: {}", process_name);
    kill_process_by_name(&process_name)
}

/// 按名称结束进程
fn kill_process_by_name(name: &str) -> bool {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("taskkill")
            .args(["/F", "/IM", name])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                if output.status.success() {
                    info!("[MXU_KILLPROC] taskkill succeeded: {}", stdout.trim());
                    true
                } else {
                    warn!(
                        "[MXU_KILLPROC] taskkill failed: stdout={}, stderr={}",
                        stdout.trim(),
                        stderr.trim()
                    );
                    false
                }
            }
            Err(e) => {
                log::error!("[MXU_KILLPROC] Failed to execute taskkill: {}", e);
                false
            }
        }
    }

    #[cfg(not(windows))]
    {
        // macOS / Linux: 使用 killall，失败则 fallback 到 pkill
        match Command::new("killall").arg(name).output() {
            Ok(output) => {
                if output.status.success() {
                    info!("[MXU_KILLPROC] killall succeeded");
                    true
                } else {
                    match Command::new("pkill").arg("-f").arg(name).output() {
                        Ok(o) if o.status.success() => {
                            info!("[MXU_KILLPROC] pkill succeeded");
                            true
                        }
                        _ => {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            warn!("[MXU_KILLPROC] killall/pkill failed: {}", stderr.trim());
                            false
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("[MXU_KILLPROC] Failed to execute killall: {}", e);
                false
            }
        }
    }
}

// ============================================================================
// MXU_POWER Custom Action
// ============================================================================

/// MXU_POWER 动作名称常量
const MXU_POWER_ACTION: &str = "MXU_POWER_ACTION";

/// MXU_POWER custom action 回调函数
/// 从 custom_action_param 中读取 power_action，执行关机/重启/息屏/睡眠/休眠/静音/取消静音操作
fn mxu_power_action_fn(
    _ctx: &maa_framework::context::Context,
    args: &maa_framework::custom::ActionArgs,
) -> bool {
    let param_str = args.param;
    info!("[MXU_POWER] Received param: {}", param_str);

    let json: serde_json::Value = match serde_json::from_str(param_str) {
        Ok(v) => v,
        Err(e) => {
            warn!("[MXU_POWER] Failed to parse param JSON: {}", e);
            return false;
        }
    };

    let action = json
        .get("power_action")
        .and_then(|v| v.as_str())
        .unwrap_or("shutdown");

    info!("[MXU_POWER] Executing power action: {}", action);

    match action {
        "shutdown" => execute_power_shutdown(),
        "restart" => execute_power_restart(),
        "screenoff" => execute_power_screenoff(),
        "sleep" => execute_power_sleep(),
        "hibernate" => execute_power_hibernate(),
        "mute" => execute_power_set_mute(true),
        "unmute" => execute_power_set_mute(false),
        _ => {
            warn!("[MXU_POWER] Unknown power action: {}", action);
            false
        }
    }
}

fn execute_power_shutdown() -> bool {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("shutdown")
            .args(["/s", "/f", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Shutdown command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Shutdown failed: {}", e);
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match Command::new("osascript")
            .args(["-e", "tell app \"System Events\" to shut down"])
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Shutdown command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Shutdown failed: {}", e);
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        match Command::new("systemctl").arg("poweroff").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Shutdown command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Shutdown failed: {}", e);
                false
            }
        }
    }
}

fn execute_power_restart() -> bool {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("shutdown")
            .args(["/r", "/f", "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Restart command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Restart failed: {}", e);
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match Command::new("osascript")
            .args(["-e", "tell app \"System Events\" to restart"])
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Restart command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Restart failed: {}", e);
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        match Command::new("systemctl").arg("reboot").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Restart command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Restart failed: {}", e);
                false
            }
        }
    }
}

fn execute_power_screenoff() -> bool {
    #[cfg(windows)]
    {
        use winsafe::co::SC;
        use winsafe::msg::WmSysCommand;
        use winsafe::{HWND, POINT};
        unsafe {
            // NOTE: POINT::from(2) is equal to LPARAM(2)

            HWND::BROADCAST.SendMessage(WmSysCommand {
                request: SC::MONITORPOWER,
                position: POINT::from(2),
            });
        }
        info!("[MXU_POWER] Screen off command issued (Windows)");
        true
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        match Command::new("pmset").arg("displaysleepnow").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Screen off command issued (macOS)");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Screen off failed: {}", e);
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        use std::env;
        use std::process::Command;
        if let Ok(value) = env::var("XDG_SESSION_TYPE") {
            if value == "wayland" {
                log::error!("[MXU_POWER] Screen off on Wayland is not available");
                return false;
            }
        }
        match Command::new("xset").args(["dpms", "force", "off"]).spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Screen off command issued (Linux)");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Screen off failed: {}", e);
                false
            }
        }
    }
}

fn execute_power_sleep() -> bool {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Sleep command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Sleep failed: {}", e);
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match Command::new("pmset").arg("sleepnow").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Sleep command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Sleep failed: {}", e);
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        match Command::new("systemctl").arg("suspend").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Sleep command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Sleep failed: {}", e);
                false
            }
        }
    }
}

fn execute_power_hibernate() -> bool {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        match Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Hibernate', $false, $false)",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => {
                info!("[MXU_POWER] Hibernate command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Hibernate failed: {}", e);
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 无独立休眠命令，休眠模式由 hibernatemode 决定，此处与睡眠一致
        match Command::new("pmset").arg("sleepnow").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Hibernate command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Hibernate failed: {}", e);
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        match Command::new("systemctl").arg("hibernate").spawn() {
            Ok(_) => {
                info!("[MXU_POWER] Hibernate command issued");
                true
            }
            Err(e) => {
                log::error!("[MXU_POWER] Hibernate failed: {}", e);
                false
            }
        }
    }
}

fn execute_power_set_mute(muted: bool) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
        use windows::Win32::Media::Audio::{
            eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        };

        struct ComUninitializeGuard(bool);

        impl Drop for ComUninitializeGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() };
                }
            }
        }

        let _com_guard =
            ComUninitializeGuard(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() });
        let result: windows::core::Result<()> = (|| unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let endpoint_volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            endpoint_volume.SetMute(muted, std::ptr::null())?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                info!(
                    "[MXU_POWER] Audio {} (Windows)",
                    if muted { "muted" } else { "unmuted" }
                );
                true
            }
            Err(e) => {
                log::error!(
                    "[MXU_POWER] Failed to {} audio (Windows): {}",
                    if muted { "mute" } else { "unmute" },
                    e
                );
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let script = if muted {
            "set volume with output muted"
        } else {
            "set volume without output muted"
        };
        match Command::new("osascript").args(["-e", script]).status() {
            Ok(status) if status.success() => {
                info!(
                    "[MXU_POWER] Audio {} (macOS)",
                    if muted { "muted" } else { "unmuted" }
                );
                true
            }
            Ok(status) => {
                log::error!(
                    "[MXU_POWER] Failed to {} audio (macOS), exit status: {}",
                    if muted { "mute" } else { "unmute" },
                    status
                );
                false
            }
            Err(e) => {
                log::error!(
                    "[MXU_POWER] Failed to {} audio (macOS): {}",
                    if muted { "mute" } else { "unmute" },
                    e
                );
                false
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        use std::process::Command;

        let mute_value = if muted { "1" } else { "0" };
        let commands: [(&str, &[&str]); 2] = [
            ("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", mute_value]),
            ("pactl", &["set-sink-mute", "@DEFAULT_SINK@", mute_value]),
        ];

        for (program, args) in commands {
            match Command::new(program).args(args).status() {
                Ok(status) if status.success() => {
                    info!(
                        "[MXU_POWER] Audio {} (Linux, {})",
                        if muted { "muted" } else { "unmuted" },
                        program
                    );
                    return true;
                }
                Ok(status) => warn!(
                    "[MXU_POWER] {} failed to {} audio, exit status: {}",
                    program,
                    if muted { "mute" } else { "unmute" },
                    status
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    info!("[MXU_POWER] {} is unavailable, trying fallback", program)
                }
                Err(e) => warn!(
                    "[MXU_POWER] Failed to run {} while trying to {} audio: {}",
                    program,
                    if muted { "mute" } else { "unmute" },
                    e
                ),
            }
        }

        log::error!(
            "[MXU_POWER] Failed to {} audio: no supported Linux audio control succeeded",
            if muted { "mute" } else { "unmute" }
        );
        false
    }
}

// ============================================================================
// 注册入口
// ============================================================================

/// 为资源注册所有 MXU 内置 custom actions
/// 在资源创建后调用此函数
pub fn register_all_mxu_actions(
    resource: &Resource,
    app_handle: &AppHandle,
    instance_id: &str,
) -> Result<(), String> {
    let mut failed_count = 0;

    // 定义一个局部宏打印日志并统计失败
    macro_rules! reg_action {
        ($name:expr, $fn_name:expr) => {
            let wrapper = move |ctx: &maa_framework::context::Context,
                                args: &maa_framework::custom::ActionArgs|
                  -> bool {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $fn_name(ctx, args)))
                    .unwrap_or_else(|e| {
                        let msg = if let Some(s) = e.downcast_ref::<&str>() {
                            s.to_string()
                        } else if let Some(s) = e.downcast_ref::<String>() {
                            s.clone()
                        } else {
                            "Unknown panic payload".to_string()
                        };
                        log::error!("[MXU] Custom action {} panicked: {}", $name, msg);
                        false
                    })
            };

            if let Err(e) = resource.register_custom_action($name, Box::new(FnAction::new(wrapper)))
            {
                warn!("[MXU] Failed to register {}: {:?}", $name, e);
                failed_count += 1;
            } else {
                info!("[MXU] Custom action {} registered successfully", $name);
            }
        };
    }

    reg_action!(MXU_SLEEP_ACTION, mxu_sleep_action_fn);
    reg_action!(MXU_WAITUNTIL_ACTION, mxu_waituntil_action_fn);
    reg_action!(MXU_LAUNCH_ACTION, mxu_launch_action_fn);
    reg_action!(MXU_WEBHOOK_ACTION, mxu_webhook_action_fn);
    reg_action!(MXU_NOTIFY_ACTION, mxu_notify_action_fn);
    reg_action!(MXU_POWER_ACTION, mxu_power_action_fn);

    let killproc_app_handle = app_handle.clone();
    let killproc_instance_id = instance_id.to_string();
    let killproc_wrapper = move |ctx: &maa_framework::context::Context,
                                 args: &maa_framework::custom::ActionArgs|
          -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mxu_killproc_action_impl(
                ctx,
                args,
                Some(&killproc_app_handle),
                Some(&killproc_instance_id),
            )
        }))
        .unwrap_or_else(|e| {
            let msg = if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else {
                "Unknown panic payload".to_string()
            };
            log::error!(
                "[MXU] Custom action {} panicked: {}",
                MXU_KILLPROC_ACTION,
                msg
            );
            false
        })
    };

    if let Err(e) = resource.register_custom_action(
        MXU_KILLPROC_ACTION,
        Box::new(FnAction::new(killproc_wrapper)),
    ) {
        warn!("[MXU] Failed to register {}: {:?}", MXU_KILLPROC_ACTION, e);
        failed_count += 1;
    } else {
        info!(
            "[MXU] Custom action {} registered successfully",
            MXU_KILLPROC_ACTION
        );
    }

    if failed_count > 0 {
        warn!(
            "[MXU] Failed to register {} custom actions, continuing anyway",
            failed_count
        );
    }

    Ok(())
}
