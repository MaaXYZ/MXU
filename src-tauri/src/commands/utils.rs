//! 辅助函数
//!
//! 提供路径处理和其他通用工具函数

use super::types::{MaaCallbackEvent, MaaState, StateChangedEvent};
use crate::ws_broadcast::{WsBroadcast, WsEvent};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// 发送回调事件到前端（Tauri WebView + WebSocket 浏览器客户端）
pub fn emit_callback_event<S: Into<String>>(
    app: &AppHandle,
    instance_id: &str,
    message: S,
    details: S,
) {
    let message = message.into();
    let details = details.into();

    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<WsBroadcast>>() {
        ws.send(WsEvent::MaaCallback {
            instance_id: instance_id.to_string(),
            message: message.clone(),
            details: details.clone(),
        });
    }

    // 发送到 Tauri WebView
    let event = MaaCallbackEvent {
        instance_id: instance_id.to_string(),
        message,
        details,
    };
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
    lifetime: &super::callback_lifecycle::CallbackGuard,
    message: &str,
    details: &str,
) {
    let is_started = message == "Tasker.Task.Starting";
    let is_succeeded = message == "Tasker.Task.Succeeded";
    let is_failed = message == "Tasker.Task.Failed";

    if !is_started && !is_succeeded && !is_failed {
        return;
    }

    // 解析 task_id 与 entry
    let detail_json = serde_json::from_str::<serde_json::Value>(details).ok();
    let task_id: i64 = match detail_json
        .as_ref()
        .and_then(|v| v.get("task_id").and_then(|id| id.as_i64()))
    {
        Some(id) => id,
        None => return,
    };
    let entry = detail_json
        .as_ref()
        .and_then(|v| v.get("entry").and_then(|e| e.as_str()));
    let mut completion = None;
    {
        let mut instances = match maa_state.instances.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let instance = match instances.get_mut(instance_id) {
            Some(i) => i,
            None => return,
        };
        if !instance.callback_lifetime.is_current(lifetime) {
            return;
        }
        // Old/duplicate events from a removed queue must not mutate a new run.
        if !instance.task_run_state.pending_task_ids.contains(&task_id) {
            // The synthetic stop task was posted by the framework, not by MXU.
            if !is_started
                && entry == Some("MaaTaskerPostStop")
                && instance.queue_result().is_none()
            {
                if let Some((tasker, completion)) = instance.begin_framework_stop() {
                    drop(instances);
                    emit_state_changed(app, instance_id, "task-progress");
                    schedule_run_completion(maa_state, app, instance_id, tasker, completion);
                }
            }
            return;
        }
        if !is_started {
            instance.task_results.insert(task_id, is_succeeded);
        }

        let state = &mut instance.task_run_state;

        if is_started {
            // 任务开始：定位该任务在队列中的索引，更新当前索引和状态
            if let Some(idx) = state.pending_task_ids.iter().position(|&id| id == task_id) {
                state.current_task_index = idx;
            }
            if let Some(selected_id) = state.mappings.get(&task_id).cloned() {
                state.statuses.insert(selected_id, "running".to_string());
            }
        } else {
            // 任务成功或失败
            let status_str = if is_succeeded { "succeeded" } else { "failed" };
            if let Some(selected_id) = state.mappings.get(&task_id).cloned() {
                state.statuses.insert(selected_id, status_str.to_string());
            }

            // selected_task_id is optional in both HTTP APIs. Framework task IDs,
            // rather than UI status mappings, determine whether the queue finished.
            let result = instance.queue_result();
            let all_completed = result.is_some() || instance.stop_in_progress;
            if all_completed {
                completion = instance.begin_completion(result == Some(true));
            } else {
                // A disconnected controller can reject the synthetic stop task.
                // This normal terminal event then owns cleanup of the discarded queue.
                completion = instance.begin_framework_stop();
            }
        }
    }; // 锁在此处释放

    // 遥测埋点（锁外调用，仅操作 telemetry 内部的 RUNS 锁）
    if is_started {
        super::telemetry::on_task_start(instance_id, task_id);
    } else {
        super::telemetry::on_task_finished(instance_id, task_id, is_succeeded);
    }
    // 通知前端刷新状态
    emit_state_changed(app, instance_id, "task-progress");
    if let Some((tasker, completion)) = completion {
        schedule_run_completion(maa_state, app, instance_id, tasker, completion);
    }
}

