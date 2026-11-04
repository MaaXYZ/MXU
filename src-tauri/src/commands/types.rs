//! 类型定义
//!
//! 包含 Tauri 命令使用的数据结构和枚举

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use maa_framework::agent_client::AgentClient;
use maa_framework::controller::Controller;
use maa_framework::resource::Resource;
use maa_framework::tasker::Tasker;

// ============================================================================
// 数据类型定义
// ============================================================================

/// ADB 设备信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdbDevice {
    pub name: String,
    pub adb_path: String,
    pub address: String,
    #[serde(with = "u64_as_string")]
    pub screencap_methods: u64,
    #[serde(with = "u64_as_string")]
    pub input_methods: u64,
    pub config: String,
}

/// 将 u64 序列化/反序列化为字符串，避免 JavaScript 精度丢失
mod u64_as_string {
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse::<u64>().map_err(serde::de::Error::custom)
    }
}

/// Win32 窗口信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Win32Window {
    pub handle: u64,
    pub class_name: String,
    pub window_name: String,
}

/// gamescope 实例（同一 display 上的截图节点 + libei 输入 socket）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamescopeInstance {
    pub display_no: u32,
    pub pipewire_node_id: u32,
    pub eis_socket_path: String,
}

/// 控制器类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "type")]
pub enum ControllerConfig {
    Adb {
        adb_path: String,
        address: String,
        screencap_methods: String, // u64 作为字符串传递，避免 JS 精度丢失
        input_methods: String,     // u64 作为字符串传递
        config: String,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    Win32 {
        handle: u64,
        screencap_method: u64,
        mouse_method: u64,
        keyboard_method: u64,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    MacOS {
        handle: u64,
        screencap_method: u64,
        input_method: u64,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    WlRoots {
        wlr_socket_path: String,
        #[serde(default)]
        use_win32_vk_code: bool,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    Gamepad {
        handle: u64,
        #[serde(default)]
        gamepad_type: Option<String>,
        #[serde(default)]
        screencap_method: Option<u64>,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    PlayCover {
        address: String,
        #[serde(default)]
        uuid: Option<String>,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
    /// Linux 原生控制器（截图：Wlr/PipeWire，输入：Wlr/UInput/Libei）
    Linux {
        screencap_method: u64,
        input_method: u64,
        #[serde(default)]
        pipewire_source: Option<String>,
        #[serde(default)]
        wlr_socket_path: Option<String>,
        #[serde(default)]
        pw_socket_fd: Option<i32>,
        #[serde(default)]
        pw_node_id: Option<u32>,
        #[serde(default)]
        uinput_path: Option<String>,
        #[serde(default)]
        uinput_screen_width: Option<i32>,
        #[serde(default)]
        uinput_screen_height: Option<i32>,
        #[serde(default)]
        eis_socket_path: Option<String>,
        #[serde(default)]
        use_win32_vk_code: Option<bool>,
        #[serde(default)]
        display_short_side: Option<i32>,
        #[serde(default)]
        display_long_side: Option<i32>,
        #[serde(default)]
        display_expand: Option<[i32; 2]>,
        #[serde(default)]
        display_raw: Option<bool>,
    },
}

impl ControllerConfig {
    pub fn display_options(&self) -> super::controller_display::DisplayOptions {
        match self {
            Self::Adb {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::Win32 {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::MacOS {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::WlRoots {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::Gamepad {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::PlayCover {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            }
            | Self::Linux {
                display_short_side,
                display_long_side,
                display_expand,
                display_raw,
                ..
            } => super::controller_display::DisplayOptions {
                short: *display_short_side,
                long: *display_long_side,
                expand: *display_expand,
                raw: *display_raw,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ControllerConfig, ControllerEventSubscribers, MaaCallbackEvent};
    use std::sync::{Arc, Mutex};

    #[test]
    fn shared_controller_callbacks_follow_subscription_lifecycle() {
        let subscribers = ControllerEventSubscribers::default();
        let received = Arc::new(Mutex::new(Vec::new()));
        for instance_id in ["adb-a", "adb-b"] {
            let received = Arc::clone(&received);
            subscribers.subscribe(
                instance_id,
                Arc::new(move |message, details| {
                    received.lock().unwrap().push((
                        instance_id,
                        message.to_string(),
                        details.to_string(),
                    ));
                }),
            );
        }
        subscribers.emit("Controller.Action.Succeeded", r#"{"ctrl_id":1}"#);
        let mut first = received.lock().unwrap().drain(..).collect::<Vec<_>>();
        first.sort();
        assert_eq!(
            first.iter().map(|event| event.0).collect::<Vec<_>>(),
            ["adb-a", "adb-b"]
        );
        assert!(
            first
                .iter()
                .all(|event| event.1 == "Controller.Action.Succeeded"
                    && event.2 == r#"{"ctrl_id":1}"#)
        );

        // A switched controllers (or was destroyed); the shared handle still belongs to B.
        subscribers.unsubscribe("adb-a");
        subscribers.emit("Controller.Action.Failed", "{}");
        assert_eq!(
            *received.lock().unwrap(),
            [(
                "adb-b",
                "Controller.Action.Failed".to_string(),
                "{}".to_string()
            )]
        );
    }

    #[test]
    fn controller_subscriber_can_unsubscribe_during_callback() {
        let subscribers = Arc::new(ControllerEventSubscribers::default());
        let weak_subscribers = Arc::downgrade(&subscribers);
        let calls = Arc::new(Mutex::new(0));
        let callback_calls = Arc::clone(&calls);
        subscribers.subscribe(
            "adb-a",
            Arc::new(move |_, _| {
                *callback_calls.lock().unwrap() += 1;
                weak_subscribers.upgrade().unwrap().unsubscribe("adb-a");
            }),
        );
        subscribers.emit("Controller.Action.Succeeded", "{}");
        subscribers.emit("Controller.Action.Succeeded", "{}");
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[test]
    fn tauri_callback_payload_preserves_instance_source() {
        let event = MaaCallbackEvent {
            instance_id: "adb-a".to_string(),
            message: "Tasker.Task.Succeeded".to_string(),
            details: r#"{"task_id":42}"#.to_string(),
        };
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(wire["instance_id"], "adb-a");
        let decoded: MaaCallbackEvent = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded.instance_id, event.instance_id);
        assert_eq!(decoded.message, event.message);
        assert_eq!(decoded.details, event.details);
    }

    #[test]
    fn deserializes_macos_controller_config_with_default_display_short_side() {
        let config: ControllerConfig = serde_json::from_str(
            r#"{"type":"MacOS","handle":42,"screencap_method":1,"input_method":2}"#,
        )
        .expect("MacOS controller config should deserialize");

        assert_eq!(
            config,
            ControllerConfig::MacOS {
                handle: 42,
                screencap_method: 1,
                input_method: 2,
                display_short_side: None,
                display_long_side: None,
                display_expand: None,
                display_raw: None,
            }
        );
    }
}

/// 连接状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Failed(String),
}

/// 任务状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
}

/// 任务运行状态（后端管理，作为单一真相来源）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskRunState {
    /// selectedTaskId → status ("idle"/"pending"/"running"/"succeeded"/"failed")
    pub statuses: HashMap<String, String>,
    /// maaTaskId → selectedTaskId
    pub mappings: HashMap<i64, String>,
    /// 任务队列（maaTaskId 列表，执行顺序）
    pub pending_task_ids: Vec<i64>,
    /// 当前执行到的任务索引
    pub current_task_index: usize,
    /// 实例级整体状态（None/"Running"/"Succeeded"/"Failed"）
    pub overall_status: Option<String>,
}

/// 实例运行时状态（用于前端查询）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceState {
    /// 控制器是否已连接（通过 MaaControllerConnected API 查询）
    pub connected: bool,
    /// 资源是否已加载（通过 MaaResourceLoaded API 查询）
    pub resource_loaded: bool,
    /// Tasker 是否已初始化
    pub tasker_inited: bool,
    /// 是否有任务正在运行（通过 MaaTaskerRunning API 查询）
    pub is_running: bool,
    /// 任务运行状态（后端管理，包含逐任务状态、映射、队列）
    pub task_run_state: TaskRunState,
}

/// 所有实例状态的快照
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllInstanceStates {
    pub instances: HashMap<String, InstanceState>,
    pub cached_adb_devices: Vec<AdbDevice>,
    pub cached_win32_windows: Vec<Win32Window>,
    pub cached_wlroots_sockets: Vec<String>,
    pub cached_gamescope_instances: Vec<GamescopeInstance>,
}

/// 实例运行时状态（持有 MaaFramework 对象句柄）
#[derive(Default)]
pub struct InstanceRuntime {
    /// Invalidates late callbacks when an instance ID is destroyed and recreated.
    pub callback_lifetime: super::callback_lifecycle::CallbackGuard,
    /// Identifies the latest controller connection request for this instance.
    pub controller_request: super::callback_lifecycle::CallbackGuard,
    pub resource: Option<Resource>,
    pub controller: Option<Controller>,
    /// 此实例订阅的控制器事件。独立保存句柄，以便池条目替换后仍能解除旧订阅。
    pub controller_subscribers: Option<Arc<ControllerEventSubscribers>>,
    /// 当前控制器的配置（用于 ControllerPool 引用管理）
    pub controller_config: Option<ControllerConfig>,
    pub tasker: Option<Tasker>,
    pub agent_clients: Vec<AgentClient>,
    pub agent_children: Vec<Child>,
    /// 当前运行的任务 ID 列表（用于刷新后恢复状态）
    pub task_ids: Vec<i64>,
    /// 是否正在停止任务（用于防重复 stop）
    pub stop_in_progress: bool,
    /// stop 请求的起始时间（用于节流/重试）
    pub stop_started_at: Option<Instant>,
    /// 任务运行状态（后端管理，单一真相来源）
    pub task_run_state: TaskRunState,
}

impl Drop for InstanceRuntime {
    fn drop(&mut self) {
        self.callback_lifetime.cancel();
        self.controller_request.cancel();
        // 断开并销毁所有 agent
        for client in &self.agent_clients {
            let _ = client.disconnect();
        }
        self.agent_clients.clear();

        // 终止并回收所有 agent 子进程
        for mut child in self.agent_children.drain(..) {
            let _ = child.kill();
            let _ = child.wait();
        }

        if let Some(tasker) = self.tasker.take() {
            drop(tasker);
        }
        if let Some(controller) = self.controller.take() {
            drop(controller);
        }
        if let Some(resource) = self.resource.take() {
            drop(resource);
        }
    }
}

/// 前端运行日志条目（用于跨页面刷新持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntryDto {
    pub id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub log_type: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

/// 每个实例的日志缓冲区默认上限
const DEFAULT_MAX_LOGS: usize = 2000;

/// 运行日志缓冲区（按实例隔离，支持容量限制）
pub struct LogBuffer {
    logs: HashMap<String, VecDeque<LogEntryDto>>,
    max_per_instance: usize,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self {
            logs: HashMap::new(),
            max_per_instance: DEFAULT_MAX_LOGS,
        }
    }
}

impl LogBuffer {
    pub fn new(max_per_instance: usize) -> Self {
        Self {
            logs: HashMap::new(),
            max_per_instance: max_per_instance.max(100),
        }
    }

    pub fn push(&mut self, instance_id: &str, entry: LogEntryDto) {
        let entries = self.logs.entry(instance_id.to_string()).or_default();
        entries.push_back(entry);
        while entries.len() > self.max_per_instance {
            entries.pop_front();
        }
    }

    pub fn get_all(&self) -> &HashMap<String, VecDeque<LogEntryDto>> {
        &self.logs
    }

    pub fn clear_instance(&mut self, instance_id: &str) {
        if let Some(entries) = self.logs.get_mut(instance_id) {
            entries.clear();
        }
    }

    pub fn set_max(&mut self, max: usize) {
        self.max_per_instance = max.max(100);
    }
}

/// ControllerPool 的回调订阅按实例维护，避免复用控制器后仍只通知最初的实例。
pub type ControllerEventCallback = Arc<dyn Fn(&str, &str) + Send + Sync + 'static>;

#[derive(Default)]
pub struct ControllerEventSubscribers {
    callbacks: Mutex<HashMap<String, ControllerEventCallback>>,
}

impl ControllerEventSubscribers {
    pub fn subscribe(&self, instance_id: &str, callback: ControllerEventCallback) {
        self.callbacks
            .lock()
            .unwrap()
            .insert(instance_id.to_string(), callback);
    }

    pub fn unsubscribe(&self, instance_id: &str) {
        self.callbacks.lock().unwrap().remove(instance_id);
    }

    pub fn emit(&self, message: &str, details: &str) {
        // 先取快照、再释放锁。订阅者可以在回调中更新订阅，不阻塞池的生命周期操作。
        let callbacks: Vec<_> = self.callbacks.lock().unwrap().values().cloned().collect();
        for callback in callbacks {
            callback(message, details);
        }
    }
}

#[derive(Clone)]
pub struct ControllerPoolEntry {
    pub controller: Controller,
    pub subscribers: Arc<ControllerEventSubscribers>,
    pub connection_id: i64,
}

/// MaaFramework 运行时状态
#[derive(Default)]
pub struct MaaState {
    pub lib_dir: Mutex<Option<PathBuf>>,
    pub resource_dir: Mutex<Option<PathBuf>>,
    pub instances: Mutex<HashMap<String, InstanceRuntime>>,
    /// 前置程序停止请求（用于中断等待退出）
    pub pre_action_stop_requests: Mutex<HashSet<String>>,
    /// Controller 连接池：相同配置的 Controller 复用同一个 MaaControllerHandle
    pub controller_pool: Mutex<HashMap<ControllerConfig, ControllerPoolEntry>>,
    pub controller_connection_gates: super::callback_lifecycle::ConnectionGates<ControllerConfig>,
    /// 缓存的 ADB 设备列表（全局共享，避免重复搜索）
    pub cached_adb_devices: Mutex<Vec<AdbDevice>>,
    /// 缓存的 Win32 窗口列表（全局共享）
    pub cached_win32_windows: Mutex<Vec<Win32Window>>,
    /// 缓存的 WlRoots socket 列表（全局共享）
    pub cached_wlroots_sockets: Mutex<Vec<String>>,
    /// 缓存的 gamescope 实例列表（全局共享）
    pub cached_gamescope_instances: Mutex<Vec<GamescopeInstance>>,
    /// Portal ScreenCast 会话的 restore token（仅存内存，不落盘）
    pub portal_restore_token: Mutex<Option<String>>,
    /// 运行日志缓冲区（前端推送，页面刷新后恢复）
    pub log_buffer: Mutex<LogBuffer>,
    /// 后端统一截图服务（确保每实例只有一份 post_screencap 在运行）
    pub screenshot_service: crate::screenshot_service::ScreenshotService,
}

impl MaaState {
    /// 清理所有实例的 agent 子进程
    pub fn cleanup_all_agent_children(&self) {
        if let Ok(mut instances) = self.instances.lock() {
            for (id, instance) in instances.iter_mut() {
                for mut child in instance.agent_children.drain(..) {
                    log::info!("Killing agent child process for instance: {}", id);
                    if let Err(e) = child.kill() {
                        log::warn!(
                            "Failed to kill agent child process for instance {}: {:?}",
                            id,
                            e
                        );
                    }
                    // 回收子进程，避免 *nix 上产生僵尸进程
                    let _ = child.wait();
                }
            }
        }
    }
}

/// Maa回调事件
#[derive(Clone, Serialize, Deserialize)]
pub struct MaaCallbackEvent {
    pub instance_id: String,
    pub message: String,
    pub details: String,
}

/// 实例状态变更事件（用于 Tauri WebView 端监听）
#[derive(Clone, Serialize, Deserialize)]
pub struct StateChangedEvent {
    pub instance_id: String,
    pub kind: String,
}

/// Agent 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub child_exec: String,
    pub child_args: Option<Vec<String>>,
    pub identifier: Option<String>,
    /// 连接超时时间（毫秒），-1 表示无限等待
    pub timeout: Option<i64>,
}

/// 任务配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskConfig {
    pub entry: String,
    pub pipeline_override: String,
    /// 对应的前端选中任务 ID（用于后端跟踪 per-task 状态）
    #[serde(default)]
    pub selected_task_id: Option<String>,
    /// interface 任务名（如 `SwitchTeam`），仅用于遥测埋点
    #[serde(default)]
    pub task_name: Option<String>,
    /// 任务选项摘要（已由前端脱敏），仅用于遥测埋点
    #[serde(default)]
    pub options: Option<BTreeMap<String, String>>,
}

/// 当前 controller 描述（前端传入，仅用于遥测埋点）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControllerInfo {
    /// interface 中的 controller 名，如 `Win32-Front`
    #[serde(default)]
    pub name: Option<String>,
    /// controller 类型，如 `Win32`/`Adb`
    #[serde(default, rename = "type")]
    pub type_name: Option<String>,
}

/// 版本检查结果
#[derive(Serialize)]
pub struct VersionCheckResult {
    /// 当前 MaaFramework 版本
    pub current: String,
    /// 最小支持版本
    pub minimum: String,
    /// 是否满足最小版本要求
    pub is_compatible: bool,
}

/// changes.json 结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesJson {
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub deleted: Vec<String>,
    #[serde(default)]
    pub modified: Vec<String>,
}

/// 下载进度事件数据
#[derive(Clone, Serialize)]
pub struct DownloadProgressEvent {
    pub session_id: u64,
    pub downloaded_size: u64,
    pub total_size: u64,
    pub speed: u64,
    pub progress: f64,
}

/// 下载结果
#[derive(Clone, Serialize)]
pub struct DownloadResult {
    /// 下载会话 ID
    pub session_id: u64,
    /// 实际保存的文件路径（可能与请求的路径不同，如果从 URL 或 header 检测到正确的文件名）
    pub actual_save_path: String,
    /// 从 URL 或 Content-Disposition 提取的文件名（如果有）
    pub detected_filename: Option<String>,
}

/// 系统信息结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub tauri_version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub name: String,
    pub body: Option<String>,
    pub prerelease: bool,
    pub assets: Vec<GitHubAsset>,
}

/// WebView2 目录信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebView2DirInfo {
    pub path: String,
    pub system: bool,
}
