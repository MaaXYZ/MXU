//! WebSocket 广播基础设施
//!
//! 提供发布-订阅模型，将 Maa 回调、Agent 输出、配置变更等事件
//! 广播给所有已连接的 WebSocket 客户端。

use serde::Serialize;
use tokio::sync::broadcast;

/// 通过 WebSocket 推送给浏览器客户端的事件类型
///
/// 使用带标签的 JSON 格式：`{ "type": "maa-callback", "payload": { ... } }`
#[derive(Clone, Serialize, Debug)]
#[serde(tag = "type", content = "payload")]
pub enum WsEvent {
    /// Maa 框架回调（对应 Tauri `maa-callback` 事件）
    #[serde(rename = "maa-callback")]
    MaaCallback { message: String, details: String },

    /// Agent 子进程输出（对应 Tauri `maa-agent-output` 事件）
    #[serde(rename = "maa-agent-output")]
    AgentOutput {
        instance_id: String,
        stream: String,
        line: String,
    },

    /// 配置被某个客户端修改，其它客户端需重新拉取
    #[serde(rename = "config-changed")]
    ConfigChanged { client_id: String, revision: String },

    /// Maa 实例状态变更（连接状态、任务状态等）
    #[serde(rename = "state-changed")]
    StateChanged { instance_id: String, kind: String },
}

/// 全局广播器，包装 `broadcast::Sender<WsEvent>`
///
/// 通过 `app.manage(WsBroadcast::new(...))` 注册到 Tauri 状态，
/// 在需要广播的地方通过 `app.try_state::<WsBroadcast>()` 获取。
pub struct WsBroadcast {
    pub sender: broadcast::Sender<WsEvent>,
}

impl WsBroadcast {
    /// 创建新的广播器，`capacity` 为 channel 容量（建议 256）
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// 订阅事件流，返回一个 `Receiver`
    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.sender.subscribe()
    }

    /// 发送事件；若无订阅者则静默忽略（broadcast channel 特性）
    pub fn send(&self, event: WsEvent) {
        // 没有活跃订阅者时 send 返回 Err(SendError)，这是正常情况，忽略即可
        let _ = self.sender.send(event);
    }
}
