//! MCP（Model Context Protocol）服务
//!
//! 以 streamable-http 挂载在 Web 服务器的 `/mcp` 路径下，供本机的 AI 工具连接。
//! - 截图由后端直接处理（`screen`）
//! - 其余业务通过前端桥（`bridge`）交给主窗口执行，与界面操作走同一套逻辑

pub mod bridge;
mod screen;
mod server;
pub mod texts;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Request},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

use crate::commands::app_config::AppConfigState;
use crate::commands::types::MaaState;
use bridge::McpBridge;
use server::MxuMcpServer;

/// MCP 服务开关（运行时生效，无需重启）
static MCP_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn is_mcp_enabled() -> bool {
    MCP_ENABLED.load(Ordering::Relaxed)
}

pub fn set_mcp_enabled(value: bool) {
    MCP_ENABLED.store(value, Ordering::Relaxed);
}

/// 前端修改设置时同步开关
#[tauri::command]
pub fn set_mcp_server_enabled(enabled: bool) {
    log::info!("MCP server enabled: {}", enabled);
    set_mcp_enabled(enabled);
}

/// 构建挂载 MCP 服务的路由
pub fn router(
    bridge: Arc<McpBridge>,
    maa_state: Arc<MaaState>,
    app_config: Arc<AppConfigState>,
    version: String,
) -> Router {
    // Host 默认只允许回环地址（防 DNS rebinding）；
    // AI 工具不会携带 Origin，强制校验以拒绝所有浏览器页面发起的请求
    let config = StreamableHttpServerConfig::default().enforce_origin_validation();

    let service = StreamableHttpService::new(
        move || {
            Ok(MxuMcpServer::new(
                bridge.clone(),
                maa_state.clone(),
                app_config.clone(),
                version.clone(),
            ))
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn(guard))
}

/// 开关与来源检查：未启用时视为不存在；只接受本机连接
async fn guard(ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !is_mcp_enabled() {
        return (StatusCode::NOT_FOUND, "MCP server is disabled").into_response();
    }
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            "MCP server only accepts local connections",
        )
            .into_response();
    }
    next.run(req).await
}
