//! 辅助函数
//!
//! 提供路径处理和其他通用工具函数

use super::types::{MaaCallbackEvent, MaaState, StateChangedEvent};
use crate::ws_broadcast::{WsBroadcast, WsEvent};
use log::{error, warn};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// 发送回调事件到前端（Tauri WebView + WebSocket 浏览器客户端）
pub fn emit_callback_event<S: Into<String>>(app: &AppHandle, message: S, details: S) {
    let message = message.into();
    let details = details.into();

    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<WsBroadcast>>() {
        ws.send(WsEvent::MaaCallback {
            message: message.clone(),
            details: details.clone(),
        });
    }

    // 发送到 Tauri WebView
    let event = MaaCallbackEvent { message, details };
    if let Err(e) = app.emit("maa-callback", event) {
        log::error!("Failed to emit maa-callback: {}", e);
    }
}

/// 发送实例状态变更事件（双通道：WS 浏览器客户端 + Tauri WebView）
///
/// Tauri 端和 WebUI 端都会收到此事件，用于刷新 `isRunning`、连接状态等运行时信息。
pub fn emit_state_changed(app: &AppHandle, instance_id: &str, kind: &str) {
    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<WsBroadcast>>() {
        ws.send(WsEvent::StateChanged {
            instance_id: instance_id.to_string(),
            kind: kind.to_string(),
        });
    }

    // 发送到 Tauri WebView
    let event = StateChangedEvent {
        instance_id: instance_id.to_string(),
        kind: kind.to_string(),
    };
    if let Err(e) = app.emit("state-changed", event) {
        log::error!("Failed to emit state-changed: {}", e);
    }
}

/// 处理 MaaFramework 任务回调，在 Rust 侧更新 TaskRunState（单一真相来源）
///
/// 应在 tasker sink 中调用，在 `emit_callback_event` 之前处理任务状态变更。
/// 负责跟踪 Tasker.Task.Starting / Succeeded / Failed，并在所有任务完成后
/// 更新 `overall_status` 并发射 `tasks-completed` 事件。
pub fn handle_task_callback(
    maa_state: &Arc<MaaState>,
    app: &AppHandle,
    instance_id: &str,
    message: &str,
    details: &str,
) {
    let is_started = message == "Tasker.Task.Starting";
    let is_succeeded = message == "Tasker.Task.Succeeded";
    let is_failed = message == "Tasker.Task.Failed";

    if !is_started && !is_succeeded && !is_failed {
        return;
    }

    // 解析 task_id
    let task_id: i64 = match serde_json::from_str::<serde_json::Value>(details)
        .ok()
        .and_then(|v| v.get("task_id").and_then(|id| id.as_i64()))
    {
        Some(id) => id,
        None => return,
    };

    let all_done = {
        let mut instances = match maa_state.instances.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let instance = match instances.get_mut(instance_id) {
            Some(i) => i,
            None => return,
        };
        let state = &mut instance.task_run_state;

        if is_started {
            // 任务开始：定位该任务在队列中的索引，更新当前索引和状态
            if let Some(idx) = state.pending_task_ids.iter().position(|&id| id == task_id) {
                state.current_task_index = idx;
            }
            if let Some(selected_id) = state.mappings.get(&task_id).cloned() {
                state.statuses.insert(selected_id, "running".to_string());
            }
            false // 未完成
        } else {
            // 任务成功或失败
            let status_str = if is_succeeded { "succeeded" } else { "failed" };
            if let Some(selected_id) = state.mappings.get(&task_id).cloned() {
                state.statuses.insert(selected_id, status_str.to_string());
            }

            // 检查所有已入队任务是否均已完成
            let all_completed = state.pending_task_ids.iter().all(|id| {
                state
                    .mappings
                    .get(id)
                    .and_then(|sel_id| state.statuses.get(sel_id))
                    .map(|s| s == "succeeded" || s == "failed")
                    .unwrap_or(false)
            });

            if all_completed {
                let has_failed = state.statuses.values().any(|s| s == "failed");
                state.overall_status =
                    Some(if has_failed { "Failed" } else { "Succeeded" }.to_string());
                instance.task_ids.clear();
            }

            all_completed
        }
    }; // 锁在此处释放

    // 遥测埋点（锁外调用，仅操作 telemetry 内部的 RUNS 锁）
    if is_started {
        super::telemetry::on_task_start(instance_id, task_id);
    } else {
        super::telemetry::on_task_finished(instance_id, task_id, is_succeeded);
    }
    if all_done {
        super::telemetry::on_run_finished(instance_id);
    }

    // 通知前端刷新状态
    emit_state_changed(app, instance_id, "task-progress");
    if all_done {
        emit_state_changed(app, instance_id, "tasks-completed");

        // 实例内全部任务结束后清理旧 agent，避免 agent 进程跨轮累积
        if let Err(e) = super::maa_agent::stop_agent_impl(maa_state, instance_id) {
            log::warn!(
                "[handle_task_callback] Failed to stop agents after tasks completed: {}",
                e
            );
        }
    }
}

