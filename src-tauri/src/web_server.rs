//! Web 服务器
//!
//! 基于 axum 提供 HTTP API，供浏览器客户端（本机/局域网/公网）访问。
//! 与 Tauri invoke IPC 并列，实现同一套后端状态的双通道访问。

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;
use tower_http::cors::Any;
use tower_http::cors::CorsLayer;

use crate::commands::{
    app_config::AppConfigState,
    maa_agent::{start_tasks_impl, stop_agent_impl},
    maa_core::{
        connect_controller_impl, destroy_instance_impl, find_adb_devices_impl,
        find_gamescope_instances_impl, find_win32_windows_impl, find_wlroots_sockets_impl,
        get_cached_image_impl, load_resource_impl, override_pipeline_impl, post_click_impl,
        post_screencap_impl, run_task_impl, stop_task_impl,
    },
    types::{AgentConfig, ControllerConfig, ControllerInfo, MaaState, TaskConfig},
    utils::{emit_callback_event, emit_config_changed, emit_state_changed},
};
use crate::ws_broadcast::WsBroadcast;

/// Web 服务器默认监听端口
pub const DEFAULT_PORT: u16 = 12701;
/// 端口搜索范围上限
const MAX_PORT_ATTEMPTS: u16 = 10;

/// 全局存储 Web 服务器是否已启用（由配置控制）
static WEB_SERVER_ENABLED: AtomicBool = AtomicBool::new(true);

/// 全局存储 Web 服务器实际监听端口（供前端查询）
static ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);

/// 获取 Web 服务器是否已启用
pub fn is_web_server_enabled() -> bool {
    WEB_SERVER_ENABLED.load(Ordering::Relaxed)
}

/// 设置 Web 服务器启用状态
pub fn set_web_server_enabled(value: bool) {
    WEB_SERVER_ENABLED.store(value, Ordering::Relaxed);
}

/// 获取 Web 服务器实际监听端口（0 表示尚未启动或启动失败）
pub fn get_actual_port() -> u16 {
    ACTUAL_PORT.load(Ordering::Relaxed)
}

/// 探测本机局域网 IP（UDP 连接不发送数据，仅通过路由表推导本地地址）
static LOCAL_LAN_IP: OnceLock<Option<String>> = OnceLock::new();

fn detect_local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("223.5.5.5:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

pub fn get_local_ip() -> Option<&'static str> {
    LOCAL_LAN_IP.get_or_init(detect_local_ip).as_deref()
}

/// 编译时嵌入的前端构建产物（../dist 目录）
/// release 构建时由 beforeBuildCommand (`pnpm build`) 生成
#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "../dist"]
struct FrontendAssets;

/// dev 构建中，Vite dev server 的地址（与 tauri.conf.json devUrl 保持一致）
#[cfg(debug_assertions)]
const VITE_DEV_URL: &str = "http://localhost:1420";

/// dev 模式专用：将前端静态资源请求反向代理到 Vite dev server，
/// 从而获得实时 HMR 而无需重新编译 Rust。
#[cfg(debug_assertions)]
async fn serve_vite_proxy(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    let url = format!("{}{}", VITE_DEV_URL, path);

    match reqwest::get(&url).await {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(axum::http::StatusCode::OK);
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let body = resp.bytes().await.unwrap_or_default().to_vec();
            (status, [(header::CONTENT_TYPE, content_type)], body).into_response()
        }
        Err(_) => {
            // Vite dev server 尚未就绪时返回自动刷新页面
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                b"<html><body><p>Waiting for Vite dev server...</p>\
                  <script>setTimeout(()=>location.reload(),2000)</script></body></html>"
                    .to_vec(),
            )
                .into_response()
        }
    }
}

fn mime_from_extension(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "json" | "jsonc" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(not(debug_assertions))]
fn guess_mime(path: &str) -> &'static str {
    mime_from_extension(path.rsplit('.').next().unwrap_or(""))
}

/// 从内嵌资源提供前端文件，支持 SPA 路由回退（未匹配路径返回 index.html）
#[cfg(not(debug_assertions))]
async fn serve_embedded(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = FrontendAssets::get(path) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, guess_mime(path))],
            file.data.into_owned(),
        )
            .into_response();
    }

    // SPA fallback: 非文件路径一律返回 index.html，由前端路由接管
    if let Some(file) = FrontendAssets::get("index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            file.data.into_owned(),
        )
            .into_response();
    }

    StatusCode::NOT_FOUND.into_response()
}

