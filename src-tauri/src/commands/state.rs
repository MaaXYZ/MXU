//! 状态查询命令
//!
//! 提供实例状态和缓存数据查询功能

use log::debug;
use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use super::types::{
    AdbDevice, AllInstanceStates, GamescopeInstance, InstanceState, MaaState, Win32Window,
};

/// 获取单个实例的运行时状态
#[tauri::command]
pub fn maa_get_instance_state(
    state: State<Arc<MaaState>>,
    instance_id: String,
) -> Result<InstanceState, String> {
    debug!(
        "maa_get_instance_state called, instance_id: {}",
        instance_id
    );

    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
    let instance = instances
        .get_mut(&instance_id)
        .ok_or("Instance not found")?;

    // 通过 Maa API 查询真实状态
    let is_running = instance.is_running();

    if !is_running && instance.stop_in_progress {
        instance.stop_in_progress = false;
        instance.stop_started_at = None;
    }

    Ok(InstanceState {
        connected: instance.controller.as_ref().is_some_and(|c| c.connected()),
        resource_loaded: instance.resource.as_ref().is_some_and(|r| r.loaded()),
        tasker_inited: instance.tasker.as_ref().is_some_and(|t| t.inited()),
        is_running,
        task_run_state: instance.task_run_state.clone(),
    })
}

/// 获取所有实例的状态快照（用于前端启动时恢复状态）
#[tauri::command]
pub fn maa_get_all_states(state: State<Arc<MaaState>>) -> Result<AllInstanceStates, String> {
    debug!("maa_get_all_states called");

    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
    let cached_adb = state.cached_adb_devices.lock().map_err(|e| e.to_string())?;
    let cached_win32 = state
        .cached_win32_windows
        .lock()
        .map_err(|e| e.to_string())?;
    let cached_wlroots = state
        .cached_wlroots_sockets
        .lock()
        .map_err(|e| e.to_string())?;
    let cached_gamescope_instances = state
        .cached_gamescope_instances
        .lock()
        .map_err(|e| e.to_string())?;

    let mut instance_states = HashMap::new();

    for (id, instance) in instances.iter_mut() {
        // 通过 Maa API 查询真实状态
        let is_running = instance.is_running();

        if !is_running && instance.stop_in_progress {
            instance.stop_in_progress = false;
            instance.stop_started_at = None;
        }

        instance_states.insert(
            id.clone(),
            InstanceState {
                connected: instance.controller.as_ref().is_some_and(|c| c.connected()),
                resource_loaded: instance.resource.as_ref().is_some_and(|r| r.loaded()),
                tasker_inited: instance.tasker.as_ref().is_some_and(|t| t.inited()),
                is_running,
                task_run_state: instance.task_run_state.clone(),
            },
        );
    }

    Ok(AllInstanceStates {
        instances: instance_states,
        cached_adb_devices: cached_adb.clone(),
        cached_win32_windows: cached_win32.clone(),
        cached_wlroots_sockets: cached_wlroots.clone(),
        cached_gamescope_instances: cached_gamescope_instances.clone(),
    })
}

/// 获取缓存的 ADB 设备列表
#[tauri::command]
pub fn maa_get_cached_adb_devices(state: State<Arc<MaaState>>) -> Result<Vec<AdbDevice>, String> {
    debug!("maa_get_cached_adb_devices called");
    let cached = state.cached_adb_devices.lock().map_err(|e| e.to_string())?;
    Ok(cached.clone())
}

/// 获取缓存的 Win32 窗口列表
#[tauri::command]
pub fn maa_get_cached_win32_windows(
    state: State<Arc<MaaState>>,
) -> Result<Vec<Win32Window>, String> {
    debug!("maa_get_cached_win32_windows called");
    let cached = state
        .cached_win32_windows
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(cached.clone())
}

/// 获取缓存的 WlRoots socket 列表
#[tauri::command]
pub fn maa_get_cached_wlroots_sockets(state: State<Arc<MaaState>>) -> Result<Vec<String>, String> {
    debug!("maa_get_cached_wlroots_sockets called");
    let cached = state
        .cached_wlroots_sockets
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(cached.clone())
}

/// 获取缓存的 gamescope 实例列表
#[tauri::command]
pub fn maa_get_cached_gamescope_instances(
    state: State<Arc<MaaState>>,
) -> Result<Vec<GamescopeInstance>, String> {
    debug!("maa_get_cached_gamescope_instances called");
    let cached = state
        .cached_gamescope_instances
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(cached.clone())
}

/// 由前端调用，将已格式化的日志行输出到 stdout
#[tauri::command]
pub fn log_to_stdout(message: String) {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S.%3f");
    for line in message.lines() {
        println!("[{timestamp}] {line}");
    }
}

/// 前端推送一条运行日志到后端缓冲区
#[tauri::command]
pub fn push_log(
    state: State<Arc<MaaState>>,
    instance_id: String,
    entry: super::types::LogEntryDto,
) -> Result<(), String> {
    let mut buffer = state.log_buffer.lock().map_err(|e| e.to_string())?;
    buffer.push(&instance_id, entry);
    Ok(())
}

/// 获取所有实例的运行日志（用于页面刷新后恢复）
#[tauri::command]
pub fn get_all_logs(
    state: State<Arc<MaaState>>,
) -> Result<HashMap<String, Vec<super::types::LogEntryDto>>, String> {
    let buffer = state.log_buffer.lock().map_err(|e| e.to_string())?;
    Ok(buffer
        .get_all()
        .iter()
        .map(|(k, v)| (k.clone(), v.iter().cloned().collect()))
        .collect())
}

/// 清空指定实例的运行日志
#[tauri::command]
pub fn clear_instance_logs(state: State<Arc<MaaState>>, instance_id: String) -> Result<(), String> {
    let mut buffer = state.log_buffer.lock().map_err(|e| e.to_string())?;
    buffer.clear_instance(&instance_id);
    Ok(())
}
