//! Agent 相关命令
//!
//! 提供 MaaFramework Agent 启动和管理功能

use log::{debug, error, info, warn};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use chrono::Local;
use tauri::{Emitter, Manager, State};

use maa_framework::agent_client::AgentClient;
use maa_framework::controller::Controller;
use maa_framework::resource::Resource;
use maa_framework::tasker::Tasker;

use super::types::{AgentConfig, ControllerInfo, MaaState, TaskConfig};
use super::utils::{emit_callback_event, get_logs_dir, handle_task_callback, normalize_path};
use regex::Regex;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

/// Agent 输出事件载荷
#[derive(Clone, serde::Serialize)]
pub struct AgentOutputEvent {
    pub instance_id: String,
    pub stream: String,
    pub line: String,
}

struct AgentOutputBatchState {
    lines: Vec<String>,
    first_stream: Option<String>,
    has_mixed_streams: bool,
    flush_deadline: Option<Instant>,
    flush_running: bool,
}

pub(crate) struct AgentOutputBatcher {
    app: tauri::AppHandle,
    instance_id: String,
    state: Mutex<AgentOutputBatchState>,
    /// 串行化「取出批次 + 发送」，保证 flush 返回时之前入队的输出均已发出
    emit_lock: Mutex<()>,
}

impl AgentOutputBatcher {
    pub(crate) fn new(app: tauri::AppHandle, instance_id: String) -> Arc<Self> {
        Arc::new(Self {
            app,
            instance_id,
            state: Mutex::new(AgentOutputBatchState {
                lines: Vec::new(),
                first_stream: None,
                has_mixed_streams: false,
                flush_deadline: None,
                flush_running: false,
            }),
            emit_lock: Mutex::new(()),
        })
    }

    pub(crate) fn enqueue(self: &Arc<Self>, stream: &str, line: &str) {
        let should_spawn = {
            let mut state = self.state.lock().unwrap();
            state.lines.push(line.to_string());
            match state.first_stream.as_ref() {
                None => state.first_stream = Some(stream.to_string()),
                Some(existing) if existing != stream => state.has_mixed_streams = true,
                _ => {}
            }
            state.flush_deadline = Some(Instant::now() + Duration::from_millis(1));

            if state.flush_running {
                false
            } else {
                state.flush_running = true;
                true
            }
        };

        if should_spawn {
            let batcher = Arc::clone(self);
            thread::spawn(move || batcher.flush_loop());
        }
    }

    fn flush_loop(self: Arc<Self>) {
        loop {
            let deadline = {
                let state = self.state.lock().unwrap();
                match state.flush_deadline {
                    Some(deadline) => deadline,
                    None => {
                        drop(state);
                        self.finish_flush_loop();
                        return;
                    }
                }
            };

            let now = Instant::now();
            if deadline > now {
                thread::sleep(deadline.duration_since(now));
                continue;
            }

            let _emit_guard = self.emit_lock.lock().unwrap();
            let payload = {
                let mut state = self.state.lock().unwrap();
                match state.flush_deadline {
                    Some(current_deadline) if Instant::now() >= current_deadline => {
                        if state.lines.is_empty() {
                            state.flush_deadline = None;
                            state.flush_running = false;
                            None
                        } else {
                            let merged_line = state.lines.join("\n");
                            state.lines.clear();
                            let stream = if state.has_mixed_streams {
                                "mixed".to_string()
                            } else {
                                state
                                    .first_stream
                                    .take()
                                    .unwrap_or_else(|| "stdout".to_string())
                            };
                            state.has_mixed_streams = false;
                            state.flush_deadline = None;
                            Some((stream, merged_line))
                        }
                    }
                    Some(_) => continue,
                    None => {
                        state.flush_running = false;
                        None
                    }
                }
            };

            match payload {
                Some((stream, merged_line)) => {
                    emit_agent_output(&self.app, &self.instance_id, &stream, &merged_line);
                }
                None => {
                    let should_exit = {
                        let state = self.state.lock().unwrap();
                        !state.flush_running
                    };
                    if should_exit {
                        return;
                    }
                }
            }
        }
    }

    fn finish_flush_loop(&self) {
        let mut state = self.state.lock().unwrap();
        state.flush_running = false;
    }