/// axum 应用共享状态
#[derive(Clone)]
struct WebState {
    app_config: Arc<AppConfigState>,
    maa_state: Arc<MaaState>,
    app_handle: tauri::AppHandle,
    ws_broadcast: Arc<WsBroadcast>,
}

/// 启动 Web 服务器（在独立的 tokio 任务中运行，不阻塞 Tauri 启动）
///
/// `allow_lan_access` 为 true 时绑定 0.0.0.0（局域网可访问），否则绑定 127.0.0.1（仅本机）。
pub async fn start_web_server(
    app_config: Arc<AppConfigState>,
    maa_state: Arc<MaaState>,
    app_handle: tauri::AppHandle,
    ws_broadcast: Arc<WsBroadcast>,
    port: u16,
    allow_lan_access: bool,
) {
    let state = WebState {
        app_config,
        maa_state,
        app_handle,
        ws_broadcast,
    };

    // API 路由
    let api_routes = Router::new()
        // 配置 & 接口
        .route("/interface", get(handle_get_interface))
        .route(
            "/config",
            get(handle_get_config)
                .put(handle_put_config)
                .post(handle_put_config),
        )
        .route("/background-image", get(handle_get_background_image))
        // WebSocket 实时推送
        .route("/ws", get(handle_ws_upgrade))
        // Maa 状态查询
        .route("/maa/state", get(handle_get_maa_state))
        .route("/maa/initialized", get(handle_get_maa_initialized))
        // Maa 设备扫描
        .route("/maa/devices", get(handle_get_adb_devices))
        .route("/maa/windows", get(handle_get_win32_windows))
        .route("/maa/wlroots-sockets", get(handle_get_wlroots_sockets))
        .route(
            "/maa/gamescope-instances",
            get(handle_get_gamescope_instances),
        )
        // Maa 实例管理
        .route(
            "/maa/instances/:id",
            axum::routing::put(handle_create_instance).delete(handle_destroy_instance),
        )
        // Maa 实例操作（通过 instance_id 路径参数）
        .route(
            "/maa/instances/:id/connect",
            axum::routing::post(handle_connect_controller),
        )
        .route(
            "/maa/instances/:id/resource/load",
            axum::routing::post(handle_load_resource),
        )
        .route(
            "/maa/instances/:id/tasks/run",
            axum::routing::post(handle_run_task),
        )
        .route(
            "/maa/instances/:id/tasks/start",
            axum::routing::post(handle_start_tasks),
        )
        .route(
            "/maa/instances/:id/tasks/stop",
            axum::routing::post(handle_stop_task),
        )
        .route(
            "/maa/instances/:id/tasks/:task_id/pipeline",
            axum::routing::post(handle_override_pipeline),
        )
        .route(
            "/maa/instances/:id/agent/stop",
            axum::routing::post(handle_stop_agent),
        )
        .route(
            "/maa/instances/:id/click",
            axum::routing::post(handle_post_click),
        )
        .route("/maa/instances/:id/screenshot", get(handle_get_screenshot))
        .route(
            "/maa/instances/:id/screenshot/subscribe",
            axum::routing::post(handle_screenshot_subscribe),
        )
        .route(
            "/maa/instances/:id/screenshot/unsubscribe",
            axum::routing::post(handle_screenshot_unsubscribe),
        )
        // 运行日志（跨刷新持久化）
        .route("/logs", get(handle_get_all_logs))
        .route(
            "/logs/:id",
            axum::routing::post(handle_push_log).delete(handle_clear_instance_logs),
        )
        // 心跳
        .route("/heartbeat", get(handle_heartbeat))
        // 系统信息
        .route("/system/is-elevated", get(handle_is_elevated))
        .route(
            "/system/restart-as-admin",
            axum::routing::post(handle_restart_as_admin),
        )
        // 本地文件代理（浏览器通过此端点访问 exe 目录下的资源文件）
        .route("/local-file", get(handle_serve_local_file))
        .with_state(state);

    // 主路由：API + 静态前端页面
    let mut app: Router = Router::new().nest("/api", api_routes);

    // dev 构建：反向代理到 Vite dev server，实现实时 HMR
    #[cfg(debug_assertions)]
    {
        log::info!(
            "Web server [dev]: proxying frontend to Vite dev server at {}",
            VITE_DEV_URL
        );
        app = app.fallback(serve_vite_proxy);
    }

    // release 构建：优先从 exe 同目录的 dist/ 提供前端页面（方便热更新前端），
    // 否则使用编译时内嵌的前端资源
    #[cfg(not(debug_assertions))]
    {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));

        let has_external_dist = exe_dir
            .as_ref()
            .map(|dir| dir.join("dist").exists())
            .unwrap_or(false);

        if has_external_dist {
            let dist_dir = exe_dir.unwrap().join("dist");
            log::info!("Web server: serving static files from {:?}", dist_dir);
            app = app.fallback_service(
                tower_http::services::ServeDir::new(&dist_dir)
                    .append_index_html_on_directories(true)
                    .fallback(tower_http::services::ServeFile::new(
                        dist_dir.join("index.html"),
                    )),
            );
        } else {
            log::info!("Web server: serving embedded frontend assets");
            app = app.fallback(serve_embedded);
        }
    }

    #[cfg(debug_assertions)]
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any);

    // 生产模式：前端从 tauri://localhost 加载（嵌入资源），fetch http://127.0.0.1:12701/api/* 是跨域。
    // 必须允许任意 Origin，否则浏览器拦截所有 API 调用（表现为 "Could not connect to localhost"）。
    #[cfg(not(debug_assertions))]
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any);

    let app = app.layer(cors);

    let bind_host = if allow_lan_access {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };

    // 端口绑定策略：
    // 1. 先对默认端口重试几次（处理开发热重载时旧进程尚未退出的瞬态冲突）
    // 2. 若仍失败，尝试后续端口（port+1, port+2, ...）
    let listener = {
        let mut result = None;

        // Phase 1: 重试默认端口（最多 3 次，间隔 1s）
        for attempt in 0..3 {
            let addr = format!("{}:{}", bind_host, port);
            match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => {
                    result = Some((l, port));
                    break;
                }
                Err(e) => {
                    log::warn!(
                        "Web server bind attempt {}/3 on port {}: {}, retrying in 1s...",
                        attempt + 1,
                        port,
                        e
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }

        // Phase 2: 默认端口不可用，尝试递增端口
        if result.is_none() {
            for offset in 1..MAX_PORT_ATTEMPTS {
                let Some(try_port) = port.checked_add(offset) else {
                    break;
                };
                let addr = format!("{}:{}", bind_host, try_port);
                match tokio::net::TcpListener::bind(&addr).await {
                    Ok(l) => {
                        result = Some((l, try_port));
                        break;
                    }
                    Err(e) => {
                        log::warn!("Web server port {} unavailable: {}", try_port, e);
                    }
                }
            }
        }

        result
    };

    match listener {
        Some((listener, actual_port)) => {
            ACTUAL_PORT.store(actual_port, Ordering::Relaxed);
            if actual_port != port {
                log::info!(
                    "Web server listening on http://{}:{} (fallback from default port {})",
                    bind_host,
                    actual_port,
                    port
                );
            } else {
                log::info!(
                    "Web server listening on http://{}:{}",
                    bind_host,
                    actual_port
                );
            }
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("Web server error: {}", e);
            }
        }
        None => {
            log::error!(
                "Web server failed to bind on any port in range {}-{}",
                port,
                port.saturating_add(MAX_PORT_ATTEMPTS - 1)
            );
        }
    }
}

