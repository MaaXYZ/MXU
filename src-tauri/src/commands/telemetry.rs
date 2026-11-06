//! 匿名遥测（数据埋点）模块
//!
//! 基于 Sentry Rust SDK，向资源作者在 `interface.json` 的 `telemetry.sentry.dsn`
//! 指定的 Sentry 项目上报崩溃与任务运行统计。
//!
//! 设计要点：
//! - DSN 仅来自 interface.json 的 `telemetry.sentry.dsn`；空 DSN 或未开启时不初始化、不上报。
//! - 初始化发生在 Tauri `setup()`（早于前端），使 WebView 起来之前的崩溃也能覆盖。
//! - 用户开关（帮助改进软件）与构建期闸门（调试 / 开发版本）都在本模块判定。
//! - `send_default_pii = false`；结构化日志与截图附件均随现有“帮助改进软件”开关启停。
//! - 网络：SDK 后台异步发送、队列有界，不阻塞主流程；`shutdown_timeout` 设小值避免退出卡顿。
//! - 事件模型：一次进程运行 = 一个 Session（Release Health），
//!   一次整批运行 = 一个 Transaction，每个 SavedTask = 一个 child Span，
//!   每个需要上报的 pipeline 节点 = 该任务 Span 下的一个 child Span。
//! - 节点是否上报由 PI v2.9.1 的 `focus.trace` 决定：失败节点默认报，其余消息需显式开启。
//! - 外层 SavedTask 终态失败时再产生一条可聚类的 Error Event，并可附任务级诊断证据。

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sentry::protocol::SpanStatus;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::task_diagnostics::{
    self, DiagnosticLogs, ImageBundle, ImageBundleError, TaskEvidenceStart,
};
use super::types::ControllerInfo;
use super::utils::get_logs_dir;
use super::AppConfigState;

/// Sentry 客户端守卫；持有期间遥测生效，置为 None 即关闭并 flush。
static TELEMETRY_GUARD: Mutex<Option<sentry::ClientInitGuard>> = Mutex::new(None);
/// 最近一次初始化配置，供运行时重新开启使用。
static TELEMETRY_CONFIG: Mutex<Option<TelemetryInitConfig>> = Mutex::new(None);
/// 匿名机器 ID（计算一次后复用，同时作为 Sentry user.id）。
static MACHINE_ID: OnceLock<String> = OnceLock::new();
/// 进行中的运行遥测状态，按 instance_id 索引。
static RUNS: Mutex<BTreeMap<String, RunState>> = Mutex::new(BTreeMap::new());
/// 每次有运行或任务开始时递增。失败截图补采只允许在创建快照的 epoch
/// 内发布结果，因此后续任务无法污染前一个任务的证据。
static EVIDENCE_EPOCH: AtomicU64 = AtomicU64::new(0);
/// 退出或用户关闭遥测后不再接受新的附件 worker。
static FAILURE_WORKERS_CLOSING: AtomicBool = AtomicBool::new(false);
/// 串行化失败事件提交与 Sentry guard 的释放，避免退出竞态丢事件。
static FAILURE_EVENT_SEND_LOCK: Mutex<()> = Mutex::new(());
/// 待完成的附件 worker；退出时从这里生成无附件兜底事件。
static PENDING_FAILURE_WORKERS: OnceLock<PendingFailureWorkers> = OnceLock::new();

/// 前端传入的初始化配置（camelCase 对应 invoke 参数）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryInitConfig {
    /// Sentry DSN；空字符串表示不启用。
    pub dsn: String,
    /// 是否启用（用户 opt-in 且非调试版）。
    pub enabled: bool,
    /// release：MXU@<mxuVersion>+<appName>@<appVersion>。
    pub release: String,
    /// 环境标签，如 stable/beta/production。
    pub environment: String,
    /// 是否启用性能 / 事务上报。
    pub tracing: bool,
    /// 事务采样率 0~1。
    pub traces_sample_rate: f32,
    /// 失败截图附件独立采样率 0~1；Error Event 与结构化日志不受此值影响。
    #[serde(default = "default_sample_rate")]
    pub failure_attachments_sample_rate: f32,
    /// 资源项目名（interface.name）。
    pub app_name: String,
    /// 资源项目版本（interface.version）。
    pub app_version: String,
    /// MXU 本体版本。
    pub mxu_version: String,
}

/// 单次整批运行的遥测状态。
struct RunState {
    /// 单次整批运行的随机关联 ID，同时写入本地日志与 Sentry。
    run_id: String,
    /// 整批运行对应的 Transaction。
    transaction: sentry::TransactionOrSpan,
    /// 每个 SavedTask（maa_task_id）对应的 child Span。
    children: HashMap<i64, sentry::TransactionOrSpan>,
    /// 已提交任务的元数据（maa_task_id → 任务名与选项摘要）。
    metas: HashMap<i64, TaskMeta>,
    /// 各任务当前 pipeline 步骤的起点（maa_task_id → 节点 id 与开始时刻），用于算出在失败节点上卡了多久。
    last_steps: HashMap<i64, (i64, Instant)>,
    /// 各任务直接观测到的失败节点数（maa_task_id → 计数），用于失败事件摘要。
    failed_nodes: HashMap<i64, u32>,
    /// 各任务已上报的节点数（maa_task_id → 计数），用于限流。
    traced_nodes: HashMap<i64, u32>,
    /// 各外层任务第一个直接观测到的失败节点，用于按根因稳定分组。
    failure_signals: HashMap<i64, FailureSignal>,
    /// 各外层任务最后一个直接观测到的失败节点，作为终态上下文保留。
    terminal_failure_signals: HashMap<i64, FailureSignal>,
    /// 各外层任务的运行时间和可选文件边界。
    task_runtime: HashMap<i64, TaskRuntime>,
    /// 当前正在执行的外层 SavedTask id。
    ///
    /// Tasker 用单线程 AsyncRunner 串行执行 posted task，同一时刻至多一个，
    /// 因此嵌套 `Context::run_task` 中失败的节点可据此归属回外层任务的 Span。
    active_task: Option<i64>,
    /// Transaction 级 tag，在 finish 时通过临时 scope 应用（SDK 未提供直接设置 tag 的接口）。
    tags: BTreeMap<String, String>,
    /// 是否已有任务失败。
    has_failed: bool,
    /// 本次运行创建时的项目与截图附件配置，避免运行中切换项目导致事件错配。
    event_config: FailureEventConfig,
}

#[derive(Debug, Clone, Default)]
struct FailureEventConfig {
    app_name: String,
    app_version: String,
    mxu_version: String,
    failure_attachments_sample_rate: f32,
}

impl From<&TelemetryInitConfig> for FailureEventConfig {
    fn from(config: &TelemetryInitConfig) -> Self {
        Self {
            app_name: config.app_name.clone(),
            app_version: config.app_version.clone(),
            mxu_version: config.mxu_version.clone(),
            failure_attachments_sample_rate: config.failure_attachments_sample_rate.clamp(0.0, 1.0),
        }
    }
}

struct TaskRuntime {
    started_at: Instant,
    started_wall_time: SystemTime,
    evidence_start: Option<TaskEvidenceStart>,
    evidence_isolated: bool,
    evidence_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FailureSignal {
    node: String,
    stage: String,
    source_task_id: i64,
    node_id: Option<i64>,
    duration_ms: Option<u64>,
}

#[derive(Clone)]
struct TaskFailureReport {
    run_id: String,
    maa_task_id: i64,
    task: TaskMeta,
    duration_ms: Option<u64>,
    started_wall_time: Option<SystemTime>,
    failure: Option<FailureSignal>,
    terminal_failure: Option<FailureSignal>,
    failed_node_count: u32,
    trace_context: Option<sentry::protocol::TraceContext>,
    tags: BTreeMap<String, String>,
    event_config: FailureEventConfig,
    evidence_start: Option<TaskEvidenceStart>,
    evidence_isolated: bool,
    evidence_epoch: u64,
}

struct PendingFailureWorkers {
    next_id: AtomicU64,
    reports: Mutex<BTreeMap<u64, TaskFailureReport>>,
    idle: Condvar,
}

impl PendingFailureWorkers {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            reports: Mutex::new(BTreeMap::new()),
            idle: Condvar::new(),
        }
    }

    fn register(&self, report: TaskFailureReport) -> Option<u64> {
        let mut reports = self
            .reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if FAILURE_WORKERS_CLOSING.load(Ordering::SeqCst) {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        reports.insert(id, report);
        Some(id)
    }

    fn take(&self, id: u64) -> Option<TaskFailureReport> {
        let report = self
            .reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&id);
        if report.is_some() {
            self.idle.notify_all();
        }
        report
    }

    fn wait_until_idle(&self, timeout: Duration) -> bool {
        let reports = self
            .reports
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if reports.is_empty() {
            return true;
        }
        let (reports, _) = self
            .idle
            .wait_timeout_while(reports, timeout, |reports| !reports.is_empty())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reports.is_empty()
    }

    fn drain(&self) -> Vec<TaskFailureReport> {
        let reports = std::mem::take(
            &mut *self
                .reports
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        if !reports.is_empty() {
            self.idle.notify_all();
        }
        reports.into_values().collect()
    }

    fn cancel_all(&self) {
        self.drain();
    }
}