    /// 立即发送已排队的输出，用于进程结束时保证输出先于后续日志到达前端
    pub(crate) fn flush(&self) {
        let _emit_guard = self.emit_lock.lock().unwrap();
        let payload = {
            let mut state = self.state.lock().unwrap();
            if state.lines.is_empty() {
                None
            } else {
                let merged_line = state.lines.join("\n");
                state.lines.clear();
                let stream = if state.has_mixed_streams {
                    "mixed".to_string()
                } else {
                    state
                        .first_stream
                        .take()
                        .unwrap_or_else(|| "stdout".to_string())
                };
                state.has_mixed_streams = false;
                Some((stream, merged_line))
            }
        };
        if let Some((stream, merged_line)) = payload {
            emit_agent_output(&self.app, &self.instance_id, &stream, &merged_line);
        }
    }
}

/// 子进程输出日志文件（延迟创建：仅在有实际输出时才打开文件）
pub(crate) struct ChildOutputLog {
    path: PathBuf,
    file: Mutex<Option<std::fs::File>>,
}

impl ChildOutputLog {
    pub(crate) fn new(file_name: &str) -> Arc<Self> {
        Arc::new(Self {
            path: get_logs_dir().join(file_name),
            file: Mutex::new(None),
        })
    }

    fn write_line(&self, stream: &str, line: &str) {
        if let Ok(mut guard) = self.file.lock() {
            if guard.is_none() {
                *guard = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                    .ok();
            }
            if let Some(file) = guard.as_mut() {
                let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
                let _ = writeln!(file, "{} [{}] {}", timestamp, stream, line);
            }
        }
    }
}

/// 在单独线程中按行读取子进程输出：写入日志文件、记录日志并发送到前端日志面板。
/// Agent 与 pretask 共用。
pub(crate) fn spawn_child_output_reader<R: Read + Send + 'static>(
    source: R,
    stream: &'static str,
    log_tag: String,
    log_file: Arc<ChildOutputLog>,
    batcher: Arc<AgentOutputBatcher>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer);
                    let clean_line = line.trim_end();
                    log_file.write_line(stream, clean_line);
                    if stream == "stderr" {
                        warn!(target: "agent", "[{}][{}] {}", log_tag, stream, clean_line);
                    } else {
                        info!(target: "agent", "[{}][{}] {}", log_tag, stream, clean_line);
                    }
                    batcher.enqueue(stream, clean_line);
                }
                Err(_) => break,
            }
        }
    })
}

/// 发送 Agent 输出事件（Tauri WebView + WebSocket 浏览器客户端）
fn emit_agent_output(app: &tauri::AppHandle, instance_id: &str, stream: &str, line: &str) {
    let clean_line = strip_ansi_escapes(line);

    // 广播到所有 WebSocket 客户端
    if let Some(ws) = app.try_state::<Arc<crate::ws_broadcast::WsBroadcast>>() {
        ws.send(crate::ws_broadcast::WsEvent::AgentOutput {
            instance_id: instance_id.to_string(),
            stream: stream.to_string(),
            line: clean_line.clone(),
        });
    }

    // 发送到 Tauri WebView
    let event = AgentOutputEvent {
        instance_id: instance_id.to_string(),
        stream: stream.to_string(),
        line: clean_line,
    };
    if let Err(e) = app.emit("maa-agent-output", event) {
        log::error!("[agent_output] Failed to emit event: {}", e);
    }
}

/// 移除 ANSI 转义序列
static ANSI_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07?").unwrap());

fn strip_ansi_escapes(s: &str) -> String {
    ANSI_RE.replace_all(s, "").into_owned()
}