// ============================================================================
// WebSocket 处理
// ============================================================================

/// GET /api/ws
/// WebSocket 升级入口；每个客户端连接后各自获得一个 broadcast Receiver
async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<WebState>,
    _headers: HeaderMap,
) -> impl IntoResponse {
    #[cfg(not(debug_assertions))]
    if !is_same_origin_ws_request(&_headers) {
        return StatusCode::FORBIDDEN.into_response();
    }

    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
        .into_response()
}

#[cfg(not(debug_assertions))]
fn is_same_origin_ws_request(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        // 非浏览器客户端通常不带 Origin，保守兼容
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<axum::http::Uri>()
        .ok()
        .and_then(|uri| {
            uri.authority()
                .map(|a| a.as_str().eq_ignore_ascii_case(host))
        })
        .unwrap_or(false)
}

/// 每个 WebSocket 连接的处理循环
///
/// - 将 broadcast channel 中的事件序列化为 JSON 文本帧后发送
/// - 每 30 秒发送一次 Ping 保活
/// - 客户端断开或发送 Close 帧后退出
async fn handle_ws_connection(mut socket: WebSocket, state: WebState) {
    let mut rx = state.ws_broadcast.subscribe();
    let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    // 跳过第一次立即触发
    ping_interval.tick().await;

    loop {
        tokio::select! {
            // 从 broadcast channel 收到事件后转发给客户端
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        match serde_json::to_string(&event) {
                            Ok(json) => {
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    break; // 客户端已断开
                                }
                            }
                            Err(e) => {
                                log::warn!("WS: failed to serialize event: {}", e);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        // 消费过慢，跳过了 n 条消息
                        log::warn!("WS client lagged, skipped {} events", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break; // 广播器已关闭（应用退出）
                    }
                }
            }
            // 发送心跳 Ping
            _ = ping_interval.tick() => {
                if socket.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
            // 接收客户端消息（主要用于检测断开）
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {} // 忽略 Pong
                    Some(Ok(_)) => {}                // 忽略其他客户端消息
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

// ============================================================================
// API Handlers
// ============================================================================

/// GET /api/interface
/// 返回已处理的 interface.json 内容、翻译文件及路径信息
async fn handle_get_interface(State(state): State<WebState>) -> impl IntoResponse {
    let (pi, translations, base_path, data_path) = match (
        state.app_config.project_interface.lock(),
        state.app_config.translations.lock(),
        state.app_config.base_path.lock(),
        state.app_config.data_path.lock(),
    ) {
        (Ok(pi), Ok(translations), Ok(base_path), Ok(data_path)) => (
            pi.clone(),
            translations.clone(),
            base_path.clone(),
            data_path.clone(),
        ),
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "读取 interface 状态失败" })),
            )
                .into_response();
        }
    };

    match pi {
        Some(interface) => Json(serde_json::json!({
            "interface": interface,
            "translations": translations,
            "basePath": base_path,
            "dataPath": data_path,
            "webServerPort": get_actual_port(),
            "backendOS": std::env::consts::OS,
            "backendArch": std::env::consts::ARCH,
        }))
        .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "interface.json 尚未加载" })),
        )
            .into_response(),
    }
}