/// 单个任务最多上报的节点数（失败节点与 `trace` 显式开启的节点共用这份预算）。
///
/// SDK 对单个 Transaction 有 1000 个 Span 的硬上限且超出后静默丢弃，
/// 这里与该上限对齐，避免本侧更早截断。
const MAX_TRACED_NODES_PER_TASK: u32 = 1000;
/// 退出时给已经开始压缩的附件一个短暂完成窗口；超时则发送无附件兜底事件。
const FAILURE_WORKER_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);
/// MaaFramework may finish writing an on_error screenshot shortly after the terminal
/// callback. Poll only inside the task's evidence epoch and stop promptly on shutdown.
const IMAGE_SETTLE_TIMEOUT: Duration = Duration::from_secs(1);
const IMAGE_SETTLE_INTERVAL: Duration = Duration::from_millis(100);

/// 单个 SavedTask 的遥测元数据，由前端在提交任务时给出。
#[derive(Debug, Clone, Default)]
pub struct TaskMeta {
    /// interface 任务名，作为 Span 的 description。
    pub name: String,
    /// 已脱敏的选项摘要。
    pub options: BTreeMap<String, String>,
}

/// 主机硬件摘要。
struct HardwareInfo {
    cpu: String,
    cpu_cores: u32,
    memory_total_mb: u64,
    gpu: String,
    os: String,
}

const fn default_sample_rate() -> f32 {
    1.0
}

fn pending_failure_workers() -> &'static PendingFailureWorkers {
    PENDING_FAILURE_WORKERS.get_or_init(PendingFailureWorkers::new)
}

/// 遥测是否处于激活状态（已初始化且客户端存在）。
pub fn is_active() -> bool {
    TELEMETRY_GUARD.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// 启动期初始化，在 Tauri `setup()` 中调用（interface / config 加载之后）。
///
/// 相比等前端 `telemetry_init`，这里能覆盖 WebView2 缺失、interface 解析失败等
/// 启动即崩的场景；同时 Session 会挂在主线程 hub 上，退出时才能正确收尾。
pub fn init_at_startup(app_config: &AppConfigState) {
    // 无论是否启用都记录：用户反馈问题时可凭这行在 Sentry 后台按 user.id 定位
    log::info!(
        "[telemetry] 匿名机器 ID (Sentry user.id) = {}",
        machine_id()
    );

    let Some(config) = build_startup_config(app_config) else {
        log::info!("[telemetry] interface 未声明 telemetry.sentry.dsn，跳过初始化");
        return;
    };

    if is_blocked_by_build(&config.app_version) {
        log::info!("[telemetry] 调试 / 开发版本，跳过初始化（MXU_TELEMETRY_FORCE=1 可放行）");
        return;
    }

    cache_config(config.clone());

    if !config.enabled || config.dsn.trim().is_empty() {
        log::info!("[telemetry] 用户未开启，跳过初始化");
        return;
    }

    do_init(&config);
}

/// 从已加载的 interface + config 组装初始化参数；未声明 DSN 时返回 None。
fn build_startup_config(app_config: &AppConfigState) -> Option<TelemetryInitConfig> {
    let project_interface = app_config
        .project_interface
        .lock()
        .ok()
        .and_then(|pi| pi.clone())?;

    let sentry_cfg = project_interface.get("telemetry")?.get("sentry")?;
    let dsn = sentry_cfg.get("dsn")?.as_str()?.trim().to_string();
    if dsn.is_empty() {
        return None;
    }

    let app_name = project_interface
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let app_version = project_interface
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();

    // 用户开关缺省视为开启，与前端 `helpImproveSoftware ?? true` 一致
    let (enabled, channel) = {
        let config = app_config.config.lock().ok()?;
        let settings = config.get("settings");
        let enabled = settings
            .and_then(|s| s.get("helpImproveSoftware"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let channel = settings
            .and_then(|s| s.get("mirrorChyan"))
            .and_then(|m| m.get("channel"))
            .and_then(|v| v.as_str())
            .unwrap_or("production")
            .to_string();
        (enabled, channel)
    };

    let mxu_version = env!("CARGO_PKG_VERSION").to_string();

    Some(TelemetryInitConfig {
        dsn,
        enabled,
        release: format!("MXU@{mxu_version}+{app_name}@{app_version}"),
        environment: sentry_cfg
            .get("environment")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or(channel),
        tracing: sentry_cfg
            .get("tracing")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        traces_sample_rate: sentry_cfg
            .get("traces_sample_rate")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0) as f32,
        failure_attachments_sample_rate: sentry_cfg
            .get("failure_attachments_sample_rate")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0) as f32,
        app_name,
        app_version,
        mxu_version,
    })
}

/// 构建期闸门：调试 / 开发版本一律不上报，`MXU_TELEMETRY_FORCE=1` 用于本地联调放行。
fn is_blocked_by_build(app_version: &str) -> bool {
    if std::env::var("MXU_TELEMETRY_FORCE").is_ok_and(|v| v == "1") {
        return false;
    }
    cfg!(debug_assertions) || is_debug_version(app_version)
}

/// 资源项目版本是否为非正式版本，与前端 `isDebugVersion` 保持一致。
fn is_debug_version(version: &str) -> bool {
    if version.is_empty() {
        return false;
    }
    if version == "DEBUG_VERSION" {
        return true;
    }

    let normalized = version.trim_start_matches(['v', 'V']);
    let baseline = semver::Version::new(1, 0, 0);

    if let Ok(parsed) = semver::Version::parse(normalized) {
        if parsed < baseline {
            return true;
        }
        if parsed.pre.is_empty() {
            return false;
        }
        // 仅 beta / rc 属于对外预发布，其余（ci.123、alpha.1 等）按调试版处理
        return !parsed
            .pre
            .as_str()
            .split('.')
            .any(|tag| tag == "beta" || tag == "rc");
    }

    // 非标准版本号：退化为提取前导数字比较，与前端 `semver.coerce` 的兜底对应
    coerce_version(normalized).is_some_and(|version| version < baseline)
}

/// 从非标准版本号中提取最多三段前导数字，解析不出数字时返回 None。
fn coerce_version(version: &str) -> Option<semver::Version> {
    let start = version.find(|c: char| c.is_ascii_digit())?;
    let mut rest = &version[start..];
    let mut parts = [0u64; 3];

    for part in parts.iter_mut() {
        let digits = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        *part = rest[..digits].parse().ok()?;
        rest = &rest[digits..];
        if !rest.starts_with('.') {
            break;
        }
        rest = &rest[1..];
        if !rest.starts_with(|c: char| c.is_ascii_digit()) {
            break;
        }
    }

    Some(semver::Version::new(parts[0], parts[1], parts[2]))
}

/// 缓存初始化参数，供运行时开关复用。
fn cache_config(config: TelemetryInitConfig) {
    if let Ok(mut slot) = TELEMETRY_CONFIG.lock() {
        *slot = Some(config);
    }
}

/// 前端校正遥测配置；启动期已初始化时仅更新缓存与开关，不重复建客户端。
#[tauri::command]
pub fn telemetry_init(config: TelemetryInitConfig) {
    // 二次 sentry::init 会建出第二个 client 与第二条 Session，因此这里只做校正
    if is_active() {
        let enabled = config.enabled;
        cache_config(config);
        if !enabled {
            telemetry_set_enabled(false);
        }
        return;
    }

    // 兜底：启动期初始化未成功（如 interface.json 读不到）时允许迟到初始化，
    // 闸门与启动期共用，避免调试版从这条路绕过
    if is_blocked_by_build(&config.app_version) {
        log::info!("[telemetry] 调试 / 开发版本，跳过初始化（MXU_TELEMETRY_FORCE=1 可放行）");
        return;
    }

    cache_config(config.clone());

    if !config.enabled || config.dsn.trim().is_empty() {
        log::info!("[telemetry] 未启用或缺少 DSN，跳过初始化");
        return;
    }

    do_init(&config);
}

/// 运行时切换遥测开关。
#[tauri::command]
pub fn telemetry_set_enabled(enabled: bool) {
    if enabled {
        // 已激活则无需重复初始化
        if is_active() {
            return;
        }
        let cfg = TELEMETRY_CONFIG.lock().ok().and_then(|c| c.clone());
        if let Some(mut cfg) = cfg {
            cfg.enabled = true;
            if !cfg.dsn.trim().is_empty() {
                do_init(&cfg);
            }
        }
        return;
    }

    FAILURE_WORKERS_CLOSING.store(true, Ordering::SeqCst);
    let _send_guard = FAILURE_EVENT_SEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 用户主动关闭后不得再发送排队中的事件或附件。
    pending_failure_workers().cancel_all();
    // 先正常结束 Session，否则它会一直挂着并最终被判为 abnormal，拉低 crash-free 率
    if is_active() {
        sentry::end_session_with_status(sentry::protocol::SessionStatus::Exited);
    }
    // 关闭：丢弃守卫（close 会 flush 并使后续 capture 变为 no-op）
    if let Ok(mut slot) = TELEMETRY_GUARD.lock() {
        *slot = None;
    }
    // 清理进行中的运行状态，避免悬挂事务
    if let Ok(mut runs) = RUNS.lock() {
        runs.clear();
    }
}

/// 应用退出收尾：结束悬挂的 Transaction 与 Session，并 flush 队列。
///
/// 由 `RunEvent::Exit` 调用。最小化到托盘不算退出，不在那里收尾。
pub fn on_app_exit() {
    if !is_active() {
        return;
    }

    FAILURE_WORKERS_CLOSING.store(true, Ordering::SeqCst);

    // 退出时仍在跑的整批运行按取消收尾，避免整条 Transaction 丢失
    let pending: Vec<String> = RUNS
        .lock()
        .map(|runs| runs.keys().cloned().collect())
        .unwrap_or_default();
    for instance_id in pending {
        finish_run(&instance_id, Some(SpanStatus::Cancelled));
    }

    let workers = pending_failure_workers();
    let workers_completed = workers.wait_until_idle(FAILURE_WORKER_DRAIN_TIMEOUT);
    let _send_guard = FAILURE_EVENT_SEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Worker 超时后保留 Error Event，日志与截图证据会明确标记为不可用。发送锁保证后台线程
    // 无法在这里与 guard 释放交错，也不会产生重复事件。
    let fallback_reports = workers.drain();
    let fallback_count = fallback_reports.len();
    for report in fallback_reports {
        capture_failure_event(
            report,
            None,
            FailureAttachmentOutcome::Omitted {
                status: "shutdown_fallback",
                detail: "evidence worker did not finish before telemetry shutdown".to_string(),
                selected_raw_bytes: None,
                bundle_bytes: None,
            },
        );
    }

    sentry::end_session_with_status(sentry::protocol::SessionStatus::Exited);

    // 丢弃守卫触发 flush（上限为 shutdown_timeout）
    if let Ok(mut slot) = TELEMETRY_GUARD.lock() {
        *slot = None;
    }
    log::info!(
        "[telemetry] 已结束 Session 并 flush workers_completed={} fallback_events={}",
        workers_completed,
        fallback_count
    );
}

/// 实际执行 Sentry 初始化并配置 scope。
fn do_init(config: &TelemetryInitConfig) {
    if let Err(err) = config.dsn.parse::<sentry::types::Dsn>() {
        log::warn!("[telemetry] DSN 解析失败: {err}");
        return;
    }

    let traces_sample_rate = if config.tracing {
        config.traces_sample_rate.clamp(0.0, 1.0)
    } else {
        0.0
    };

    pending_failure_workers().cancel_all();
    FAILURE_WORKERS_CLOSING.store(false, Ordering::SeqCst);

    let options = sentry::ClientOptions::new()
        .before_send(super::log_secrets::redact_serializable)
        .before_send_log(super::log_secrets::redact_serializable)
        .dsn(&config.dsn)
        .release(config.release.clone())
        .environment(config.environment.clone())
        .traces_sample_rate(traces_sample_rate)
        // 任务失败日志走 Sentry Logs；截图附件使用独立采样率。
        .enable_logs(true)
        // 隐私：不采集用户 IP、请求头等 PII
        .send_default_pii(false)
        // Session（Release Health）：一次进程运行一条，init 时自动开始
        .auto_session_tracking(true)
        .session_mode(sentry::SessionMode::Application)
        // 网络差时退出不长时间阻塞（退出路径还要清理 agent 子进程）
        .shutdown_timeout(Duration::from_secs(1));
    let guard = sentry::init(options);

    if let Ok(mut slot) = TELEMETRY_GUARD.lock() {
        *slot = Some(guard);
    }

    configure_scope(config);
    log::info!("[telemetry] 已初始化 (release={})", config.release);
}

/// 配置全局 scope：匿名用户、版本 tag、硬件 context。
fn configure_scope(config: &TelemetryInitConfig) {
    let hw = collect_hardware();

    sentry::configure_scope(|scope| {
        scope.set_user(Some(sentry::User {
            id: Some(machine_id().to_string()),
            ..Default::default()
        }));

        scope.set_tag("app.name", config.app_name.clone());
        scope.set_tag("app.version", config.app_version.clone());
        scope.set_tag("mxu.version", config.mxu_version.clone());

        let mut map: BTreeMap<String, sentry::protocol::Value> = BTreeMap::new();
        map.insert("cpu".into(), hw.cpu.clone().into());
        map.insert("cpu_cores".into(), hw.cpu_cores.into());
        map.insert("memory_total_mb".into(), hw.memory_total_mb.into());
        map.insert("gpu".into(), hw.gpu.clone().into());
        map.insert("os".into(), hw.os.clone().into());
        scope.set_context("hardware", sentry::protocol::Context::Other(map));
    });
}

/// 匿名机器 ID，首次调用时计算并缓存。
fn machine_id() -> &'static str {
    MACHINE_ID.get_or_init(hashed_machine_id)
}