/// 判断给定 child_exec 是否是“裸命令名”（仅包含单个普通组件且不含路径分隔符）。
///
/// 例如 `python` / `node` / `git` 返回 true，`./agent.py` / `subdir/tool` 返回 false。
fn is_bare_command(child_exec: &str, path: &Path) -> bool {
    // `python/`、`python\` 这类带分隔符输入应视为路径而非裸命令。
    if child_exec.contains('/') || child_exec.contains('\\') {
        return false;
    }

    let mut components = path.components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// child_exec 的解析类别。
enum ChildExecKind {
    Empty,
    BareCommand,
    RelativePath,
    AbsoluteOrPrefixedPath,
}

/// 对 child_exec 做一次统一分类，供后续路径解析逻辑复用。
fn classify_child_exec(child_exec: &str) -> ChildExecKind {
    if child_exec.is_empty() {
        return ChildExecKind::Empty;
    }

    let path = Path::new(child_exec);
    let first = path.components().next();

    if is_bare_command(child_exec, path) {
        return ChildExecKind::BareCommand;
    }

    // 根目录路径（如 /usr/bin/python 或 \Windows\System32）不拼接 cwd。
    if matches!(first, Some(Component::RootDir)) {
        return ChildExecKind::AbsoluteOrPrefixedPath;
    }

    // Windows 盘符前缀（如 C:python.exe / C:\Python\python.exe）不拼接 cwd
    if matches!(first, Some(Component::Prefix(_))) {
        return ChildExecKind::AbsoluteOrPrefixedPath;
    }

    // 其余都视作相对路径（如 ./x、../x、subdir/x）。
    ChildExecKind::RelativePath
}

/// 解析 agent 可执行入口路径：
/// - 空字符串 child_exec -> 原样返回（不拼接 cwd、不做规范化）
/// - 裸命令名（如 `python` / `node`）-> 原样返回，由系统 PATH 解析
/// - 相对路径型 child_exec -> 先基于 cwd 拼接，再通过 `normalize_path` 规范化
/// - 绝对路径 / 带盘符前缀路径 -> 不拼接 cwd，但会通过 `normalize_path` 规范化
///
/// 供 Agent 启动与 pretask 执行共用，确保相对入口的解析行为一致：Windows 下相对
/// 可执行路径会相对“父进程当前目录”而非子进程 `current_dir` 解析，因此必须在拼好
/// 绝对路径后再交给 `Command`，否则会出现“系统找不到指定的路径 (os error 3)”。
pub(crate) fn resolve_child_exec_path(child_exec: &str, cwd: &str) -> PathBuf {
    match classify_child_exec(child_exec) {
        // 空字符串由上层提前校验；这里保守返回原值，避免误拼 cwd。
        ChildExecKind::Empty => PathBuf::from(child_exec),
        // 裸命令名（例如 python / node）直接走 PATH，不做路径规范化。
        ChildExecKind::BareCommand => PathBuf::from(child_exec),
        ChildExecKind::RelativePath => {
            let joined = Path::new(cwd).join(child_exec);
            normalize_path(&joined.to_string_lossy())
        }
        ChildExecKind::AbsoluteOrPrefixedPath => normalize_path(child_exec),
    }
}

/// Windows Application Control policy rejection (Smart App Control).
///
/// `CreateProcess` returns this when an executable is blocked as untrusted.
/// Typical message: "An Application Control policy has blocked this file."
#[cfg(windows)]
const WINDOWS_ERROR_APPLICATION_CONTROL_BLOCKED: i32 = 4551;

fn agent_spawn_hint_tag(error: &std::io::Error) -> Option<&'static str> {
    if error.kind() == std::io::ErrorKind::NotFound {
        return Some(" [[hint:spawn_file_not_found]]");
    }
    #[cfg(windows)]
    if error.raw_os_error() == Some(WINDOWS_ERROR_APPLICATION_CONTROL_BLOCKED) {
        return Some(" [[hint:spawn_app_control]]");
    }
    None
}