/// GET /api/config
/// 返回当前 MXU 配置（JSON 原文）
async fn handle_get_config(State(state): State<WebState>) -> impl IntoResponse {
    let config = match state.app_config.config.lock() {
        Ok(config) => config.clone(),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "读取配置状态失败" })),
            )
                .into_response();
        }
    };
    Json(config).into_response()
}

/// PUT/POST /api/config
/// 更新配置：写入内存 + 持久化到磁盘 + 广播 ConfigChanged 给所有 WS 客户端
async fn handle_put_config(
    State(state): State<WebState>,
    Json(new_config): Json<serde_json::Value>,
) -> impl IntoResponse {
    match state.app_config.save_config(new_config) {
        Ok(()) => {
            // 通知所有客户端（WS 浏览器 + Tauri 桌面端）配置已变更
            emit_config_changed(&state.app_handle);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// GET /api/maa/state
/// 返回所有 Maa 实例状态快照（与 maa_get_all_states invoke 命令返回格式相同）
async fn handle_get_maa_state(State(state): State<WebState>) -> impl IntoResponse {
    use std::collections::HashMap;

    let instances_result = state.maa_state.instances.lock();
    let adb_result = state.maa_state.cached_adb_devices.lock();
    let win32_result = state.maa_state.cached_win32_windows.lock();
    let wlroots_result = state.maa_state.cached_wlroots_sockets.lock();
    let gamescope_instances_result = state.maa_state.cached_gamescope_instances.lock();

    match (
        instances_result,
        adb_result,
        win32_result,
        wlroots_result,
        gamescope_instances_result,
    ) {
        (Ok(mut instances), Ok(adb), Ok(win32), Ok(wlroots), Ok(gamescope_instances)) => {
            let mut instance_states: HashMap<String, serde_json::Value> = HashMap::new();

            for (id, runtime) in instances.iter_mut() {
                let is_running = runtime.tasker.as_ref().is_some_and(|t| t.running());

                // 与 state.rs 的 maa_get_all_states 保持一致：清理停止标志
                if !is_running && runtime.stop_in_progress {
                    runtime.stop_in_progress = false;
                    runtime.stop_started_at = None;
                }

                // 字段名使用 snake_case，与 Tauri invoke 返回格式保持一致，
                // 前端 maaService.getAllStates 会统一做 camelCase 转换
                instance_states.insert(
                    id.clone(),
                    serde_json::json!({
                        "connected": runtime.controller.as_ref().is_some_and(|c| c.connected()),
                        "resource_loaded": runtime.resource.as_ref().is_some_and(|r| r.loaded()),
                        "tasker_inited": runtime.tasker.as_ref().is_some_and(|t| t.inited()),
                        "is_running": is_running,
                        "task_run_state": serde_json::to_value(&runtime.task_run_state).unwrap_or_default(),
                    }),
                );
            }

            Json(serde_json::json!({
                "instances": instance_states,
                "cached_adb_devices": serde_json::to_value(&*adb).unwrap_or(serde_json::Value::Array(vec![])),
                "cached_win32_windows": serde_json::to_value(&*win32).unwrap_or(serde_json::Value::Array(vec![])),
                "cached_wlroots_sockets": serde_json::to_value(&*wlroots).unwrap_or(serde_json::Value::Array(vec![])),
                "cached_gamescope_instances": serde_json::to_value(&*gamescope_instances).unwrap_or(serde_json::Value::Array(vec![])),
            }))
            .into_response()
        }
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "获取状态锁失败" })),
        )
            .into_response(),
    }
}

