// Real run_pretask_impl, its desktop stop command and build_launch_command are included
// from the selected checkout. Stub the app/logging boundary; stdout/stderr are drained.
#![allow(dead_code, unused_imports, unused_macros, private_interfaces)]
use std::collections::HashSet;
use std::future::{poll_fn, Future};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

mod pre_action_stops {
    include!("control.rs");
}
mod state {
    use super::*;
    include!("state.rs");
}
use state::MaaState;

mod tauri {
    pub struct AppHandle;
}
mod chrono {
    pub struct Local;
    impl Local {
        pub fn now() -> Self {
            Self
        }
        pub fn format(&self, _: &str) -> &str {
            "fixture"
        }
    }
}
macro_rules! info { ($($item:tt)*) => {{ let _ = format_args!($($item)*); }} }
macro_rules! warn { ($($item:tt)*) => {{ eprintln!($($item)*); }} }
mod utils {
    include!("launch.rs");
}
mod maa_agent {
    use super::*;
    pub fn resolve_child_exec_path(program: &str, cwd: &str) -> PathBuf {
        Path::new(cwd).join(program)
    }
}
static SPAWN_COUNT: AtomicUsize = AtomicUsize::new(0);
struct AgentOutputBatcher;
impl AgentOutputBatcher {
    fn new(_: tauri::AppHandle, _: String) -> Arc<Self> {
        SPAWN_COUNT.fetch_add(1, Ordering::SeqCst);
        Arc::new(Self)
    }
    fn flush(&self) {}
}
struct ChildOutputLog;
impl ChildOutputLog {
    fn new(_: &str) -> Arc<Self> {
        Arc::new(Self)
    }
}
fn spawn_child_output_reader(
    mut pipe: impl std::io::Read + Send + 'static,
    _: &str,
    _: String,
    _: Arc<ChildOutputLog>,
    _: Arc<AgentOutputBatcher>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
    })
}
mod system {
    use super::*;
    use tokio::time::sleep;
    type State<'a, T> = &'a T;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    include!("commands.rs");
}

mod web {
    use super::*;
    struct State<T>(T);
    struct Json<T>(T);
    struct WebState {
        maa_state: Arc<MaaState>,
    }
    struct PretaskStopRequest {
        stop: bool,
    }
    trait IntoResponse {}
    impl<T> IntoResponse for Json<T> {}
    mod axum {
        pub mod extract {
            pub struct Path<T>(pub T);
        }
    }
    include!("web.rs");
    pub async fn stop(state: &Arc<MaaState>, id: &str, value: bool) {
        handle_stop_pretask(
            State(WebState {
                maa_state: state.clone(),
            }),
            axum::extract::Path(id.into()),
            Json(PretaskStopRequest { stop: value }),
        )
        .await;
    }
}

fn stop(state: &Arc<MaaState>, id: &str, value: bool) {
    system::set_pre_action_stop(state, id.to_owned(), value).unwrap()
}
async fn start(state: &Arc<MaaState>, id: &str, marker: &str, mode: &str) -> Result<i32, String> {
    system::run_pretask_impl(
        tauri::AppHandle,
        state,
        id.to_owned(),
        std::env::current_exe().unwrap().to_str().unwrap().into(),
        vec!["--child".into(), marker.into(), mode.into()],
        Some(
            std::env::current_dir()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned(),
        ),
    )
    .await
}