/// 启动单个 Agent 子进程并完成连接
async fn start_single_agent(
    app: tauri::AppHandle,
    agent: AgentConfig,
    agent_index: usize,
    instance_id: String,
    cwd: String,
    tcp_compat_mode: bool,
    resource: Resource,
    controller: Controller,
    tasker: Tasker,
    pi_envs: Arc<HashMap<String, String>>,
) -> Result<(AgentClient, std::process::Child), String> {
    info!("[agent#{}] Starting agent: {:?}", agent_index, agent);

    // 将整个启动过程移入 spawn_blocking，避免阻塞 async runtime 线程
    tauri::async_runtime::spawn_blocking(move || {
        let mut client = if tcp_compat_mode {
            debug!("[agent#{}] Creating TCP agent client...", agent_index);
            AgentClient::create_tcp(0).or_else(|e| {
                warn!(
                    "[agent#{}] TCP compat mode requested but failed: {}, falling back to default (IPC)",
                    agent_index, e
                );
                AgentClient::new(None)
            }).map_err(|e| e.to_string())?
        } else {
            debug!("[agent#{}] Creating default agent client...", agent_index);
            AgentClient::new(None).map_err(|e| e.to_string())?
        };

        if let Err(e) = client.bind(resource.clone()) {
            warn!("[agent#{}] Failed to bind resource: {}", agent_index, e);
            return Err(e.to_string());
        }

        let socket_id = client
            .identifier()
            .ok_or_else(|| format!("Failed to get identifier for agent #{}", agent_index))?;
        info!("[agent#{}] Agent socket_id: {}", agent_index, socket_id);

        // 启动子进程
        let mut args = agent.child_args.clone().unwrap_or_default();
        args.push(socket_id.clone());

        let child_exec = agent.child_exec.trim();
        if child_exec.is_empty() {
            return Err(format!(
                "Failed to spawn agent #{}: child_exec is empty",
                agent_index
            ));
        }

        let exec_path = resolve_child_exec_path(child_exec, &cwd);

        info!(
            "[agent#{}] Spawning process: {:?} {:?} in {}",
            agent_index, exec_path, args, cwd
        );

        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut c = Command::new(&exec_path);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };

        #[cfg(not(windows))]
        let mut cmd = Command::new(&exec_path);

        cmd.args(&args)
            .current_dir(&cwd)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // PI v2.5.0: 仅允许注入 PI_* 环境变量，避免覆盖宿主进程关键环境。
        let mut injected_count = 0usize;
        for (key, value) in pi_envs.iter() {
            if !key.starts_with("PI_") {
                warn!(
                    "[agent#{}] Skipping non-PI_ env key from pi_envs: {}",
                    agent_index, key
                );
                continue;
            }

            cmd.env(key, value);
            injected_count += 1;
        }
        if injected_count > 0 {
            info!(
                "[agent#{}] Injected {} PI_* env vars (requested: {})",
                agent_index,
                injected_count,
                pi_envs.len()
            );
        } else if !pi_envs.is_empty() {
            warn!(
                "[agent#{}] No PI_* env vars were injected ({} entries provided)",
                agent_index,
                pi_envs.len()
            );
        }

        let mut child = cmd.spawn().map_err(|e| {
            let mut msg = format!(
                "Failed to spawn agent #{}: {} (path: {:?})",
                agent_index, e, exec_path
            );
            if let Some(tag) = agent_spawn_hint_tag(&e) {
                msg.push_str(tag);
            }
            msg
        })?;

        // agent 日志文件路径（延迟创建：仅在有实际输出时才打开文件）
        let pid = child.id();
        let log_file = ChildOutputLog::new(&format!("mxu-agent-{}-{}.log", agent_index, pid));
        let output_batcher = AgentOutputBatcher::new(app.clone(), instance_id.clone());

        if let Some(stdout) = child.stdout.take() {
            spawn_child_output_reader(
                stdout,
                "stdout",
                format!("agent#{}", agent_index),
                log_file.clone(),
                output_batcher.clone(),
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_child_output_reader(
                stderr,
                "stderr",
                format!("agent#{}", agent_index),
                log_file.clone(),
                output_batcher.clone(),
            );
        }

        // 设置连接超时
        let timeout = agent.timeout.unwrap_or(-1);
        if let Err(e) = client.set_timeout(timeout) {
            warn!("Failed to set timeout for agent #{}: {}", agent_index, e);
        }

        info!("[agent#{}] Connecting to agent...", agent_index);

        if let Err(e) = client.connect() {
             error!("[agent#{}] Connection failed: {}", agent_index, e);
             let _ = child.kill();
             let _ = child.wait();
             return Err(e.to_string());
        }

        info!("[agent#{}] Connected successfully!", agent_index);

        // 注册 Agent sink
        if let Err(e) = client.register_sinks(resource, controller, tasker) {
            error!("[agent#{}] Failed to register sinks: {}", agent_index, e);
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }

        Ok((client, child))
    }).await.map_err(|e| e.to_string())?
}