/// GET /api/maa/initialized
/// 返回 Maa 库初始化状态及版本号
async fn handle_get_maa_initialized(State(state): State<WebState>) -> impl IntoResponse {
    let lib_dir_set = match state.maa_state.lib_dir.lock() {
        Ok(lib_dir) => lib_dir.is_some(),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "读取 Maa 初始化状态失败" })),
            )
                .into_response();
        }
    };

    // 库已加载时尝试获取版本号（load_library 后才可调用 maa_version）
    let version = if lib_dir_set {
        std::panic::catch_unwind(|| maa_framework::maa_version().to_string())
            .ok()
            .and_then(|v| {
                if v.is_empty() || v == "unknown" {
                    None
                } else {
                    Some(v)
                }
            })
    } else {
        None
    };
    let initialized = version.is_some();

    Json(serde_json::json!({
        "initialized": initialized,
        "version": version,
    }))
    .into_response()
}

// ============================================================================
// Phase 2: Maa 操作端点
// ============================================================================

/// GET /api/maa/devices
/// 扫描并返回 ADB 设备列表（会更新 MaaState 缓存）
async fn handle_get_adb_devices(State(state): State<WebState>) -> impl IntoResponse {
    match find_adb_devices_impl(state.maa_state).await {
        Ok(devices) => Json(serde_json::to_value(&devices).unwrap_or_default()).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// GET /api/maa/windows
/// 扫描并返回 Win32 窗口列表（可选 class_regex / window_regex 过滤参数）
async fn handle_get_win32_windows(
    State(state): State<WebState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let class_regex = params.get("class_regex").cloned();
    let window_regex = params.get("window_regex").cloned();

    match find_win32_windows_impl(state.maa_state, class_regex, window_regex).await {
        Ok(windows) => Json(serde_json::to_value(&windows).unwrap_or_default()).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// GET /api/maa/wlroots-sockets
/// 扫描并返回 WlRoots socket 列表（会更新 MaaState 缓存）
async fn handle_get_wlroots_sockets(State(state): State<WebState>) -> impl IntoResponse {
    match find_wlroots_sockets_impl(state.maa_state).await {
        Ok(sockets) => Json(serde_json::to_value(&sockets).unwrap_or_default()).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// GET /api/maa/gamescope-instances
/// 扫描并返回 gamescope 实例列表（会更新 MaaState 缓存）
async fn handle_get_gamescope_instances(State(state): State<WebState>) -> impl IntoResponse {
    match find_gamescope_instances_impl(state.maa_state).await {
        Ok(instances) => Json(serde_json::to_value(&instances).unwrap_or_default()).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// PUT /api/maa/instances/:id
/// 创建实例（幂等）
async fn handle_create_instance(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    ensure_instance_exists(&state.maa_state, &instance_id);
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// DELETE /api/maa/instances/:id
/// 销毁实例
async fn handle_destroy_instance(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match destroy_instance_impl(&state.maa_state, &instance_id) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// 确保指定实例存在，不存在则自动创建
fn ensure_instance_exists(maa_state: &Arc<MaaState>, instance_id: &str) {
    if let Ok(mut instances) = maa_state.instances.lock() {
        instances
            .entry(instance_id.to_string())
            .or_insert_with(crate::commands::types::InstanceRuntime::default);
    }
}

/// POST /api/maa/instances/:id/connect
/// 连接控制器；自动创建不存在的实例
async fn handle_connect_controller(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(config): Json<ControllerConfig>,
) -> impl IntoResponse {
    ensure_instance_exists(&state.maa_state, &instance_id);

    let app_handle = state.app_handle.clone();
    let on_event = Arc::new(move |msg: &str, detail: &str| {
        emit_callback_event(&app_handle, msg, detail);
    });

    match connect_controller_impl(state.maa_state, instance_id.clone(), config, on_event).await {
        Ok(conn_id) => {
            emit_state_changed(&state.app_handle, &instance_id, "connected");
            Json(serde_json::json!({ "connId": conn_id })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/resource/load
/// 加载资源（异步，通过 WebSocket 回调通知完成状态）
/// Body: `{ "paths": ["/path/to/resource"], "inferenceDevice": "auto" | "cpu" }`
async fn handle_load_resource(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    ensure_instance_exists(&state.maa_state, &instance_id);

    let paths: Vec<String> = match body.get("paths").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "missing 'paths' array" })),
            )
                .into_response();
        }
    };

    let inference_device = body
        .get("inferenceDevice")
        .and_then(|v| v.as_str())
        .unwrap_or("auto");

    let app_handle = state.app_handle.clone();
    let on_event: Arc<dyn Fn(&str, &str) + Send + Sync + 'static> =
        Arc::new(move |msg: &str, detail: &str| {
            emit_callback_event(&app_handle, msg, detail);
        });

    match load_resource_impl(
        &state.maa_state,
        &instance_id,
        &paths,
        inference_device,
        on_event,
        Some(&state.app_handle),
    ) {
        Ok(res_ids) => {
            emit_state_changed(&state.app_handle, &instance_id, "resource-loading");
            Json(serde_json::json!({ "resIds": res_ids })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/tasks/run
/// 运行一批任务（不启动 agent，适用于已连接的实例）
/// Body: `[{"entry": "TaskName", "pipelineOverride": "{}", "selected_task_id": "..." }]`
async fn handle_run_task(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(tasks): Json<Vec<TaskConfig>>,
) -> impl IntoResponse {
    let mut task_ids = Vec::new();
    let maa = state.maa_state;

    for task in &tasks {
        match run_task_impl(
            &state.app_handle,
            &maa,
            &instance_id,
            &task.entry,
            &task.pipeline_override,
            task.selected_task_id.as_deref(),
        ) {
            Ok(id) => task_ids.push(id),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e })),
                )
                    .into_response();
            }
        }
    }

    emit_state_changed(&state.app_handle, &instance_id, "task-started");

    Json(serde_json::json!({ "taskIds": task_ids })).into_response()
}

/// POST /api/maa/instances/:id/tasks/start 请求体
#[derive(serde::Deserialize)]
struct StartTasksRequest {
    tasks: Vec<TaskConfig>,
    #[serde(default)]
    agent_configs: Option<Vec<AgentConfig>>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    tcp_compat_mode: Option<bool>,
    #[serde(default)]
    pi_envs: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    reset_state: Option<bool>,
    /// 当前 controller 描述，仅用于遥测埋点
    #[serde(default)]
    controller_info: Option<ControllerInfo>,
}

/// POST /api/maa/instances/:id/tasks/start
/// 启动任务（支持 Agent），与 Tauri invoke `maa_start_tasks` 使用同一套实现
async fn handle_start_tasks(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(body): Json<StartTasksRequest>,
) -> impl IntoResponse {
    ensure_instance_exists(&state.maa_state, &instance_id);

    let cwd = match body.cwd {
        Some(cwd) => cwd,
        None => match state.app_config.base_path.lock() {
            Ok(base_path) => base_path.clone(),
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "读取基础路径失败" })),
                )
                    .into_response();
            }
        },
    };

    match start_tasks_impl(
        state.app_handle,
        &state.maa_state,
        instance_id,
        body.tasks,
        body.agent_configs,
        cwd,
        body.tcp_compat_mode.unwrap_or(false),
        body.pi_envs,
        body.reset_state.unwrap_or(true),
        body.controller_info,
    )
    .await
    {
        Ok(task_ids) => Json(serde_json::json!({ "taskIds": task_ids })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/tasks/stop
/// 停止当前实例的任务
async fn handle_stop_task(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match stop_task_impl(&state.maa_state, &instance_id) {
        Ok(()) => {
            emit_state_changed(&state.app_handle, &instance_id, "task-stopped");
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/tasks/:task_id/pipeline 请求体
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverridePipelineRequest {
    pipeline_override: String,
}

/// POST /api/maa/instances/:id/tasks/:task_id/pipeline
/// 覆盖已提交任务的 Pipeline 配置，与 Tauri invoke `maa_override_pipeline` 使用同一套实现
async fn handle_override_pipeline(
    State(state): State<WebState>,
    axum::extract::Path((instance_id, task_id)): axum::extract::Path<(String, i64)>,
    Json(body): Json<OverridePipelineRequest>,
) -> impl IntoResponse {
    match override_pipeline_impl(
        &state.maa_state,
        &instance_id,
        task_id,
        &body.pipeline_override,
    ) {
        Ok(success) => Json(serde_json::json!({ "success": success })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/agent/stop
/// 停止 Agent 并断开连接，与 Tauri invoke `maa_stop_agent` 使用同一套实现
async fn handle_stop_agent(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match stop_agent_impl(&state.maa_state, &instance_id) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// POST /api/maa/instances/:id/click
///
/// Body: `{ "x": 100, "y": 200 }`
#[derive(serde::Deserialize)]
struct PostClickRequest {
    x: i32,
    y: i32,
}

async fn handle_post_click(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    body: Result<Json<PostClickRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let body = match body {
        Ok(Json(b)) => b,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": err.body_text() })),
            )
                .into_response();
        }
    };

    match post_click_impl(&state.maa_state, &instance_id, body.x, body.y) {
        Ok(id) => (StatusCode::OK, Json(serde_json::json!({ "clickId": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// GET /api/maa/instances/:id/screenshot
///
/// 返回该实例的最新缓存截图（PNG 二进制）。
///
/// 若后端截图循环已运行（订阅者存在），缓存通常立即可用。
/// 若缓存为空（从未截图），则回退到一次性触发 post_screencap 并等待（最多 10 秒），
/// 保持对未订阅场景的兼容性。
async fn handle_get_screenshot(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    // 优先返回缓存，无缓存时触发一次兜底截图并等待（最多 10 秒）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut fallback_triggered = false;

    loop {
        match get_cached_image_impl(&state.maa_state, &instance_id) {
            Ok(data_url) if !data_url.is_empty() => {
                if let Some(b64) = data_url.strip_prefix("data:image/png;base64,") {
                    use base64::{engine::general_purpose::STANDARD, Engine as _};
                    if let Ok(bytes) = STANDARD.decode(b64) {
                        return (StatusCode::OK, [(header::CONTENT_TYPE, "image/png")], bytes)
                            .into_response();
                    }
                }
                return Json(serde_json::json!({ "dataUrl": data_url })).into_response();
            }
            _ => {}
        }

        if std::time::Instant::now() > deadline {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "error": "截图超时" })),
            )
                .into_response();
        }

        // 缓存为空时兜底触发一次截图（兼容无订阅者场景）
        if !fallback_triggered {
            fallback_triggered = true;
            let _ = post_screencap_impl(&state.maa_state, &instance_id);
        }

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// POST /api/maa/instances/:id/screenshot/subscribe
/// Body: `{ "subscriber_id": "...", "interval_ms": 200 }`
///
/// 注册截图订阅者。后端统一截图循环将按所有订阅者中最快的间隔驱动截图，
/// 确保同一实例的 post_screencap 全局只有一份在运行。
async fn handle_screenshot_subscribe(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let subscriber_id = match body.get("subscriber_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "missing subscriber_id" })),
            )
                .into_response();
        }
    };
    let interval_ms = body
        .get("interval_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(1000);

    let handle = tokio::runtime::Handle::current();
    state.maa_state.screenshot_service.subscribe(
        state.maa_state.clone(),
        instance_id,
        subscriber_id,
        interval_ms,
        handle,
    );
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// POST /api/maa/instances/:id/screenshot/unsubscribe
/// Body: `{ "subscriber_id": "..." }`
///
/// 取消截图订阅。若该实例无剩余订阅者，截图循环将自动停止。
async fn handle_screenshot_unsubscribe(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let subscriber_id = match body.get("subscriber_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "missing subscriber_id" })),
            )
                .into_response();
        }
    };
    state
        .maa_state
        .screenshot_service
        .unsubscribe(&instance_id, &subscriber_id);
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// GET /api/background-image
/// 读取配置中的背景图路径并返回图片二进制数据
async fn handle_get_background_image(State(state): State<WebState>) -> impl IntoResponse {
    let config = match state.app_config.config.lock() {
        Ok(config) => config.clone(),
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "读取背景图配置失败" })),
            )
                .into_response();
        }
    };

    let image_path = config
        .get("settings")
        .and_then(|s| s.get("backgroundImage"))
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    match image_path {
        Some(path) => match std::fs::read(&path) {
            Ok(data) => {
                let ext = path.rsplit('.').next().unwrap_or("");
                let content_type = mime_from_extension(ext);
                (StatusCode::OK, [(header::CONTENT_TYPE, content_type)], data).into_response()
            }
            Err(e) => (StatusCode::NOT_FOUND, format!("背景图读取失败: {}", e)).into_response(),
        },
        None => (StatusCode::NOT_FOUND, "未设置背景图片").into_response(),
    }
}

/// GET /api/local-file?path=relative/path
/// 代理 exe 目录下的本地资源文件（图标、描述、翻译等），供浏览器客户端使用。
/// 包含路径穿越保护，仅允许访问 exe 目录内的文件。
async fn handle_serve_local_file(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    use crate::commands::file_ops::resolve_local_file_path;

    let file_path = match params.get("path") {
        Some(p) if !p.is_empty() => p.as_str(),
        _ => return (StatusCode::BAD_REQUEST, "缺少 path 参数").into_response(),
    };

    let resolved = match resolve_local_file_path(file_path) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };

    match std::fs::read(&resolved) {
        Ok(data) => {
            let ext = resolved.extension().and_then(|e| e.to_str()).unwrap_or("");
            let content_type = mime_from_extension(ext);
            (StatusCode::OK, [(header::CONTENT_TYPE, content_type)], data).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "文件不存在").into_response(),
    }
}

/// GET /api/logs — 获取所有实例的运行日志
async fn handle_get_all_logs(State(state): State<WebState>) -> impl IntoResponse {
    match state.maa_state.log_buffer.lock() {
        Ok(buffer) => Json(buffer.get_all().clone()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// POST /api/logs/:id — 推送一条运行日志
async fn handle_push_log(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
    Json(entry): Json<crate::commands::types::LogEntryDto>,
) -> impl IntoResponse {
    match state.maa_state.log_buffer.lock() {
        Ok(mut buffer) => {
            buffer.push(&instance_id, entry);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// DELETE /api/logs/:id — 清空指定实例的运行日志
async fn handle_clear_instance_logs(
    State(state): State<WebState>,
    axum::extract::Path(instance_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match state.maa_state.log_buffer.lock() {
        Ok(mut buffer) => {
            buffer.clear_instance(&instance_id);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// GET /api/heartbeat
/// 轻量心跳端点，供 Web 客户端检测后端是否存活
async fn handle_heartbeat() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// GET /api/system/is-elevated
/// 返回当前进程是否以管理员权限运行
async fn handle_is_elevated() -> impl IntoResponse {
    Json(serde_json::json!({
        "elevated": crate::commands::system::is_elevated(),
    }))
    .into_response()
}

/// POST /api/system/restart-as-admin
/// 以管理员权限重启应用
async fn handle_restart_as_admin(State(state): State<WebState>) -> impl IntoResponse {
    match crate::commands::system::restart_as_admin(state.app_handle) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}