/// 计算稳定的匿名机器 ID：machine-uid 原值加盐后 sha256，物理机固定、重启不变。
fn hashed_machine_id() -> String {
    let raw = machine_uid::get().unwrap_or_else(|_| "unknown-machine".to_string());
    let mut hasher = Sha256::new();
    hasher.update(b"mxu-telemetry-v1:");
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 采集主机硬件摘要（CPU / 内存 / GPU / OS）。
fn collect_hardware() -> HardwareInfo {
    let sys = sysinfo::System::new_all();

    let cpu = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();
    let cpu_cores = sys.cpus().len() as u32;
    // sysinfo 返回字节
    let memory_total_mb = sys.total_memory() / 1024 / 1024;
    let os = format!(
        "{} {}",
        sysinfo::System::name().unwrap_or_default(),
        sysinfo::System::os_version().unwrap_or_default()
    )
    .trim()
    .to_string();
    let gpu = collect_gpu();

    HardwareInfo {
        cpu,
        cpu_cores,
        memory_total_mb,
        gpu,
        os,
    }
}

/// Windows：从注册表读取主显卡名称（DriverDesc）；其他平台暂不采集。
#[cfg(windows)]
fn collect_gpu() -> String {
    use winsafe::co::{KEY, REG_OPTION};
    use winsafe::{RegistryValue, HKEY};

    let path =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000";
    let key =
        match HKEY::LOCAL_MACHINE.RegOpenKeyEx(Some(path), REG_OPTION::NoValue, KEY::QUERY_VALUE) {
            Ok(key) => key,
            Err(_) => return String::new(),
        };

    match key.RegQueryValueEx(Some("DriverDesc")) {
        Ok(RegistryValue::Sz(name)) | Ok(RegistryValue::ExpandSz(name)) => name.trim().to_string(),
        _ => String::new(),
    }
}

/// 非 Windows 平台：暂不采集 GPU。
#[cfg(not(windows))]
fn collect_gpu() -> String {
    String::new()
}

// ============ 任务事件埋点 ============

fn evidence_isolated_for_ids<'a>(
    current_instance: &str,
    mut running_instances: impl Iterator<Item = &'a str>,
) -> bool {
    !running_instances.any(|running_id| running_id != current_instance)
}

/// 整批运行开始：创建 Transaction，并记录本次使用的 controller。
pub fn on_run_start(instance_id: &str, task_names: &[String], controller: Option<&ControllerInfo>) {
    if !is_active() {
        return;
    }

    // A new run may write to the same process-wide debug directory. Active tasks
    // compare this epoch at their terminal callback and omit ambiguous evidence.
    EVIDENCE_EPOCH.fetch_add(1, Ordering::SeqCst);
    let run_id = sentry::types::random_uuid().to_string();
    let event_config = TELEMETRY_CONFIG
        .lock()
        .ok()
        .and_then(|config| config.as_ref().map(FailureEventConfig::from))
        .unwrap_or_default();
    let ctx = sentry::TransactionContext::new("mxu.task_run", "mxu.run");
    let transaction: sentry::TransactionOrSpan = sentry::start_transaction(ctx).into();
    transaction.set_data("run_id", run_id.clone().into());
    transaction.set_data("task_count", (task_names.len() as u64).into());
    if !task_names.is_empty() {
        transaction.set_data("tasks", task_names.join(",").into());
    }

    // controller 既写 data（事件详情可见）又留作 tag（Sentry 中可搜索 / 分组）
    let mut tags = BTreeMap::from([("run.id".to_string(), run_id.clone())]);
    if let Some(controller) = controller {
        for (key, value) in [
            ("controller.name", controller.name.as_deref()),
            ("controller.type", controller.type_name.as_deref()),
        ] {
            let Some(value) = value.filter(|s| !s.is_empty()) else {
                continue;
            };
            transaction.set_data(key, value.into());
            tags.insert(key.to_string(), value.to_string());
        }
    }

    if let Ok(mut runs) = RUNS.lock() {
        runs.insert(
            instance_id.to_string(),
            RunState {
                run_id: run_id.clone(),
                transaction,
                children: HashMap::new(),
                metas: HashMap::new(),
                last_steps: HashMap::new(),
                failed_nodes: HashMap::new(),
                traced_nodes: HashMap::new(),
                failure_signals: HashMap::new(),
                terminal_failure_signals: HashMap::new(),
                task_runtime: HashMap::new(),
                active_task: None,
                tags,
                has_failed: false,
                event_config,
            },
        );
    }
    log::info!("[telemetry] run started run_id={run_id} instance_id={instance_id}");
}

/// 提交任务期间的元数据登记句柄，持有遥测状态锁。
pub struct PostingGuard {
    runs: std::sync::MutexGuard<'static, BTreeMap<String, RunState>>,
    instance_id: String,
}

impl PostingGuard {
    /// 登记一个刚提交的任务的任务名与选项摘要。
    pub fn register(&mut self, maa_task_id: i64, meta: TaskMeta) {
        if let Some(run) = self.runs.get_mut(&self.instance_id) {
            run.metas.insert(maa_task_id, meta);
        }
    }
}

/// 开始提交任务：让 post_task 与元数据登记处于同一临界区。
///
/// MaaFW 会在 `post_task` 返回后立刻在通知线程发出 `Tasker.Task.Starting`，
/// 若元数据尚未登记，该任务的 Span 就会丢失任务名。持锁提交可让回调线程短暂等待
/// （仅数毫秒，不阻塞任务执行），从而保证 Span 一定能取到元数据。
pub fn begin_posting(instance_id: &str) -> Option<PostingGuard> {
    if !is_active() {
        return None;
    }

    let runs = RUNS.lock().ok()?;
    if !runs.contains_key(instance_id) {
        return None;
    }
    Some(PostingGuard {
        runs,
        instance_id: instance_id.to_string(),
    })
}