/// 发送配置变更事件（双通道：WS 浏览器客户端 + Tauri WebView）
///
/// 各客户端收到后应重新拉取配置并 `importConfig`（需配合 `consumeSelfSave` 跳过自身触发）。
pub fn emit_config_changed(app: &AppHandle) {
    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<WsBroadcast>>() {
        ws.send(WsEvent::ConfigChanged);
    }

    // 发送到 Tauri WebView
    if let Err(e) = app.emit("config-changed-external", ()) {
        log::error!("Failed to emit config-changed-external: {}", e);
    }
}

/// 获取应用数据目录
/// - macOS: ~/Library/Application Support/MXU/
/// - Windows/Linux: exe 所在目录（保持便携式部署）
pub fn get_app_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "无法获取 HOME 环境变量".to_string())?;
        let path = PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("MXU");
        Ok(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux 保持便携式，使用 exe 所在目录
        get_exe_directory()
    }
}

/// 规范化路径：移除冗余的 `.`、处理 `..`、统一分隔符
/// 使用 Path::components() 解析，不需要路径实际存在
pub fn normalize_path(path: &str) -> PathBuf {
    use std::path::{Component, Path};

    let path = Path::new(path);
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            // 跳过当前目录标记 "."
            Component::CurDir => {}
            // 处理父目录 ".."：如果栈顶是普通目录则弹出，否则保留
            Component::ParentDir => {
                if matches!(components.last(), Some(Component::Normal(_))) {
                    components.pop();
                } else {
                    components.push(component);
                }
            }
            // 保留其他组件（Prefix、RootDir、Normal）
            _ => components.push(component),
        }
    }

    // 重建路径
    components.into_iter().collect()
}

/// 获取日志目录（应用数据目录下的 debug 子目录）
pub fn get_logs_dir() -> PathBuf {
    get_app_data_dir()
        .unwrap_or_else(|_| {
            // 回退到 exe 目录
            let exe_path = std::env::current_exe().unwrap_or_default();
            exe_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .to_path_buf()
        })
        .join("debug")
}

/// 获取 exe 所在目录路径（内部使用）
pub fn get_exe_directory() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取 exe 路径失败: {}", e))?;
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "无法获取 exe 所在目录".to_string())
}

/// 获取可执行文件所在目录下的 maafw 子目录
pub fn get_maafw_dir() -> Result<PathBuf, String> {
    Ok(get_exe_directory()?.join("maafw"))
}

/// 构建 User-Agent 字符串
pub fn build_user_agent() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let tauri_version = tauri::VERSION;
    format!("MXU/{} ({}; {}) Tauri/{}", version, os, arch, tauri_version)
}