/// 启动任务的核心实现（Tauri invoke 和 HTTP handler 共享）
pub async fn start_tasks_impl(
    app: tauri::AppHandle,
    maa_state: &Arc<MaaState>,
    instance_id: String,
    tasks: Vec<TaskConfig>,
    agent_configs: Option<Vec<AgentConfig>>,
    cwd: String,
    tcp_compat_mode: bool,
    pi_envs: Option<HashMap<String, String>>,
    reset_state: bool,
    controller_info: Option<ControllerInfo>,
) -> Result<Vec<i64>, String> {
    info!("start_tasks_impl called");

    info!("instance_id: {}", instance_id);
    info!("tasks: {:?}", tasks);
    info!("agent_configs: {:?}", agent_configs);
    info!("cwd: {}, tcp_compat_mode: {}", cwd, tcp_compat_mode);

    let (resource, controller, tasker) = {
        debug!("[start_tasks] Acquiring instances lock...");
        let mut instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
        debug!("[start_tasks] Instances lock acquired");
        let instance = instances
            .get_mut(&instance_id)
            .ok_or("Instance not found")?;
        debug!("[start_tasks] Instance found: {}", instance_id);

        let res = instance
            .resource
            .as_ref()
            .ok_or("Resource not loaded")?
            .clone();
        debug!("[start_tasks] Resource acquired");

        let ctrl = instance
            .controller
            .as_ref()
            .ok_or("Controller not connected")?
            .clone();
        debug!("[start_tasks] Controller acquired");

        // 创建或获取 tasker（若已有 tasker 但未初始化则自动丢弃并重建）
        let needs_new_tasker = match instance.tasker.as_ref() {
            None => true,
            Some(t) => !t.inited(),
        };
        if needs_new_tasker {
            if instance.tasker.is_some() {
                warn!("[start_tasks] Existing tasker is not initialized, discarding and rebuilding...");
                instance.tasker = None;
            }

            debug!("[start_tasks] Creating new tasker...");
            let t = Tasker::new().map_err(|e| e.to_string())?;
            debug!("[start_tasks] Tasker created");

            // 添加回调 Sink，用于接收任务状态通知并更新后端 TaskRunState
            debug!("[start_tasks] Adding tasker sink...");
            let app_handle = app.clone();
            let maa_state_for_sink = Arc::clone(maa_state);
            let inst_id_for_sink = instance_id.clone();
            t.add_sink(move |msg, detail| {
                // 先更新后端 TaskRunState（单一真相来源）
                handle_task_callback(
                    &maa_state_for_sink,
                    &app_handle,
                    &inst_id_for_sink,
                    msg,
                    detail,
                );
                // 再转发原始回调到前端
                emit_callback_event(&app_handle, msg, detail);
            })
            .map_err(|e| e.to_string())?;
            debug!("[start_tasks] Tasker sink added");

            // 添加 Context Sink，用于接收 Node 级别的通知（包含 focus 消息）
            debug!("[start_tasks] Adding tasker context sink...");
            let app_handle = app.clone();
            let inst_id_for_ctx_sink = instance_id.clone();
            t.add_context_sink(move |msg, detail| {
                // 遥测：把失败节点挂到任务 Span 下，形成失败链路
                super::telemetry::on_node_event(&inst_id_for_ctx_sink, msg, detail);
                emit_callback_event(&app_handle, msg, detail);
            })
            .map_err(|e| e.to_string())?;
            debug!("[start_tasks] Tasker context sink added");

            debug!("[start_tasks] Binding resource and controller...");
            t.bind(&res, &ctrl).map_err(|e| e.to_string())?;
            debug!("[start_tasks] Resource and controller bound");

            instance.tasker = Some(t);
            debug!("[start_tasks] Tasker created and stored");
        } else {
            debug!("[start_tasks] Using existing initialized tasker");
        }

        let t = instance.tasker.as_ref().unwrap().clone();
        (res, ctrl, t)
    };
    debug!("[start_tasks] Resource, controller and tasker acquired, proceeding...");

    // 检查 Tasker 初始化状态
    if !tasker.inited() {
        error!("[start_tasks] Tasker not properly initialized");
        return Err("Tasker not properly initialized".to_string());
    }

    // 启动所有 Agent（如果配置了）
    debug!("[start_tasks] Checking agent configs...");
    if let Some(configs) = agent_configs {
        if configs.is_empty() {
            debug!("[start_tasks] Agent configs list is empty, skipping agent setup");
        } else {
            info!("[start_tasks] Starting {} agent(s)...", configs.len());

            // PI v2.11.0: 使用后端实际数据目录，不随资源目录或客户端传值变化。
            let data_dir = super::utils::get_app_data_dir()?;
            let data_dir = if data_dir.is_absolute() {
                data_dir
            } else {
                std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join(data_dir)
            };
            let mut pi_envs = pi_envs.unwrap_or_default();
            pi_envs.insert(
                "PI_USER_DATA_DIR".to_string(),
                data_dir.to_string_lossy().to_string(),
            );
            let pi_envs = Arc::new(pi_envs);

            // 用于收集所有成功启动的 agent，失败时需要回滚清理
            let mut new_clients = Vec::new();
            let mut new_children = Vec::new();

            for (idx, config) in configs.iter().enumerate() {
                let res_clone = resource.clone();
                let ctrl_clone = controller.clone();
                let tasker_clone = tasker.clone();
                let app_handle = app.clone();
                let inst_id = instance_id.clone();
                let cwd_clone = cwd.clone();
                let pi_envs_clone = Arc::clone(&pi_envs);

                match start_single_agent(
                    app_handle,
                    config.clone(),
                    idx,
                    inst_id,
                    cwd_clone,
                    tcp_compat_mode,
                    res_clone,
                    ctrl_clone,
                    tasker_clone,
                    pi_envs_clone,
                )
                .await
                {
                    Ok((client, child)) => {
                        new_clients.push(client);
                        new_children.push(child);
                    }
                    Err(e) => {
                        error!(
                            "[start_tasks] Agent #{} failed to start: {}, cleaning up previously started agents...",
                            idx, e
                        );

                        // 回滚：清理已启动的 agent
                        for client in &new_clients {
                            let _ = client.disconnect();
                        }
                        for mut child in new_children {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        return Err(format!("Agent start failed: {}", e));
                    }
                }
            }

            // 保存所有 agent 状态到 instance
            let mut instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
            if let Some(instance) = instances.get_mut(&instance_id) {
                instance.agent_clients.extend(new_clients);
                instance.agent_children.extend(new_children);
            }

            info!(
                "[start_tasks] All {} agent(s) started successfully",
                configs.len()
            );

            info!("[start_tasks] Tasks started with agent(s)");
        }
    } else {
        debug!("[start_tasks] No agent configs, skipping agent setup");
    };

    // 遥测：整批运行开始（仅首批；追加批次沿用已有 Transaction）
    // 必须在 post_task 之前，否则首个任务的开始回调会早于 Transaction 创建、丢掉它的 Span
    if reset_state {
        let task_names: Vec<String> = tasks
            .iter()
            .map(|task| task.task_name.clone().unwrap_or_else(|| task.entry.clone()))
            .collect();
        super::telemetry::on_run_start(&instance_id, &task_names, controller_info.as_ref());
    }

    debug!("[start_tasks] Submitting {} tasks...", tasks.len());
    // (maa_task_id, selected_task_id) 配对列表，用于后续初始化 TaskRunState
    let mut task_id_pairs: Vec<(i64, Option<String>)> = Vec::new();
    // 持锁提交，确保任务开始回调不会早于遥测元数据登记
    let mut telemetry_posting = super::telemetry::begin_posting(&instance_id);
    let task_ids_ret;
    {
        // 初始化/追加后端 TaskRunState（单一真相来源）并缓存 task_ids
        debug!(
            "[start_tasks] Updating TaskRunState (reset_state={})...",
            reset_state
        );
        let mut instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
        let instance = instances
            .get_mut(&instance_id)
            .ok_or("Instance not found")?;
        if reset_state {
            // 首批：重置任务运行状态
            instance.task_ids.clear();
            let state = &mut instance.task_run_state;
            state.statuses.clear();
            state.mappings.clear();
            state.pending_task_ids.clear();
            state.current_task_index = 0;
        }
        for (idx, task) in tasks.iter().enumerate() {
            debug!("[start_tasks] Preparing task {}: entry={}", idx, task.entry);

            info!(
                "[start_tasks] Calling post_task: entry={}, override_len={}",
                task.entry,
                task.pipeline_override.len()
            );
            match tasker.post_task(&task.entry, &task.pipeline_override) {
                Ok(job) => {
                    info!("[start_tasks] post_task returned task_id: {}", job.id);
                    task_id_pairs.push((job.id, task.selected_task_id.clone()));
                    // 立即登记，保证回调不会先于状态
                    let state = &mut instance.task_run_state;
                    state.pending_task_ids.push(job.id);
                    if let Some(sel_id) = &task.selected_task_id {
                        state.mappings.insert(job.id, sel_id.clone());
                        state.statuses.insert(sel_id.clone(), "pending".to_string());
                    }
                    if let Some(posting) = telemetry_posting.as_mut() {
                        posting.register(
                            job.id,
                            super::telemetry::TaskMeta {
                                // 缺少 interface 任务名时退回 entry，保证 Span 有可读的名字
                                name: task.task_name.clone().unwrap_or_else(|| task.entry.clone()),
                                options: task.options.clone().unwrap_or_default(),
                            },
                        );
                    }
                    debug!(
                        "[start_tasks] Task {} submitted successfully, task_id: {}",
                        idx, job.id
                    );
                }
                Err(_e) => {
                    warn!("[start_tasks] Failed to post task: {}", task.entry);
                }
            }
        }
        let task_ids: Vec<i64> = task_id_pairs.iter().map(|(id, _)| *id).collect();
        task_ids_ret = task_ids.clone();
        debug!(
            "[start_tasks] All tasks submitted, total: {} task_ids",
            task_ids.len()
        );
        let state = &mut instance.task_run_state;
        state.overall_status = Some("Running".to_string());
        if reset_state {
            instance.task_ids = task_ids;
        } else {
            instance.task_ids.extend(task_ids);
        }
        debug!("[start_tasks] TaskRunState updated");
    }
    // 提交完成，释放遥测状态锁（后续有 await，不能继续持有）
    drop(telemetry_posting);

    // 通知所有客户端：任务已启动，需刷新运行时状态
    super::utils::emit_state_changed(&app, &instance_id, "task-started");

    info!(
        "[start_tasks] start_tasks_impl completed successfully, returning {} task_ids",
        task_ids_ret.len()
    );

    Ok(task_ids_ret)
}

/// 启动任务（支持多个 Agent）— Tauri invoke 入口，委托给 start_tasks_impl
#[tauri::command]
pub async fn maa_start_tasks(
    app: tauri::AppHandle,
    state: State<'_, Arc<MaaState>>,
    instance_id: String,
    tasks: Vec<TaskConfig>,
    agent_configs: Option<Vec<AgentConfig>>,
    cwd: String,
    tcp_compat_mode: bool,
    pi_envs: Option<HashMap<String, String>>,
    reset_state: Option<bool>,
    controller_info: Option<ControllerInfo>,
) -> Result<Vec<i64>, String> {
    start_tasks_impl(
        app,
        &state,
        instance_id,
        tasks,
        agent_configs,
        cwd,
        tcp_compat_mode,
        pi_envs,
        reset_state.unwrap_or(true),
        controller_info,
    )
    .await
}

/// 停止所有 Agent 的核心实现（Tauri invoke 和 HTTP handler 共享）
pub fn stop_agent_impl(maa_state: &Arc<MaaState>, instance_id: &str) -> Result<(), String> {
    info!("stop_agent_impl called for instance: {}", instance_id);

    let (clients, children) = {
        let mut instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
        let instance = instances.get_mut(instance_id).ok_or("Instance not found")?;

        (
            std::mem::take(&mut instance.agent_clients),
            std::mem::take(&mut instance.agent_children),
        )
    };

    if clients.is_empty() && children.is_empty() {
        debug!("[stop_agent] No agents to stop");
        return Ok(());
    }

    info!(
        "[stop_agent] Stopping {} agent client(s) and {} child process(es)...",
        clients.len(),
        children.len()
    );

    // 同步断开所有 client：确保 custom 反注册在返回前完成，
    // 避免旧 agent 的反注册晚于新 agent 的注册，误删新 agent 的同名 custom 条目。
    for client in &clients {
        let _ = client.disconnect();
    }
    drop(clients); // Drop 同步执行 clear_custom_registration()

    // 子进程收尾放到后台：等待自然退出，超时强杀兜底，避免进程泄漏。
    thread::spawn(move || {
        for (i, mut child) in children.into_iter().enumerate() {
            debug!("Waiting for agent process #{} to exit...", i);

            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(5);
            let mut exited = false;

            while start.elapsed() < timeout {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        exited = true;
                        break;
                    }
                    Ok(None) => {
                        thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(e) => {
                        error!("Error waiting for agent #{}: {}", i, e);
                        break;
                    }
                }
            }

            if !exited {
                warn!("Agent process #{} did not exit in time, killing it...", i);
                let _ = child.kill();
                let _ = child.wait();
            } else {
                info!("Background: Agent #{} child process exited", i);
            }
        }
    });

    Ok(())
}

/// 停止所有 Agent 并断开连接 — Tauri invoke 入口，委托给 stop_agent_impl
#[tauri::command]
pub fn maa_stop_agent(state: State<'_, Arc<MaaState>>, instance_id: String) -> Result<(), String> {
    stop_agent_impl(&state, &instance_id)
}