/// 单个 SavedTask 开始：创建 child Span，description 用 interface 任务名。
///
/// Span 上会带 MaaFW 的 task id。它是进程内自增计数器、跨用户没有可比性，
/// 因此只作为 data 供人工比对用户日志包里的 `maafw.log`，不设成可搜索的 tag。
pub fn on_task_start(instance_id: &str, maa_task_id: i64) {
    if !is_active() {
        return;
    }

    let capture_evidence = if let Ok(mut runs) = RUNS.lock() {
        let evidence_isolated =
            evidence_isolated_for_ids(instance_id, runs.keys().map(String::as_str));
        // Starting any task supersedes every older screenshot settle window,
        // including tasks belonging to another application instance.
        let evidence_epoch = EVIDENCE_EPOCH
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        if let Some(run) = runs.get_mut(instance_id) {
            let meta = run.metas.get(&maa_task_id).cloned().unwrap_or_default();
            let span: sentry::TransactionOrSpan =
                run.transaction.start_child("mxu.task", &meta.name).into();
            span.set_data("run_id", run.run_id.clone().into());
            span.set_data("task", meta.name.clone().into());
            span.set_data("task_id", maa_task_id.into());
            for (key, value) in &meta.options {
                span.set_data(&format!("option.{key}"), value.clone().into());
            }
            run.children.insert(maa_task_id, span);
            run.task_runtime.insert(
                maa_task_id,
                TaskRuntime {
                    started_at: Instant::now(),
                    started_wall_time: SystemTime::now(),
                    evidence_start: None,
                    evidence_isolated,
                    evidence_epoch,
                },
            );
            run.active_task = Some(maa_task_id);
            // 日志采集独立于截图附件采样；仅多实例并行时因证据无法可靠归属而跳过。
            evidence_isolated
        } else {
            false
        }
    } else {
        false
    };

    // Filesystem discovery can be slower than a state update, so do it without the
    // telemetry-state lock. The log prelude covers lines written
    // between the callback and this snapshot.
    if capture_evidence {
        let evidence_start = task_diagnostics::capture_task_start(&get_logs_dir());
        if let Ok(mut runs) = RUNS.lock() {
            if let Some(runtime) = runs
                .get_mut(instance_id)
                .and_then(|run| run.task_runtime.get_mut(&maa_task_id))
            {
                runtime.evidence_start = Some(evidence_start);
            }
        }
    }
}

/// 节点级回调：按 PI v2.9.1 的 `focus.trace` 决定是否把节点结果挂成任务 Span 的 child Span。
///
/// `Node.PipelineNode.Failed` 默认上报：它在 MaaFW 的每个 pipeline 步骤上恰好成对出现一次，
/// 而 `Node.NextList.Failed` 每次截图未命中都会发一次，`Node.Action.Failed` 又拿不到识别卡死的情况。
/// 其余 `Node.*` 消息需资源作者在 `focus` 里显式写 `"trace": true`。
///
/// 由 tasker 的 context sink 调用，属于高频回调，因此先比较消息名再解析 JSON。
pub fn on_node_event(instance_id: &str, message: &str, details: &str) {
    // Starting 要记步骤起点、Failed 默认上报，两者必须解析；其余消息的 detail 可达数 KB
    // （Succeeded 带完整识别结果），只有 detail 里出现过 trace 才值得整串解析
    let needs_parse = matches!(
        message,
        "Node.PipelineNode.Starting" | "Node.PipelineNode.Failed"
    ) || (message.starts_with("Node.") && details.contains("\"trace\""));
    if !needs_parse {
        return;
    }

    if !is_active() {
        return;
    }

    let Ok(detail) = serde_json::from_str::<serde_json::Value>(details) else {
        return;
    };
    let Some(task_id) = detail.get("task_id").and_then(|v| v.as_i64()) else {
        return;
    };
    let node_id = detail.get("node_id").and_then(|v| v.as_i64());

    // 步骤起点与是否上报无关：步骤收尾时靠它算出在该节点上停留了多久
    if message == "Node.PipelineNode.Starting" {
        if let Some(node_id) = node_id {
            mark_step_start(instance_id, task_id, node_id);
        }
    }

    if !resolve_trace(&detail, message) {
        return;
    }
    record_node_event(instance_id, message, task_id, node_id, &detail);
}

/// 解析本条消息的有效 `trace`（PI v2.9.1）：`focus` 对象里显式给出则用之，否则用协议默认值。
///
/// 默认仅 `Node.PipelineNode.Failed` 为 true，其余 `Node.*` 需显式开启。
fn resolve_trace(detail: &serde_json::Value, message: &str) -> bool {
    detail
        .get("focus")
        .and_then(|focus| focus.get(message))
        .and_then(|entry| entry.get("trace"))
        .and_then(|v| v.as_bool())
        .unwrap_or(message == "Node.PipelineNode.Failed")
}

/// 记录某任务当前 pipeline 步骤的起点。
fn mark_step_start(instance_id: &str, task_id: i64, node_id: i64) {
    let Ok(mut runs) = RUNS.lock() else {
        return;
    };
    let Some(run) = runs.get_mut(instance_id) else {
        return;
    };
    run.last_steps.insert(task_id, (node_id, Instant::now()));
}

/// 为一个需要上报的节点事件建一条 child Span 并立刻收尾。
///
/// 是否上报由 `focus.trace` 决定（`focus` 与 `details.name` 同节点）。Span 名沿用 2.9.1 前逻辑：
/// `Node.PipelineNode.*` 若有 `node_details.name`（已命中并执行）优先用之，否则用搜 `next`
/// 的当前节点 `details.name`。因此 Span 名与配置了 `trace` 的节点在命中场景下可不一致。
///
/// `node_details` 亦用于区分失败阶段；有命中时把搜 next 的当前节点写入 `search_node`。
fn record_node_event(
    instance_id: &str,
    message: &str,
    task_id: i64,
    node_id: Option<i64>,
    detail: &serde_json::Value,
) {
    let search_node = detail
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty());
    let hit_node = message
        .starts_with("Node.PipelineNode.")
        .then(|| {
            detail
                .get("node_details")
                .and_then(|d| d.get("name"))
                .and_then(|v| v.as_str())
                .filter(|n| !n.is_empty())
        })
        .flatten();
    let Some(node) = hit_node.or(search_node) else {
        return;
    };
    // 失败落在哪一阶段：命中节点后动作执行失败，还是 next 列表在 reco_timeout 内始终未命中
    let stage = (message == "Node.PipelineNode.Failed").then(|| {
        if hit_node.is_some() {
            "action"
        } else {
            "recognition"
        }
    });

    let Ok(mut runs) = RUNS.lock() else {
        return;
    };
    let Some(run) = runs.get_mut(instance_id) else {
        return;
    };

    // `Context::run_task` 的子 pipeline 会新发 task_id，回调里的 id 未登记过时归属到当前活跃的外层任务，
    // 否则 FailureCollector 这类「子任务失败但吞掉」的流程只剩汇总节点能上报，看不到真正的根因节点
    let owner_id = if run.children.contains_key(&task_id) {
        task_id
    } else {
        match run.active_task {
            Some(id) if run.children.contains_key(&id) => id,
            _ => return,
        }
    };

    // 只有步骤收尾消息才结算耗时：步骤中途的消息若把起点取走，真正的步骤结果就算不出时长了。
    // 另外 node_id 对不上也不结算，宁可不写也不写错
    let duration_ms = matches!(
        message,
        "Node.PipelineNode.Succeeded" | "Node.PipelineNode.Failed"
    )
    .then(|| {
        run.last_steps
            .remove(&task_id)
            .filter(|(id, _)| Some(*id) == node_id)
            .map(|(_, started)| started.elapsed().as_millis() as u64)
    })
    .flatten();
    // 冗余任务名，否则 Sentry 侧无法把节点 Span 归属到具体任务（span 查询不能沿父子关系向上过滤）
    let task_name = run
        .metas
        .get(&owner_id)
        .map(|meta| meta.name.clone())
        .unwrap_or_default();

    // 失败事件摘要不依赖 trace Span 的数量预算；即使 Span 已达上限，仍保留根因和终态信号。
    if let Some(stage) = stage {
        *run.failed_nodes.entry(owner_id).or_insert(0) += 1;
        retain_failure_signals(
            &mut run.failure_signals,
            &mut run.terminal_failure_signals,
            owner_id,
            FailureSignal {
                node: node.to_string(),
                stage: stage.to_string(),
                source_task_id: task_id,
                node_id,
                duration_ms,
            },
        );
    }

    let count = run.traced_nodes.entry(owner_id).or_insert(0);
    *count += 1;
    if *count > MAX_TRACED_NODES_PER_TASK {
        return;
    }

    let Some(task_span) = run.children.get(&owner_id) else {
        return;
    };

    let span = task_span.start_child("mxu.node", node);
    span.set_status(if message.ends_with(".Failed") {
        SpanStatus::InternalError
    } else {
        SpanStatus::Ok
    });
    span.set_data("message", message.into());
    if hit_node.is_some() {
        if let Some(search_node) = search_node {
            span.set_data("search_node", search_node.into());
        }
    }
    if let Some(stage) = stage {
        span.set_data("stage", stage.into());
    }
    if !task_name.is_empty() {
        span.set_data("task", task_name.into());
    }
    // 嵌套 `Context::run_task` 时这是子 pipeline 的 id，与父 Span 上的外层任务不同
    span.set_data("task_id", task_id.into());
    if let Some(node_id) = node_id {
        span.set_data("node_id", node_id.into());
    }
    if let Some(duration_ms) = duration_ms {
        span.set_data("duration_ms", duration_ms.into());
    }
    span.finish();
}