/// Reconcile an abandoned native queue before a new run can reset its state.
/// The observer may not have been scheduled yet when Start arrives after idle.
pub(super) fn acquire_task_start(
    maa_state: &Arc<MaaState>,
    app: &AppHandle,
    instance_id: &str,
    completion: &Arc<super::run_completion::RunCompletion>,
    reset_state: bool,
) -> Result<super::run_completion::StartPermit, String> {
    loop {
        let permit = completion.acquire_start();
        let abandoned = {
            let mut instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
            let instance = instances.get_mut(instance_id).ok_or("INSTANCE_REPLACED")?;
            if !Arc::ptr_eq(&instance.run_completion, completion) {
                return Err("INSTANCE_REPLACED".into());
            }
            match instance.prepare_submission(reset_state) {
                Err(error) if error == "TASK_QUEUE_ABANDONED" => instance.begin_stop(),
                Err(error) => return Err(error),
                Ok(fresh) => {
                    if fresh {
                        super::focus::begin_run(instance_id);
                    }
                    None
                }
            }
        };
        if let Some((tasker, finishing)) = abandoned {
            drop(permit);
            schedule_run_completion(maa_state, app, instance_id, tasker, finishing);
        } else {
            return Ok(permit);
        }
    }
}

/// Agent PostStop can happen after the last ordinary callback, and disconnect
/// can reject its synthetic stop task. Observe idle without blocking appends.
pub(super) fn schedule_idle_observer(
    maa_state: &Arc<MaaState>,
    app: &AppHandle,
    instance_id: &str,
    completion: Arc<super::run_completion::RunCompletion>,
    generation: u64,
) {
    let maa_state = Arc::clone(maa_state);
    let app = app.clone();
    let instance_id = instance_id.to_string();
    std::thread::spawn(move || loop {
        let abandoned = {
            let Ok(mut instances) = maa_state.instances.lock() else {
                return;
            };
            let Some(instance) = instances.get_mut(&instance_id) else {
                return;
            };
            if !Arc::ptr_eq(&instance.run_completion, &completion)
                || completion.generation() != generation
                || !instance.has_unfinished_queue()
            {
                return;
            }
            if instance.has_abandoned_queue() {
                // A startup/append can be awaiting Agent registration. Never
                // claim its Agents or invalidate its queue while it owns a permit.
                completion.try_acquire_generation(generation).map(|permit| {
                    let finishing = instance.begin_stop();
                    (permit, finishing)
                })
            } else {
                None
            }
        };
        if let Some((permit, finishing)) = abandoned {
            drop(permit);
            if let Some((tasker, finishing)) = finishing {
                emit_state_changed(&app, &instance_id, "task-progress");
                schedule_run_completion(&maa_state, &app, &instance_id, tasker, finishing);
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    });
}

/// Every terminal path shares the same idle/cleanup/notification barrier. Called
/// only after releasing the instance and telemetry locks; begin() owns the worker.
pub(super) fn schedule_run_completion(
    maa_state: &Arc<MaaState>,
    app: &AppHandle,
    instance_id: &str,
    tasker: Option<maa_framework::tasker::Tasker>,
    completion: Arc<super::run_completion::RunCompletion>,
) {
    let maa_state = Arc::clone(maa_state);
    let app = app.clone();
    let instance_id = instance_id.to_string();
    // The framework can become idle only after its callback returns. Never
    // disconnect synchronously on the callback dispatch thread.
    std::thread::spawn(move || {
        completion.finish_when_idle(
            || {
                tasker.as_ref().is_some_and(|tasker| tasker.running())
                    || maa_state.instances.lock().ok().is_some_and(|instances| {
                        instances.get(&instance_id).is_some_and(|instance| {
                            Arc::ptr_eq(&instance.run_completion, &completion)
                                && instance
                                    .tasker
                                    .as_ref()
                                    .is_some_and(|tasker| tasker.running())
                        })
                    })
            },
            || {
                // Start permits are blocked while completion is pending. An
                // already admitted append finishes registering before idle.
                let agents = maa_state.instances.lock().ok().and_then(|mut instances| {
                    instances.get_mut(&instance_id).and_then(|instance| {
                        Arc::ptr_eq(&instance.run_completion, &completion).then(|| {
                            // An already admitted append can extend a queue after
                            // its old terminal callback scheduled this worker.
                            // Reconcile any tail discarded without another callback.
                            if instance.has_unfinished_queue() {
                                instance.begin_stop();
                            }
                            (
                                std::mem::take(&mut instance.agent_clients),
                                std::mem::take(&mut instance.agent_children),
                                instance.stop_in_progress,
                                instance.queue_result() == Some(true),
                            )
                        })
                    })
                });
                if let Some((clients, children, cancelled, succeeded)) = agents {
                    // Finish telemetry after the startup permit: a cancellation
                    // during Agent registration can precede on_run_start. Never
                    // take its RUNS lock while holding the instance lock.
                    if cancelled {
                        super::telemetry::on_run_cancelled(&instance_id);
                    } else {
                        super::telemetry::on_run_finished(&instance_id, succeeded);
                    }
                    super::maa_agent::stop_agent_resources(clients, children);
                }
            },
            || emit_state_changed(&app, &instance_id, "tasks-completed"),
        );
    });
}

/// 发送配置变更事件（双通道：WS 浏览器客户端 + Tauri WebView）
///
/// 发送方 ID 用于准确跳过自身通知，避免按事件到达顺序误吞其它客户端的更新。
pub fn emit_config_changed(app: &AppHandle, client_id: &str, revision: &str) {
    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<WsBroadcast>>() {
        ws.send(WsEvent::ConfigChanged {
            client_id: client_id.to_string(),
            revision: revision.to_string(),
        });
    }

    // 发送到 Tauri WebView
    if let Err(e) = app.emit(
        "config-changed-external",
        serde_json::json!({ "client_id": client_id, "revision": revision }),
    ) {
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
            // 回退到运行时项目目录
            get_exe_directory().unwrap_or_else(|_| PathBuf::from("."))
        })
        .join("debug")
}

/// 获取运行时项目目录（内部使用）：macOS `.app` 内没有 `interface.json` 时为 `.app` 所在目录，否则为可执行文件所在目录。
pub fn get_exe_directory() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("获取 exe 路径失败: {}", e))?;
    project_dir_for_executable(&exe_path).ok_or_else(|| "无法获取 exe 所在目录".to_string())
}

