//! MCP ↔ 前端桥
//!
//! 任务列表、启动/停止等业务逻辑都在前端（zustand store 与各 service），
//! MCP 工具通过本桥把请求转发给主窗口执行，并等待前端回传结果。
//!
//! 流程：`call()` 分配请求 id → `emit_to("main", "mcp-request")` →
//! 前端处理完成后 `invoke("mcp_respond")` → 唤醒对应的 oneshot。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::texts;

/// 前端监听的事件名
const REQUEST_EVENT: &str = "mcp-request";
/// 主窗口 label（与 tauri.conf.json 保持一致）
const MAIN_WINDOW_LABEL: &str = "main";

type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

pub struct McpBridge {
    app: AppHandle,
    next_id: AtomicU64,
    pending: Mutex<PendingMap>,
    /// 前端是否已注册 `mcp-request` 监听
    frontend_ready: AtomicBool,
}

#[derive(Serialize, Clone)]
struct BridgeRequest<'a> {
    id: u64,
    op: &'a str,
    args: Value,
}

/// 前端回传的结果
#[derive(Deserialize)]
pub struct BridgeResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<String>,
}

static BRIDGE: OnceLock<Arc<McpBridge>> = OnceLock::new();

/// 初始化全局桥（应用启动时调用一次）
pub fn init(app: AppHandle) -> Arc<McpBridge> {
    BRIDGE
        .get_or_init(|| {
            Arc::new(McpBridge {
                app,
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                frontend_ready: AtomicBool::new(false),
            })
        })
        .clone()
}

pub fn get() -> Option<Arc<McpBridge>> {
    BRIDGE.get().cloned()
}

impl McpBridge {
    /// 向前端发送请求并等待结果
    pub async fn call(&self, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        if !self.frontend_ready.load(Ordering::Relaxed) {
            return Err(texts::error(
                "uiNotReady",
                "MXU 界面尚未就绪，请稍后重试",
                &[],
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);

        if let Err(e) = self.app.emit_to(
            MAIN_WINDOW_LABEL,
            REQUEST_EVENT,
            BridgeRequest { id, op, args },
        ) {
            self.remove_pending(id);
            return Err(texts::error(
                "sendFailed",
                "发送请求到 MXU 界面失败：{error}",
                &[("error", &e.to_string())],
            ));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(texts::error("noResult", "MXU 界面未返回结果", &[])),
            Err(_) => {
                self.remove_pending(id);
                Err(timeout_error(op, timeout))
            }
        }
    }

    fn remove_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    fn respond(&self, response: BridgeResponse) {
        let sender = match self.pending.lock() {
            Ok(mut pending) => pending.remove(&response.id),
            Err(_) => None,
        };
        let Some(sender) = sender else {
            // 已超时被移除，丢弃迟到的结果
            log::debug!("[mcp] late response dropped: {}", response.id);
            return;
        };
        let result = if response.ok {
            Ok(response.data)
        } else {
            Err(response
                .error
                .unwrap_or_else(|| texts::error("unknownError", "未知错误", &[])))
        };
        let _ = sender.send(result);
    }
}

/// 超时提示：启动与写操作可能已在界面侧继续执行，提示 AI 先确认状态再重试
fn timeout_error(op: &str, timeout: Duration) -> String {
    let seconds = timeout.as_secs().to_string();
    let params = [("seconds", seconds.as_str())];
    match op {
        "start_tasks" => texts::error(
            "timeoutStart",
            "等待启动结果超时（{seconds} 秒）：启动可能仍在进行，请用 get_run_status 查看状态，不要直接重试",
            &params,
        ),
        "add_task" | "update_task" | "remove_task" | "stop_tasks" => texts::error(
            "timeoutWrite",
            "等待 MXU 界面响应超时（{seconds} 秒）：操作可能已经执行，请先用 get_task_list 或 get_run_status 确认后再决定是否重试",
            &params,
        ),
        _ => texts::error("timeout", "等待 MXU 界面响应超时（{seconds} 秒）", &params),
    }
}

/// 前端回传 MCP 请求结果
#[tauri::command]
pub fn mcp_respond(response: BridgeResponse) {
    if let Some(bridge) = get() {
        bridge.respond(response);
    }
}

/// 前端注册监听完成后调用，标记桥可用
#[tauri::command]
pub fn mcp_bridge_ready() {
    if let Some(bridge) = get() {
        bridge.frontend_ready.store(true, Ordering::Relaxed);
    }
}