fn retain_failure_signals(
    roots: &mut HashMap<i64, FailureSignal>,
    terminals: &mut HashMap<i64, FailureSignal>,
    owner_id: i64,
    signal: FailureSignal,
) {
    roots.entry(owner_id).or_insert_with(|| signal.clone());
    terminals.insert(owner_id, signal);
}

/// 单个 SavedTask 结束：为 child Span 打结果并 finish。
pub fn on_task_finished(instance_id: &str, maa_task_id: i64, success: bool) {
    if !is_active() {
        return;
    }

    let report = if let Ok(mut runs) = RUNS.lock() {
        if let Some(run) = runs.get_mut(instance_id) {
            if !success {
                run.has_failed = true;
            }
            let task = run.metas.remove(&maa_task_id).unwrap_or_default();
            let runtime = run.task_runtime.remove(&maa_task_id);
            run.last_steps.remove(&maa_task_id);
            let failed_node_count = run.failed_nodes.remove(&maa_task_id).unwrap_or(0);
            run.traced_nodes.remove(&maa_task_id);
            let failure = run.failure_signals.remove(&maa_task_id);
            let terminal_failure = run.terminal_failure_signals.remove(&maa_task_id);
            if run.active_task == Some(maa_task_id) {
                run.active_task = None;
            }
            let trace_context = run
                .children
                .get(&maa_task_id)
                .map(|span| span.get_trace_context());
            if let Some(span) = run.children.remove(&maa_task_id) {
                span.set_data("result", if success { "success" } else { "failure" }.into());
                span.set_status(if success {
                    sentry::protocol::SpanStatus::Ok
                } else {
                    sentry::protocol::SpanStatus::InternalError
                });
                span.finish();
            }

            if success {
                None
            } else {
                let (
                    duration_ms,
                    started_wall_time,
                    evidence_start,
                    evidence_isolated,
                    evidence_epoch,
                ) = runtime
                    .map(|runtime| {
                        (
                            Some(runtime.started_at.elapsed().as_millis() as u64),
                            Some(runtime.started_wall_time),
                            runtime.evidence_start,
                            runtime.evidence_isolated,
                            runtime.evidence_epoch,
                        )
                    })
                    .unwrap_or((
                        None,
                        None,
                        None,
                        true,
                        EVIDENCE_EPOCH.load(Ordering::SeqCst),
                    ));
                Some(TaskFailureReport {
                    run_id: run.run_id.clone(),
                    maa_task_id,
                    task,
                    duration_ms,
                    started_wall_time,
                    failure,
                    terminal_failure,
                    failed_node_count,
                    trace_context,
                    tags: run.tags.clone(),
                    event_config: run.event_config.clone(),
                    evidence_start,
                    evidence_isolated,
                    evidence_epoch,
                })
            }
        } else {
            None
        }
    } else {
        None
    };

    if let Some(report) = report {
        submit_failure_report(report);
    }
}

enum FailureAttachmentOutcome {
    NotSelected,
    Attached(ImageBundle),
    Omitted {
        status: &'static str,
        detail: String,
        selected_raw_bytes: Option<u64>,
        bundle_bytes: Option<usize>,
    },
}

fn submit_failure_report(mut report: TaskFailureReport) {
    if !report.evidence_isolated {
        report.evidence_start = None;
        send_failure_event(
            report,
            None,
            FailureAttachmentOutcome::Omitted {
                status: "concurrent_instance",
                detail: "another instance run overlapped this task evidence window".to_string(),
                selected_raw_bytes: None,
                bundle_bytes: None,
            },
        );
        return;
    }

    let Some(evidence_start) = report.evidence_start.take() else {
        send_failure_event(report, None, FailureAttachmentOutcome::NotSelected);
        return;
    };
    // Freeze logs and any already-visible screenshots immediately. An empty terminal
    // selection remains eligible for the bounded late-screenshot settle window.
    let selection = task_diagnostics::capture_task_end(evidence_start);
    if EVIDENCE_EPOCH.load(Ordering::SeqCst) != report.evidence_epoch {
        send_failure_event(
            report,
            None,
            FailureAttachmentOutcome::Omitted {
                status: "concurrent_instance",
                detail: "another instance run started before the evidence boundary was frozen"
                    .to_string(),
                selected_raw_bytes: None,
                bundle_bytes: None,
            },
        );
        return;
    }

    let workers = pending_failure_workers();
    let include_images = should_sample_attachment(
        &report.run_id,
        report.maa_task_id,
        report.event_config.failure_attachments_sample_rate,
    );
    let Some(worker_id) = workers.register(report.clone()) else {
        send_failure_event(
            report,
            None,
            FailureAttachmentOutcome::Omitted {
                status: "shutdown_in_progress",
                detail: "telemetry shutdown started before evidence processing".to_string(),
                selected_raw_bytes: None,
                bundle_bytes: None,
            },
        );
        return;
    };

    // Preserve the configured client and top scope when crossing the thread boundary.
    // Stable file handles and end offsets are already frozen; bounded log reads and
    // optional screenshot compression run in the background. The pending registry
    // owns an event-only fallback for exit.
    let hub = Arc::new(sentry::Hub::new_from_top(sentry::Hub::current()));
    if let Err(error) = std::thread::Builder::new()
        .name("mxu-failure-evidence".to_string())
        .spawn(move || {
            sentry::Hub::run(hub, || {
                let mut selection = selection;
                settle_task_images(&mut selection, report.evidence_epoch);
                let logs = task_diagnostics::build_diagnostic_logs(&mut selection);
                let outcome = if include_images {
                    match task_diagnostics::build_image_bundle(
                        selection,
                        &report.run_id,
                        report.maa_task_id,
                    ) {
                        Ok(bundle) => FailureAttachmentOutcome::Attached(bundle),
                        Err(error) => attachment_error_outcome(error),
                    }
                } else {
                    FailureAttachmentOutcome::NotSelected
                };
                complete_failure_worker(worker_id, report, Some(logs), outcome);
            });
        })
    {
        log::warn!("[telemetry] failed to start evidence worker: {error}");
        if let Some(report) = workers.take(worker_id) {
            send_failure_event(
                report,
                None,
                FailureAttachmentOutcome::Omitted {
                    status: "worker_unavailable",
                    detail: error.to_string(),
                    selected_raw_bytes: None,
                    bundle_bytes: None,
                },
            );
        }
    }
}

fn settle_task_images(
    selection: &mut task_diagnostics::TaskEvidenceSelection,
    expected_epoch: u64,
) {
    let deadline = Instant::now() + IMAGE_SETTLE_TIMEOUT;
    loop {
        if FAILURE_WORKERS_CLOSING.load(Ordering::SeqCst)
            || EVIDENCE_EPOCH.load(Ordering::SeqCst) != expected_epoch
        {
            return;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return;
        }
        std::thread::sleep(remaining.min(IMAGE_SETTLE_INTERVAL));

        if FAILURE_WORKERS_CLOSING.load(Ordering::SeqCst)
            || EVIDENCE_EPOCH.load(Ordering::SeqCst) != expected_epoch
        {
            return;
        }
        let refresh = task_diagnostics::capture_task_image_refresh(selection);
        // A new task may have started during discovery. Never publish that stale scan.
        if EVIDENCE_EPOCH.load(Ordering::SeqCst) != expected_epoch {
            return;
        }
        task_diagnostics::apply_task_image_refresh(selection, refresh);
    }
}

fn complete_failure_worker(
    worker_id: u64,
    report: TaskFailureReport,
    logs: Option<DiagnosticLogs>,
    outcome: FailureAttachmentOutcome,
) {
    let _send_guard = FAILURE_EVENT_SEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Shutdown or an explicit opt-out may already have consumed/cancelled this
    // worker's fallback. In that case the detached compressor must remain silent.
    if pending_failure_workers().take(worker_id).is_some() && is_active() {
        capture_failure_event(report, logs, outcome);
    }
}

fn send_failure_event(
    report: TaskFailureReport,
    logs: Option<DiagnosticLogs>,
    outcome: FailureAttachmentOutcome,
) {
    let _send_guard = FAILURE_EVENT_SEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if is_active() {
        capture_failure_event(report, logs, outcome);
    }
}

fn attachment_error_outcome(error: ImageBundleError) -> FailureAttachmentOutcome {
    match error {
        ImageBundleError::NoEvidence => FailureAttachmentOutcome::Omitted {
            status: "no_evidence",
            detail: ImageBundleError::NoEvidence.to_string(),
            selected_raw_bytes: None,
            bundle_bytes: None,
        },
        ImageBundleError::TooLarge {
            selected_raw_bytes,
            bundle_bytes,
        } => FailureAttachmentOutcome::Omitted {
            status: if bundle_bytes.is_some() {
                "bundle_too_large"
            } else {
                "raw_too_large"
            },
            detail: ImageBundleError::TooLarge {
                selected_raw_bytes,
                bundle_bytes,
            }
            .to_string(),
            selected_raw_bytes: Some(selected_raw_bytes),
            bundle_bytes,
        },
        error => FailureAttachmentOutcome::Omitted {
            status: "build_failed",
            detail: error.to_string(),
            selected_raw_bytes: None,
            bundle_bytes: None,
        },
    }
}