// Advance only to the actual wait loop's first Pending; the future is deliberately not
// scheduled again until both stop/reset requests and the replacement start have completed.
async fn start_and_hold<F: Future>(mut command: Pin<&mut F>, marker: &str) {
    poll_fn(|cx| {
        assert!(command.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !Path::new(&format!("{marker}.ready")).is_file() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("child fixture did not signal readiness");
}
fn report(ok: bool, name: &str, details: impl std::fmt::Debug) -> usize {
    println!("{} {name} {details:?}", if ok { "PASS" } else { "FAIL" });
    usize::from(!ok)
}
fn child_released_lock(marker: &str) -> bool {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{marker}.lock"))
        .unwrap();
    lock.try_lock().is_ok()
}
async fn run() -> usize {
    let mut failures = 0;
    let state = Arc::new(MaaState::default());
    let cancelled = Err(String::from("MXU_PRE_ACTION_CANCELLED"));

    let mut first = Box::pin(start(&state, "A", "first", "wait"));
    start_and_hold(first.as_mut(), "first").await;
    web::stop(&state, "A", true).await;
    stop(&state, "A", false);
    let replacement = start(&state, "A", "second", "quick").await;
    failures += report(
        replacement == Ok(23),
        "replacement completes with its own exit code",
        replacement,
    );
    // At this point cancellation must still win for the old child. The control file lets
    // a buggy child exit naturally, so even the expected baseline failure stays bounded.
    let old = tokio::time::timeout(Duration::from_millis(800), first.as_mut()).await;
    let old = match old {
        Ok(value) => value,
        Err(_) => {
            std::fs::write("first.release", []).unwrap();
            first.await
        }
    };
    failures += report(
        old == cancelled && !Path::new("first.done").exists() && child_released_lock("first"),
        "stop then immediate reset cancels the old process",
        (&old, Path::new("first.done").exists()),
    );

    let mut direct = Box::pin(start(&state, "A", "direct", "wait"));
    start_and_hold(direct.as_mut(), "direct").await;
    stop(&state, "A", false);
    stop(&state, "A", true);
    let result = direct.await;
    let child_exited = child_released_lock("direct");
    failures += report(
        result == cancelled && !Path::new("direct.done").exists() && child_exited,
        "ordinary stop cancels the child",
        (result, child_exited),
    );
    let before = SPAWN_COUNT.load(Ordering::SeqCst);
    let blocked = start(&state, "A", "blocked", "quick").await;
    let spawns = SPAWN_COUNT.load(Ordering::SeqCst) - before;
    failures += report(
        blocked == cancelled && spawns == 0,
        "already-stopped pretask never spawns",
        (blocked, spawns),
    );
    let other = start(&state, "B", "other", "quick").await;
    failures += report(other == Ok(23), "unrelated instance runs normally", other);
    stop(&state, "A", false);
    let retry = start(&state, "A", "retry", "quick").await;
    failures += report(retry == Ok(23), "reset allows next launch", retry);

    // User-configured pre-actions intentionally detach on Stop. Verify the shared
    // cancellation registry still interrupts just the wait for those programs.
    let mut action = Box::pin(system::run_action(
        &state,
        "A".into(),
        std::env::current_exe().unwrap().to_str().unwrap().into(),
        "--child action wait".into(),
        Some(std::env::current_dir().unwrap().to_str().unwrap().into()),
        true,
        Some(false),
    ));
    start_and_hold(action.as_mut(), "action").await;
    stop(&state, "A", true);
    web::stop(&state, "A", false).await;
    let stopped = tokio::time::timeout(Duration::from_millis(800), action.as_mut()).await;
    std::fs::write("action.release", []).unwrap();
    let stopped = match stopped {
        Ok(value) => value,
        Err(_) => action.await,
    };
    let survived = tokio::time::timeout(Duration::from_secs(2), async {
        while !Path::new("action.done").exists() || !child_released_lock("action") {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok();
    failures += report(
        stopped == cancelled && survived,
        "pre-action wait cancelled; program finishes on fixture release",
        (stopped, survived),
    );
    failures
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--child") {
        let marker = &args[2];
        let lock = std::fs::File::create(format!("{marker}.lock")).unwrap();
        lock.lock().unwrap();
        std::fs::write(format!("{marker}.ready"), []).unwrap();
        if args[3] == "wait" {
            let start = Instant::now();
            while !Path::new(&format!("{marker}.release")).exists()
                && start.elapsed() < Duration::from_secs(4)
            {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        std::fs::write(format!("{marker}.done"), []).unwrap();
        std::process::exit(23)
    }
    let failures = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(run());
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