/// 构建启动程序的 Command
///
/// - 子进程的 stdout/stderr 设为 null，避免继承父进程的标准流。
/// - 当 `use_cmd` 为 true 时（仅 Windows），通过 `cmd /c` 启动并设置
///   `CREATE_NO_WINDOW` 标志隐藏控制台窗口。
///
/// 注意：曾经使用 `CREATE_BREAKAWAY_FROM_JOB` 使子进程脱离父进程 Job 对象，
/// 但 Windows 计划任务创建的 Job 默认不允许 breakaway（未设置
/// `JOB_OBJECT_LIMIT_BREAKAWAY_OK`），导致 `CreateProcessW` 返回
/// `ERROR_ACCESS_DENIED (os error 5)`。
///
/// 手动启动 MXU 时，MXU 不在任何 Job Object 中，该标志没有 Job 可脱离，
/// 被 Windows 静默忽略，因此不会报错——但这只是巧合，不代表该标志真正生效。
/// 计划任务启动时，MXU 被关在限制性 Job 中，该标志才真正触发错误。
///
/// `cmd /c` 本身已改变了 PPID 链，进程树隔离目的已达成，因此移除该标志。
pub fn build_launch_command(
    program: &str,
    args: &[String],
    use_cmd: bool,
) -> std::process::Command {
    use std::process::Stdio;

    let mut cmd = if cfg!(target_os = "windows") && use_cmd {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/c").arg(program);
        if !args.is_empty() {
            c.args(args);
        }
        c
    } else {
        let mut c = std::process::Command::new(program);
        if !args.is_empty() {
            c.args(args);
        }
        c
    };

    // 不继承父进程的标准流
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    if use_cmd {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// 获取当前 instance 所有已勾选 task 的状态
///
/// - 输出为数组，按照 instance 中 task 的顺序排列。
/// - 数组的每项是一个包含两个字符串的数组：[任务名称(i18n), 任务状态("idle","pending","running","succeeded","failed")]。
pub fn get_checked_task_status_of_instance(
    app_handle: Option<&AppHandle>,
    instance_id: Option<&str>,
) -> Vec<Vec<String>> {
    let app_config_state =
        match app_handle.and_then(|app| app.try_state::<Arc<crate::commands::AppConfigState>>()) {
            Some(state) => state,
            None => {
                error!("[MXU_STATUS] fail to get resource [app_config_state]");
                return vec![];
            }
        };
    let translations = match app_config_state.translations.lock() {
        Ok(guard) => guard,
        Err(e) => {
            error!(
                "[MXU_STATUS] fail to lock resource [app_config_state.translations]: {:?}",
                e
            );
            return vec![];
        }
    };
    let config = match app_config_state.config.lock() {
        Ok(guard) => guard,
        Err(e) => {
            error!(
                "[MXU_STATUS] fail to lock resource [app_config_state.config]: {:?}",
                e
            );
            return vec![];
        }
    };

    // i18n
    let language = config
        .get("settings")
        .and_then(|v| v.get("language"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    let i18n = translations
        .get(match language {
            // get i18n task name by (i18n["task.<task-name>.label"])
            "zh-TW" => "zh_tw",
            "en-US" => "en_us",
            "ja-JP" => "ja_jp",
            "ko-KR" => "ko_kr",
            _ => "zh_cn",
        })
        .unwrap_or_default();

    // instance (config)
    let id = instance_id.unwrap_or("");
    let instance_config_list = match config.get("instances").and_then(|v| v.as_array()) {
        Some(list) => list,
        None => {
            error!("[MXU_STATUS] config data [configs/mxu-*.json > .instances] should be [array]");
            return vec![];
        }
    };
    let instance_config = match instance_config_list
        .iter()
        .find(|inst| inst.get("id").and_then(|v| v.as_str()) == Some(id))
    {
        Some(inst) => inst,
        None => {
            error!(
                "[MXU_STATUS] config data [configs/mxu-*.json > .instances] should contains [object] item whose [.id = {}]",
                id
            );
            return vec![];
        }
    };

    // instance (runtime)
    let maa_state =
        match app_handle.and_then(|app| app.try_state::<Arc<crate::commands::MaaState>>()) {
            Some(state) => state,
            None => {
                error!("[MXU_STATUS] fail to get resource [maa_state]");
                return vec![];
            }
        };

    let instance_runtime_list = match maa_state.instances.lock() {
        Ok(guard) => guard,
        Err(e) => {
            error!("[MXU_STATUS] fail to lock resource [maa_state]: {:?}", e);
            return vec![];
        }
    };

    let instance_runtime = match instance_runtime_list.get(id) {
        Some(runtime) => runtime,
        None => {
            error!(
                "[MXU_STATUS] runtime data [maa_state.instances[{}]] should be [object]",
                id
            );
            return vec![];
        }
    };

    return instance_runtime
        .task_run_state
        .pending_task_ids
        .iter()
        .filter_map(|&maa_task_id| {
            if let Some(selected_task_id) =
                instance_runtime.task_run_state.mappings.get(&maa_task_id)
            {
                if let Some(status) = instance_runtime
                    .task_run_state
                    .statuses
                    .get(selected_task_id)
                {
                    let task_config_list = instance_config.get("tasks")?.as_array()?;
                    let task_config = task_config_list.iter().find(|task| {
                        task.get("id").and_then(|v| v.as_str()) == Some(selected_task_id.as_str())
                    })?;
                    let task_name = task_config
                        .get("taskName")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or("".to_string());
                    let custom_name = task_config
                        .get("customName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let task_name_i18n = i18n
                        .get(format!("task.{}.label", task_name))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or("".to_string());
                    // custom name / task name (i18n) / task name
                    // => task status ("idle","pending","running","succeeded","failed")
                    let name: String = if !custom_name.is_empty() {
                        custom_name
                    } else if !task_name_i18n.is_empty() {
                        task_name_i18n
                    } else if !task_name.is_empty(){
                        task_name
                    } else {
                        warn!(
                            "[MXU_STATUS] config data [configs/mxu-*.json > .instances[.id = {}].tasks[.id = {}].taskName] should be [non-empty string]",
                            id,
                            selected_task_id
                        );
                        return None
                    };
                    return Some(vec![name, status.to_string()])
                } else {
                    warn!(
                        "[MXU_STATUS] status not found in runtime data [maa_state.instances[{}].task_run_state.statuses] for task in config data [configs/mxu-*.json > .instances[.id = {}].tasks[.id = {}]",
                        id,
                        id,
                        selected_task_id
                    );
                    return None
                }
            } else {
                warn!(
                    "[MXU_STATUS] task not found in config data [configs/mxu-*.json > .instances[.id = {}] related to runtime data [maa_state.instances[{}].task_run_state.pending_task_ids]",
                    id,
                    id
                );
                return None
            }
        })
        .collect();
}