fn capture_failure_event(
    report: TaskFailureReport,
    logs: Option<DiagnosticLogs>,
    outcome: FailureAttachmentOutcome,
) {
    let task_name = if report.task.name.is_empty() {
        "unknown-task".to_string()
    } else {
        report.task.name.clone()
    };
    let observed_node = report
        .failure
        .as_ref()
        .map(|failure| failure.node.as_str())
        .unwrap_or("terminal_failure");
    let observed_stage = report
        .failure
        .as_ref()
        .map(|failure| failure.stage.as_str())
        .unwrap_or("unknown");
    let trace_id = report
        .trace_context
        .as_ref()
        .map(|context| context.trace_id);
    let span_id = report.trace_context.as_ref().map(|context| context.span_id);

    let mut event = sentry::protocol::Event {
        message: Some(format!(
            "Maa task failed: {task_name} at {observed_node} ({observed_stage})"
        )),
        logger: Some("mxu.task".to_string()),
        transaction: Some("mxu.task.failure".to_string()),
        fingerprint: Cow::Owned(vec![
            Cow::Borrowed("mxu-task-failure"),
            Cow::Owned(report.event_config.app_name.clone()),
            Cow::Owned(task_name.clone()),
            Cow::Owned(observed_node.to_string()),
            Cow::Owned(observed_stage.to_string()),
        ]),
        ..Default::default()
    };

    event.tags = report.tags;
    for (key, value) in [
        ("app.name", report.event_config.app_name.as_str()),
        ("app.version", report.event_config.app_version.as_str()),
        ("mxu.version", report.event_config.mxu_version.as_str()),
        ("task.name", task_name.as_str()),
        ("failure.node", observed_node),
        ("failure.stage", observed_stage),
        ("result", "failure"),
    ] {
        if !value.is_empty() {
            event.tags.insert(key.to_string(), tag_value(value));
        }
    }

    event
        .extra
        .insert("run.id".to_string(), report.run_id.clone().into());
    event
        .extra
        .insert("task.id".to_string(), report.maa_task_id.into());
    event.extra.insert(
        "failure.count".to_string(),
        (report.failed_node_count as u64).into(),
    );
    if let Some(duration_ms) = report.duration_ms {
        event
            .extra
            .insert("task.duration_ms".to_string(), duration_ms.into());
    }
    if let Some(started_at_ms) = report.started_wall_time.and_then(unix_time_ms) {
        event
            .extra
            .insert("task.started_at_ms".to_string(), started_at_ms.into());
    }
    if let Some(failure) = &report.failure {
        set_failure_extra(&mut event, "failure", failure);
    }
    if let Some(terminal) = report
        .terminal_failure
        .as_ref()
        .filter(|terminal| report.failure.as_ref() != Some(*terminal))
    {
        set_failure_extra(&mut event, "terminal_failure", terminal);
    }
    for (key, value) in report.task.options {
        event.extra.insert(format!("option.{key}"), value.into());
    }
    if let Some(trace_context) = report.trace_context {
        event.contexts.insert(
            "trace".to_string(),
            sentry::protocol::Context::Trace(Box::new(trace_context)),
        );
    }

    set_log_evidence_data(&mut event, logs.as_ref());

    let attachment = match outcome {
        FailureAttachmentOutcome::NotSelected => {
            event
                .extra
                .insert("attachment.status".to_string(), "not_selected".into());
            None
        }
        FailureAttachmentOutcome::Attached(bundle) => {
            event
                .extra
                .insert("attachment.status".to_string(), "attached".into());
            event.extra.insert(
                "attachment.image_count".to_string(),
                (bundle.image_count as u64).into(),
            );
            event.extra.insert(
                "attachment.selected_raw_bytes".to_string(),
                bundle.selected_raw_bytes.into(),
            );
            event.extra.insert(
                "attachment.bundle_bytes".to_string(),
                (bundle.buffer.len() as u64).into(),
            );
            event.extra.insert(
                "attachment.selection".to_string(),
                "new_on_error_screenshots".into(),
            );
            if !bundle.warnings.is_empty() {
                event.extra.insert(
                    "attachment.warnings".to_string(),
                    bundle.warnings.join(",").into(),
                );
            }
            Some(sentry::protocol::Attachment {
                buffer: bundle.buffer,
                filename: bundle.filename,
                content_type: Some("application/zip".to_string()),
                ..Default::default()
            })
        }
        FailureAttachmentOutcome::Omitted {
            status,
            detail,
            selected_raw_bytes,
            bundle_bytes,
        } => {
            event
                .extra
                .insert("attachment.status".to_string(), status.into());
            event
                .extra
                .insert("attachment.detail".to_string(), detail.into());
            if let Some(size) = selected_raw_bytes {
                event
                    .extra
                    .insert("attachment.selected_raw_bytes".to_string(), size.into());
            }
            if let Some(size) = bundle_bytes {
                event
                    .extra
                    .insert("attachment.bundle_bytes".to_string(), (size as u64).into());
            }
            None
        }
    };

    let expected_event_id = event.event_id;
    let expected_event_id_text = expected_event_id.to_string();
    if let Some(logs) = &logs {
        capture_diagnostic_logs(
            logs,
            &expected_event_id_text,
            &report.run_id,
            report.maa_task_id,
            &task_name,
            observed_node,
            observed_stage,
            trace_id,
            span_id,
        );
    }
    let captured_event_id = if let Some(attachment) = attachment {
        sentry::with_scope(
            |scope| scope.add_attachment(attachment),
            || sentry::capture_event(event),
        )
    } else {
        sentry::capture_event(event)
    };
    let event_id = if captured_event_id.is_nil() {
        expected_event_id
    } else {
        captured_event_id
    };
    log::info!(
        "[telemetry] task failure event_id={} run_id={} task_id={} task={}",
        event_id,
        report.run_id,
        report.maa_task_id,
        task_name
    );
}

fn set_failure_extra(
    event: &mut sentry::protocol::Event<'_>,
    prefix: &str,
    failure: &FailureSignal,
) {
    event
        .extra
        .insert(format!("{prefix}.node"), failure.node.clone().into());
    event
        .extra
        .insert(format!("{prefix}.stage"), failure.stage.clone().into());
    event.extra.insert(
        format!("{prefix}.source_task_id"),
        failure.source_task_id.into(),
    );
    if let Some(node_id) = failure.node_id {
        event
            .extra
            .insert(format!("{prefix}.node_id"), node_id.into());
    }
    if let Some(duration_ms) = failure.duration_ms {
        event
            .extra
            .insert(format!("{prefix}.duration_ms"), duration_ms.into());
    }
}

fn set_log_evidence_data(event: &mut sentry::protocol::Event<'_>, logs: Option<&DiagnosticLogs>) {
    let Some(logs) = logs else {
        event
            .extra
            .insert("logs.status".to_string(), "not_available".into());
        return;
    };

    event.extra.insert(
        "logs.status".to_string(),
        if logs.entries.is_empty() {
            "no_evidence"
        } else {
            "captured"
        }
        .into(),
    );
    event
        .extra
        .insert("logs.count".to_string(), (logs.entries.len() as u64).into());
    event.extra.insert(
        "logs.selected_raw_bytes".to_string(),
        logs.selected_raw_bytes.into(),
    );
    event
        .extra
        .insert("logs.truncated".to_string(), logs.truncated.into());
    if !logs.warnings.is_empty() {
        event
            .extra
            .insert("logs.warnings".to_string(), logs.warnings.join(",").into());
    }
}

/// Relay accepts at most 1 MiB for a logs envelope item, while sentry-rust batches
/// up to 100 records without considering their byte size. Keeping each locally
/// serialized record within 7 KiB leaves headroom for SDK-added attributes and the
/// JSON array framing of a full batch.
const MAX_SERIALIZED_DIAGNOSTIC_LOG_BYTES: usize = 7 * 1024;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_CHARACTERS: usize = 200;

#[derive(Clone, Copy)]
struct DiagnosticLogContext<'a> {
    event_id: &'a str,
    run_id: &'a str,
    maa_task_id: i64,
    task_name: &'a str,
    failure_node: &'a str,
    failure_stage: &'a str,
    trace_id: Option<sentry::protocol::TraceId>,
    span_id: Option<sentry::protocol::SpanId>,
}

#[allow(clippy::too_many_arguments)]
fn capture_diagnostic_logs(
    logs: &DiagnosticLogs,
    event_id: &str,
    run_id: &str,
    maa_task_id: i64,
    task_name: &str,
    failure_node: &str,
    failure_stage: &str,
    trace_id: Option<sentry::protocol::TraceId>,
    span_id: Option<sentry::protocol::SpanId>,
) {
    let context = DiagnosticLogContext {
        event_id,
        run_id,
        maa_task_id,
        task_name,
        failure_node,
        failure_stage,
        trace_id,
        span_id,
    };
    for source in &logs.entries {
        for record in build_diagnostic_log_records(source, context) {
            sentry::Hub::current().capture_log(record);
        }
    }
}