fn project_dir_for_executable(exe_path: &std::path::Path) -> Option<PathBuf> {
    let exe_dir = exe_path.parent()?;

    #[cfg(target_os = "macos")]
    if !exe_dir.join("interface.json").exists() {
        if let Some(project_dir) = macos_app_bundle(exe_path)
            .as_deref()
            .and_then(std::path::Path::parent)
        {
            return Some(project_dir.to_path_buf());
        }
    }

    Some(exe_dir.to_path_buf())
}

#[cfg(any(target_os = "macos", test))]
fn macos_app_bundle(exe_path: &std::path::Path) -> Option<PathBuf> {
    let macos_dir = exe_path.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents_dir.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_macos_app_bundle_inside_project_directory() {
        let bundle = macos_app_bundle(Path::new("project/MXU.app/Contents/MacOS/mxu"));
        assert_eq!(bundle.as_deref(), Some(Path::new("project/MXU.app")));
        assert_eq!(
            bundle.as_deref().and_then(std::path::Path::parent),
            Some(Path::new("project"))
        );
    }

    #[test]
    fn ignores_non_app_executables() {
        assert!(macos_app_bundle(Path::new("project/mxu")).is_none());
        assert!(macos_app_bundle(Path::new("project/MXU.app/mxu")).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_project_dir_follows_interface_location() {
        let root = std::env::temp_dir().join(format!(
            "mxu-project-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("project");
        let macos = project.join("MaaEnd.app/Contents/MacOS");
        let portable = root.join("portable");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(&portable).unwrap();
        let exe = macos.join("MaaEnd");

        assert_eq!(project_dir_for_executable(&exe), Some(project));
        std::fs::write(macos.join("interface.json"), b"{}").unwrap();
        assert_eq!(project_dir_for_executable(&exe), Some(macos));
        assert_eq!(
            project_dir_for_executable(&portable.join("mxu")),
            Some(portable)
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}

/// 获取运行时项目目录下的 maafw 子目录
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

/// macOS 便携目录规范化后，旧资源路径通过符号链接指向此目录。
/// 只接受当前 .app 内的真实资源目录，不能通过符号链接扩大到包外。
#[cfg(any(target_os = "macos", test))]
pub(crate) fn get_macos_bundle_resource_dir(exe_path: &std::path::Path) -> Option<PathBuf> {
    let macos_dir = exe_path.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" || contents.parent()?.extension()? != "app" {
        return None;
    }
    let contents = contents.canonicalize().ok()?;
    let resources = contents
        .join("Resources")
        .join("MXU-portable")
        .canonicalize()
        .ok()?;
    (resources.is_dir() && resources.starts_with(&contents)).then_some(resources)
}

#[cfg(test)]
mod bundle_resource_tests {
    use super::*;

    #[test]
    fn macos_relocated_resources_are_scoped_to_the_current_bundle() {
        let root = std::env::temp_dir().join(format!(
            "mxu-bundle-resources-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let contents = root.join("MaaEnd.app").join("Contents");
        let macos = contents.join("MacOS");
        let executable = macos.join("mxu");
        let resources = contents.join("Resources").join("MXU-portable");
        std::fs::create_dir_all(&macos).unwrap();
        assert!(get_macos_bundle_resource_dir(&executable).is_none());
        std::fs::create_dir_all(&resources).unwrap();
        assert_eq!(
            get_macos_bundle_resource_dir(&executable),
            Some(resources.canonicalize().unwrap())
        );
        assert!(get_macos_bundle_resource_dir(&root.join("mxu")).is_none());
        assert!(get_macos_bundle_resource_dir(&resources.join("mxu")).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
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