fn build_diagnostic_log_records(
    source: &task_diagnostics::DiagnosticLog,
    context: DiagnosticLogContext<'_>,
) -> Vec<sentry::protocol::Log> {
    let mut attributes = sentry::protocol::Map::new();
    let mut attributes_truncated = false;
    for (key, value) in [
        ("diagnostic.reason", "task_failure"),
        ("diagnostic.source", source.source.as_str()),
        ("diagnostic.kind", source.kind),
        ("sentry.event_id", context.event_id),
        ("run.id", context.run_id),
        ("task.name", context.task_name),
        ("failure.node", context.failure_node),
        ("failure.stage", context.failure_stage),
    ] {
        let bounded = bounded_log_attribute(value);
        attributes_truncated |= bounded != value;
        attributes.insert(key.to_string(), bounded.into());
    }
    attributes.insert("task.id".to_string(), context.maa_task_id.into());
    attributes.insert("log.raw_bytes".to_string(), source.raw_bytes.into());
    // Use the widest possible integers while sizing chunks. The real index/count
    // values below can only make the final serialized records smaller.
    attributes.insert("log.chunk_index".to_string(), u64::MAX.into());
    attributes.insert("log.chunk_count".to_string(), u64::MAX.into());
    if attributes_truncated {
        attributes.insert("diagnostic.attributes_truncated".to_string(), true.into());
    }
    if let Some(trace_id) = context.trace_id {
        attributes.insert("trace.id".to_string(), trace_id.to_string().into());
    }
    if let Some(span_id) = context.span_id {
        attributes.insert("span.id".to_string(), span_id.to_string().into());
    }

    let timestamp = SystemTime::now();
    // Redact before splitting: a password spanning chunk boundaries must not leak as fragments.
    let content = super::log_secrets::redact(&source.content);
    let chunks = serialized_log_chunks(&content, &attributes, context.trace_id, timestamp);
    let chunk_count = chunks.len() as u64;
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let mut chunk_attributes = attributes.clone();
            chunk_attributes.insert("log.chunk_index".to_string(), (index as u64).into());
            chunk_attributes.insert("log.chunk_count".to_string(), chunk_count.into());
            sentry::protocol::Log {
                level: diagnostic_log_level(chunk),
                body: chunk.to_string(),
                trace_id: context.trace_id,
                timestamp,
                severity_number: None,
                attributes: chunk_attributes,
            }
        })
        .collect()
}

fn serialized_log_chunks<'a>(
    value: &'a str,
    attributes: &sentry::protocol::Map<String, sentry::protocol::LogAttribute>,
    trace_id: Option<sentry::protocol::TraceId>,
    timestamp: SystemTime,
) -> Vec<&'a str> {
    if value.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut candidate_end = value
            .len()
            .min(start.saturating_add(MAX_SERIALIZED_DIAGNOSTIC_LOG_BYTES));
        while candidate_end > start && !value.is_char_boundary(candidate_end) {
            candidate_end -= 1;
        }
        if candidate_end == start {
            candidate_end += value[start..]
                .chars()
                .next()
                .expect("start is before the string end")
                .len_utf8();
        }

        let mut boundaries: Vec<usize> = value[start..candidate_end]
            .char_indices()
            .skip(1)
            .map(|(offset, _)| start + offset)
            .collect();
        boundaries.push(candidate_end);

        let mut low = 0;
        let mut high = boundaries.len();
        let mut best = None;
        while low < high {
            let middle = low + (high - low) / 2;
            let end = boundaries[middle];
            if diagnostic_log_fits(&value[start..end], attributes, trace_id, timestamp) {
                best = Some(end);
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        let end = best.expect("bounded diagnostic attributes leave room for one character");
        chunks.push(&value[start..end]);
        start = end;
    }
    chunks
}

fn diagnostic_log_fits(
    body: &str,
    attributes: &sentry::protocol::Map<String, sentry::protocol::LogAttribute>,
    trace_id: Option<sentry::protocol::TraceId>,
    timestamp: SystemTime,
) -> bool {
    let record = sentry::protocol::Log {
        // Fatal is one of the longest serialized level names, so this is a safe
        // sizing proxy for the level inferred after splitting.
        level: sentry::protocol::LogLevel::Fatal,
        body: body.to_string(),
        trace_id,
        timestamp,
        severity_number: None,
        attributes: attributes.clone(),
    };
    serde_json::to_vec(&record)
        .is_ok_and(|serialized| serialized.len() <= MAX_SERIALIZED_DIAGNOSTIC_LOG_BYTES)
}

fn bounded_log_attribute(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .take(MAX_DIAGNOSTIC_LOG_ATTRIBUTE_CHARACTERS)
        .collect()
}

fn diagnostic_log_level(content: &str) -> sentry::protocol::LogLevel {
    let upper = content.to_ascii_uppercase();
    if upper.contains("[FTL]") || upper.contains("[FATAL]") {
        sentry::protocol::LogLevel::Fatal
    } else if upper.contains("[ERR]") || upper.contains("[ERROR]") {
        sentry::protocol::LogLevel::Error
    } else if upper.contains("[WRN]") || upper.contains("[WARN]") {
        sentry::protocol::LogLevel::Warn
    } else if upper.contains("[DBG]") || upper.contains("[DEBUG]") {
        sentry::protocol::LogLevel::Debug
    } else {
        sentry::protocol::LogLevel::Info
    }
}

fn should_sample_attachment(run_id: &str, maa_task_id: i64, sample_rate: f32) -> bool {
    let sample_rate = sample_rate.clamp(0.0, 1.0);
    if sample_rate <= 0.0 {
        return false;
    }
    if sample_rate >= 1.0 {
        return true;
    }

    let mut hasher = Sha256::new();
    hasher.update(b"mxu-failure-attachment-v1:");
    hasher.update(run_id.as_bytes());
    hasher.update(maa_task_id.to_le_bytes());
    let digest = hasher.finalize();
    let bucket = u64::from_le_bytes(digest[..8].try_into().expect("SHA-256 has 8 bytes"));
    let normalized = bucket as f64 / u64::MAX as f64;
    normalized < sample_rate as f64
}

fn tag_value(value: &str) -> String {
    value.chars().take(200).collect()
}

fn unix_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

/// 整批运行结束；提交失败也必须失败，即使没有任务 Failed 回调。
pub fn on_run_finished(instance_id: &str, succeeded: bool) {
    finish_run(
        instance_id,
        (!succeeded).then_some(SpanStatus::InternalError),
    );
}

/// 用户取消 / 停止：以 cancelled 结束 Transaction。
pub fn on_run_cancelled(instance_id: &str) {
    finish_run(instance_id, Some(SpanStatus::Cancelled));
}

/// Span / Transaction 的 `result` data 文案，与其状态保持一致。
fn result_label(status: SpanStatus) -> &'static str {
    match status {
        SpanStatus::Ok => "success",
        SpanStatus::Cancelled => "cancelled",
        _ => "failure",
    }
}

/// 结束一次运行：未 finish 的 child 一并收尾，再 finish Transaction。
fn finish_run(instance_id: &str, forced_status: Option<SpanStatus>) {
    let Ok(mut runs) = RUNS.lock() else {
        return;
    };
    let Some(mut run) = runs.remove(instance_id) else {
        return;
    };

    // 收尾未完成的 child（如取消时仍在运行的任务）
    let pending: Vec<i64> = run.children.keys().copied().collect();
    for id in pending {
        if let Some(span) = run.children.remove(&id) {
            let status = forced_status.unwrap_or(SpanStatus::Cancelled);
            span.set_status(status);
            span.set_data("result", result_label(status).into());
            span.finish();
        }
    }

    let status = forced_status.unwrap_or(if run.has_failed {
        SpanStatus::InternalError
    } else {
        SpanStatus::Ok
    });
    run.transaction.set_status(status);
    run.transaction
        .set_data("result", result_label(status).into());

    // Transaction 的 tag 只能来自 finish 时当前 scope，故用临时 scope 承载本次运行的 tag
    let tags = std::mem::take(&mut run.tags);
    let transaction = run.transaction;
    sentry::with_scope(
        |scope| {
            for (key, value) in tags {
                scope.set_tag(&key, value);
            }
        },
        || transaction.finish(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure_report() -> TaskFailureReport {
        TaskFailureReport {
            run_id: "run-123".to_string(),
            maa_task_id: 42,
            task: TaskMeta {
                name: "DailyTask".to_string(),
                options: BTreeMap::from([("mode".to_string(), "normal".to_string())]),
            },
            duration_ms: Some(1_500),
            started_wall_time: Some(UNIX_EPOCH + Duration::from_secs(10)),
            failure: Some(FailureSignal {
                node: "EnterBattle".to_string(),
                stage: "recognition".to_string(),
                source_task_id: 43,
                node_id: Some(7),
                duration_ms: Some(800),
            }),
            terminal_failure: Some(FailureSignal {
                node: "FailureCollector".to_string(),
                stage: "action".to_string(),
                source_task_id: 42,
                node_id: Some(9),
                duration_ms: Some(20),
            }),
            failed_node_count: 3,
            trace_context: None,
            tags: BTreeMap::from([("run.id".to_string(), "run-123".to_string())]),
            event_config: FailureEventConfig {
                app_name: "MaaEnd".to_string(),
                app_version: "2.0.0".to_string(),
                mxu_version: "0.1.0".to_string(),
                failure_attachments_sample_rate: 1.0,
            },
            evidence_start: None,
            evidence_isolated: true,
            evidence_epoch: 1,
        }
    }

    #[test]
    fn terminal_failure_creates_one_groupable_event_with_one_attachment() {
        let envelopes = sentry::test::with_captured_envelopes(|| {
            capture_failure_event(
                failure_report(),
                None,
                FailureAttachmentOutcome::Attached(ImageBundle {
                    buffer: b"zip-body".to_vec(),
                    filename: "failure.zip".to_string(),
                    image_count: 1,
                    selected_raw_bytes: 1024,
                    warnings: Vec::new(),
                }),
            );
        });

        assert_eq!(envelopes.len(), 1);
        let items: Vec<_> = envelopes[0].items().collect();
        assert_eq!(items.len(), 2);
        let sentry::protocol::EnvelopeItem::Event(event) = items[0] else {
            panic!("first envelope item should be an event");
        };
        assert_eq!(event.tags["task.name"], "DailyTask");
        assert_eq!(event.tags["failure.node"], "EnterBattle");
        assert_eq!(
            event.extra["terminal_failure.node"],
            sentry::protocol::Value::from("FailureCollector")
        );
        assert_eq!(
            event.extra["run.id"],
            sentry::protocol::Value::from("run-123")
        );
        assert_eq!(event.extra["task.id"], sentry::protocol::Value::from(42i64));
        assert_eq!(event.tags["failure.stage"], "recognition");
        assert_eq!(event.fingerprint.len(), 5);
        assert_eq!(event.fingerprint[0], "mxu-task-failure");
        assert_eq!(event.fingerprint[2], "DailyTask");
        assert_eq!(event.fingerprint[3], "EnterBattle");
        let sentry::protocol::EnvelopeItem::Attachment(attachment) = items[1] else {
            panic!("second envelope item should be an attachment");
        };
        assert_eq!(attachment.filename, "failure.zip");
        assert_eq!(attachment.buffer, b"zip-body");
    }

    #[test]
    fn diagnostic_logs_are_chunked_and_linked_to_the_failure_event() {
        let content = format!("[ERR] {}", "界".repeat(16 * 1024 + 5));
        let expected_content = content.clone();
        let options = sentry::ClientOptions::new().enable_logs(true);
        let envelopes = sentry::test::with_captured_envelopes_options(
            || {
                capture_failure_event(
                    failure_report(),
                    Some(DiagnosticLogs {
                        entries: vec![task_diagnostics::DiagnosticLog {
                            source: "maafw.log".to_string(),
                            kind: "maafw",
                            content,
                            raw_bytes: expected_content.len() as u64,
                        }],
                        selected_raw_bytes: expected_content.len() as u64,
                        truncated: false,
                        warnings: Vec::new(),
                    }),
                    FailureAttachmentOutcome::NotSelected,
                );
            },
            options,
        );

        let mut event_id = None;
        let mut log_bodies = Vec::new();
        let mut linked_event_ids = Vec::new();
        for envelope in &envelopes {
            for item in envelope.items() {
                match item {
                    sentry::protocol::EnvelopeItem::Event(event) => {
                        event_id = Some(event.event_id.to_string());
                        assert_eq!(
                            event.extra["logs.status"],
                            sentry::protocol::Value::String("captured".to_string())
                        );
                    }
                    sentry::protocol::EnvelopeItem::ItemContainer(
                        sentry::protocol::ItemContainer::Logs(logs),
                    ) => {
                        for log in logs.iter() {
                            log_bodies.push(log.body.clone());
                            linked_event_ids.push(
                                log.attributes
                                    .get("sentry.event_id")
                                    .expect("linked failure event id")
                                    .clone(),
                            );
                            assert_eq!(
                                log.attributes["diagnostic.source"],
                                sentry::protocol::LogAttribute::from("maafw.log")
                            );
                        }
                    }
                    _ => {}
                }
            }
        }

        assert!(log_bodies.len() > 2);
        assert_eq!(log_bodies.concat(), expected_content);
        let expected_event_id = sentry::protocol::LogAttribute::from(
            event_id.expect("failure event should be captured"),
        );
        assert!(linked_event_ids
            .iter()
            .all(|linked| linked == &expected_event_id));
    }

    #[test]
    fn diagnostic_password_is_redacted_before_log_chunking() {
        let secret = "unique-chunk-password-".repeat(1024);
        super::super::log_secrets::register(&[secret.clone()]);
        let source = task_diagnostics::DiagnosticLog {
            source: "maafw.log".to_string(),
            kind: "maafw",
            raw_bytes: secret.len() as u64,
            content: format!("before{secret}after"),
        };
        let records = build_diagnostic_log_records(
            &source,
            DiagnosticLogContext {
                event_id: "00000000000000000000000000000000",
                run_id: "run-redaction",
                maa_task_id: 42,
                task_name: "DailyTask",
                failure_node: "EnterBattle",
                failure_stage: "recognition",
                trace_id: None,
                span_id: None,
            },
        );
        assert_eq!(
            records
                .iter()
                .map(|record| record.body.as_str())
                .collect::<String>(),
            "before******after"
        );
    }

    #[test]
    fn serialized_log_chunking_preserves_unicode_and_bounds_every_record() {
        let content = format!("{}{}", "界".repeat(8 * 1024), "\0".repeat(8 * 1024));
        let source = task_diagnostics::DiagnosticLog {
            source: "maafw.log".to_string(),
            kind: "maafw",
            content: content.clone(),
            raw_bytes: content.len() as u64,
        };
        let records = build_diagnostic_log_records(
            &source,
            DiagnosticLogContext {
                event_id: "00000000000000000000000000000000",
                run_id: "run-123",
                maa_task_id: 42,
                task_name: "DailyTask",
                failure_node: "EnterBattle",
                failure_stage: "recognition",
                trace_id: None,
                span_id: None,
            },
        );

        assert!(records.len() > 2);
        assert_eq!(
            records
                .iter()
                .map(|record| record.body.as_str())
                .collect::<String>(),
            content
        );
        assert!(records.iter().all(|record| {
            serde_json::to_vec(record)
                .is_ok_and(|serialized| serialized.len() <= MAX_SERIALIZED_DIAGNOSTIC_LOG_BYTES)
        }));
    }

    #[test]
    fn sdk_log_batches_stay_below_the_relay_item_limit() {
        const SENTRY_LOG_ITEM_LIMIT_BYTES: usize = 1024 * 1024;

        // Control characters are a deliberate worst case: each byte expands to a
        // six-byte JSON escape sequence and forces more than one 100-record batch.
        let content = "\0".repeat(160 * 1024);
        let expected_content = content.clone();
        let options = sentry::ClientOptions::new().enable_logs(true);
        let envelopes = sentry::test::with_captured_envelopes_options(
            || {
                capture_failure_event(
                    failure_report(),
                    Some(DiagnosticLogs {
                        entries: vec![task_diagnostics::DiagnosticLog {
                            source: "maafw.log".to_string(),
                            kind: "maafw",
                            content,
                            raw_bytes: expected_content.len() as u64,
                        }],
                        selected_raw_bytes: expected_content.len() as u64,
                        truncated: false,
                        warnings: Vec::new(),
                    }),
                    FailureAttachmentOutcome::NotSelected,
                );
            },
            options,
        );

        let mut batch_count = 0;
        let mut bodies = Vec::new();
        for envelope in &envelopes {
            for item in envelope.items() {
                if let sentry::protocol::EnvelopeItem::ItemContainer(
                    sentry::protocol::ItemContainer::Logs(logs),
                ) = item
                {
                    batch_count += 1;
                    assert!(logs.len() <= 100);
                    assert!(
                        serde_json::to_vec(logs).expect("serialize logs item").len()
                            < SENTRY_LOG_ITEM_LIMIT_BYTES
                    );
                    bodies.extend(logs.iter().map(|record| record.body.clone()));
                }
            }
        }

        assert!(batch_count > 1);
        assert_eq!(bodies.concat(), expected_content);
    }

    #[test]
    fn attachment_sampling_has_stable_boundaries() {
        assert!(!should_sample_attachment("run", 1, 0.0));
        assert!(should_sample_attachment("run", 1, 1.0));
        assert_eq!(
            should_sample_attachment("run", 42, 0.5),
            should_sample_attachment("run", 42, 0.5)
        );
    }

    #[test]
    fn first_failure_is_retained_for_grouping_and_last_failure_is_preserved() {
        let mut roots = HashMap::new();
        let mut terminals = HashMap::new();
        let root = FailureSignal {
            node: "RootNode".to_string(),
            stage: "recognition".to_string(),
            source_task_id: 7,
            node_id: Some(1),
            duration_ms: Some(100),
        };
        let terminal = FailureSignal {
            node: "Collector".to_string(),
            stage: "action".to_string(),
            source_task_id: 8,
            node_id: Some(2),
            duration_ms: Some(10),
        };

        retain_failure_signals(&mut roots, &mut terminals, 42, root.clone());
        retain_failure_signals(&mut roots, &mut terminals, 42, terminal.clone());

        assert_eq!(roots.get(&42), Some(&root));
        assert_eq!(terminals.get(&42), Some(&terminal));
    }

    #[test]
    fn missing_attachment_sample_rate_defaults_to_full_sampling() {
        let config: TelemetryInitConfig = serde_json::from_value(serde_json::json!({
            "dsn": "https://public@example.invalid/1",
            "enabled": true,
            "release": "MXU@1.0.0+App@1.0.0",
            "environment": "test",
            "tracing": true,
            "tracesSampleRate": 1.0,
            "appName": "App",
            "appVersion": "1.0.0",
            "mxuVersion": "1.0.0"
        }))
        .expect("deserialize telemetry config");

        assert_eq!(config.failure_attachments_sample_rate, 1.0);
    }

    #[test]
    fn evidence_is_omitted_when_another_instance_run_exists() {
        assert!(evidence_isolated_for_ids("a", ["a"].into_iter()));
        assert!(!evidence_isolated_for_ids("a", ["a", "b"].into_iter()));
    }

    #[test]
    fn pending_failure_reports_can_be_drained_for_shutdown_fallback() {
        FAILURE_WORKERS_CLOSING.store(false, Ordering::SeqCst);
        let workers = PendingFailureWorkers::new();
        let worker_id = workers
            .register(failure_report())
            .expect("register pending failure");
        assert!(!workers.wait_until_idle(Duration::ZERO));

        let fallback = workers.drain();
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].maa_task_id, 42);
        assert!(workers.take(worker_id).is_none());
        assert!(workers.wait_until_idle(Duration::ZERO));
    }
}
