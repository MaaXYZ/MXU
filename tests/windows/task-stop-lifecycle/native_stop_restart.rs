use maa_framework::controller::Controller;
use maa_framework::custom_controller::CustomControllerCallback;
use maa_framework::resource::Resource;
use maa_framework::MaaStatus;
use mxu_lib::commands::maa_agent::start_tasks_impl;
use mxu_lib::commands::maa_core::{destroy_instance_impl, run_task_impl, stop_task_impl};
use mxu_lib::commands::state::{maa_get_all_states, maa_get_instance_state};
use mxu_lib::commands::types::{InstanceRuntime, MaaState, TaskConfig};
use mxu_lib::commands::utils::handle_task_callback;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use winsafe::{co, guard::CloseHandleGuard, HPROCESS};

const ID: &str = "native-stop-fixture";
const TIMEOUT: Duration = Duration::from_secs(9);

struct FakeDevice(Arc<AtomicBool>);

impl CustomControllerCallback for FakeDevice {
    fn connect(&self) -> bool {
        self.connected()
    }
    fn connected(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    fn request_uuid(&self) -> Option<String> {
        Some("test-device".into())
    }
    fn screencap(&self) -> Option<Vec<u8>> {
        Some(include_bytes!("../icons/icon.png").to_vec())
    }
}

fn wait_idle(state: &MaaState) {
    let until = Instant::now() + TIMEOUT;
    while state.instances.lock().unwrap()[ID].is_running() {
        assert!(Instant::now() < until, "run never became idle");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn batch(app: &tauri::AppHandle, state: &Arc<MaaState>, entries: &[&str], reset: bool) -> Vec<i64> {
    batch_with_override(app, state, entries, reset, "{}")
}

fn batch_with_override(
    app: &tauri::AppHandle,
    state: &Arc<MaaState>,
    entries: &[&str],
    reset: bool,
    pipeline_override: &str,
) -> Vec<i64> {
    let tasks = entries
        .iter()
        .map(|entry| TaskConfig {
            entry: entry.to_string(),
            pipeline_override: pipeline_override.into(),
            selected_task_id: Some(entry.to_string()),
            task_name: None,
            options: None,
        })
        .collect();
    tauri::async_runtime::block_on(start_tasks_impl(
        app.clone(),
        state,
        ID.into(),
        tasks,
        None,
        String::new(),
        false,
        None,
        reset,
        None,
    ))
    .unwrap()
}

struct ChildObserver(CloseHandleGuard<HPROCESS>);

impl std::ops::Deref for ChildObserver {
    type Target = HPROCESS;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for ChildObserver {
    fn drop(&mut self) {
        // An assertion failure must not leave the test executable locked by a child.
        if self.0.WaitForSingleObject(Some(0)).ok() == Some(co::WAIT::TIMEOUT) {
            let _ = self.0.TerminateProcess(1);
            let _ = self.0.WaitForSingleObject(Some(1000));
        }
    }
}

fn attach_child(state: &MaaState) -> ChildObserver {
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "controlled_child"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Retain an independent handle so merely dropping an unreaped Child cannot pass.
    let observer = ChildObserver(
        HPROCESS::OpenProcess(
            co::PROCESS::SYNCHRONIZE | co::PROCESS::TERMINATE,
            false,
            child.id(),
        )
        .unwrap(),
    );
    assert!(child_is_running(&observer));
    state
        .instances
        .lock()
        .unwrap()
        .get_mut(ID)
        .unwrap()
        .agent_children
        .push(child);
    observer
}

fn child_is_running(observer: &HPROCESS) -> bool {
    let observation = observer.WaitForSingleObject(Some(0)).unwrap();
    assert!(observation == co::WAIT::OBJECT_0 || observation == co::WAIT::TIMEOUT);
    observation == co::WAIT::TIMEOUT
}

#[test]
fn native_stop_restart() {
    let dll =
        std::env::var_os("MXU_TEST_MAA_DLL").expect("set MXU_TEST_MAA_DLL to MaaFramework.dll");
    maa_framework::load_library(dll.as_ref()).unwrap();
    let temp = tempfile::tempdir().unwrap();
    maa_framework::configure_logging(temp.path().to_str().unwrap()).unwrap();
    eprintln!("Framework {}", maa_framework::maa_version());
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .any_thread()
        .build(context)
        .unwrap();
    let app = app.handle();

    let resource = Resource::new().unwrap();
    let pipeline = temp.path().join("pipeline");
    std::fs::create_dir(&pipeline).unwrap();
    std::fs::write(
        pipeline.join("tasks.json"),
        r#"{"Warm":{},"Hold":{},"Queued":{},"Append":{},"AfterCallback":{}}"#,
    )
    .unwrap();
    assert_eq!(
        resource
            .post_bundle(temp.path().to_str().unwrap())
            .unwrap()
            .wait(),
        MaaStatus::SUCCEEDED
    );
    let online = Arc::new(AtomicBool::new(true));
    let controller = Controller::new_custom(FakeDevice(online.clone())).unwrap();
    assert_eq!(
        controller.wait(controller.post_connection().unwrap()),
        MaaStatus::SUCCEEDED
    );
    let state = Arc::new(MaaState::default());
    app.manage(Arc::clone(&state));
    let mut instance = InstanceRuntime::default();
    instance.resource = Some(resource);
    instance.controller = Some(controller);
    let lifetime = instance.callback_lifetime.clone();
    state.instances.lock().unwrap().insert(ID.into(), instance);
    assert!(run_task_impl(app, &state, ID, "Warm", "{}", None).unwrap() > 0);
    wait_idle(&state);

    // Rejected posts have no callback. An entirely rejected batch must still
    // fail, reap its Agent child, and release the next submission permit.
    let rejected_child = attach_child(&state);
    let rejected = batch_with_override(app, &state, &["Warm", "Queued"], true, "[");
    assert!(
        rejected.is_empty(),
        "invalid native IDs must not be published"
    );
    wait_idle(&state);
    {
        let instances = state.instances.lock().unwrap();
        let instance = &instances[ID];
        assert!(instance.task_ids.is_empty());
        assert!(instance.task_run_state.pending_task_ids.is_empty());
        assert_eq!(
            instance.task_run_state.overall_status.as_deref(),
            Some("Failed")
        );
        assert_eq!(
            instance
                .task_run_state
                .statuses
                .get("Warm")
                .map(String::as_str),
            Some("failed")
        );
        assert_eq!(
            instance
                .task_run_state
                .statuses
                .get("Queued")
                .map(String::as_str),
            Some("failed")
        );
        assert!(instance.agent_children.is_empty());
    }
    assert!(!child_is_running(&rejected_child));
    assert!(run_task_impl(app, &state, ID, "Warm", "{}", None).unwrap() > 0);
    wait_idle(&state);
    eprintln!("All rejected: no phantom IDs, Failed, child reaped, restart succeeded");

    let tasker = state.instances.lock().unwrap()[ID].tasker.clone().unwrap();
    let (started, await_start) = mpsc::channel();
    let (resume, await_resume) = mpsc::channel();
    let await_resume = Mutex::new(await_resume);
    tasker
        .add_sink(move |message, detail| {
            if message == "Tasker.Task.Starting"
                && serde_json::from_str::<serde_json::Value>(detail).unwrap()["entry"] == "Hold"
            {
                let _ = started.send(());
                let _ = await_resume.lock().unwrap().recv_timeout(TIMEOUT);
            }
        })
        .unwrap();

    // A running queue still accepts both raw and batch appends while its idle
    // observer is active; the observer must not take a blocking start permit.
    batch(app, &state, &["Hold", "Queued"], true);
    await_start.recv_timeout(TIMEOUT).unwrap();
    assert!(tasker.running());
    assert!(run_task_impl(app, &state, ID, "Append", "{}", None).unwrap() > 0);
    assert_eq!(batch(app, &state, &["Append"], false).len(), 1);
    resume.send(()).unwrap();
    wait_idle(&state);
    assert_eq!(
        state.instances.lock().unwrap()[ID]
            .task_run_state
            .overall_status
            .as_deref(),
        Some("Succeeded")
    );
    eprintln!("Normal append: single and bulk accepted, queue succeeded");

    // The native task is paused in its Starting sink. Agent PostStop clears
    // Queued immediately. Both frontends can still append before its stop marker runs.
    let ids = batch(app, &state, &["Hold", "Queued"], true);
    assert_eq!(ids.len(), 2);
    await_start.recv_timeout(TIMEOUT).unwrap();
    let marker = tasker.post_stop().unwrap();
    assert!(marker > 0 && tasker.stopping());
    let single = run_task_impl(app, &state, ID, "Append", "{}", None);
    let bulk = batch(app, &state, &["Append"], false);
    resume.send(()).unwrap();
    wait_idle(&state);
    let normal_agent_status = state.instances.lock().unwrap()[ID]
        .task_run_state
        .overall_status
        .clone();
    eprintln!("Agent PostStop: single={single:?}, bulk={bulk:?}, overall={normal_agent_status:?}");

    // Reuse the instance and replay the old stop callback while the next
    // generation is running. Ordinary callbacks already filter by task ID.
    batch(app, &state, &["Hold", "Queued"], true);
    await_start.recv_timeout(TIMEOUT).unwrap();
    let late = serde_json::json!({"task_id": marker, "entry":"MaaTaskerPostStop"});
    handle_task_callback(
        &state,
        app,
        ID,
        &lifetime,
        "Tasker.Task.Succeeded",
        &late.to_string(),
    );
    let late_marked = state.instances.lock().unwrap()[ID].stop_in_progress;
    stop_task_impl(app, &state, ID).unwrap();
    stop_task_impl(app, &state, ID).unwrap();
    let (did_restart, next_id) = mpsc::channel();
    let (request_start, in_start) = mpsc::channel();
    let next_app = app.clone();
    let next_state = state.clone();
    let next_run = std::thread::spawn(move || {
        request_start.send(()).unwrap();
        let result = run_task_impl(&next_app, &next_state, ID, "Warm", "{}", None);
        did_restart.send(result).unwrap();
    });
    in_start.recv_timeout(TIMEOUT).unwrap();
    assert!(next_id.recv_timeout(Duration::from_millis(100)).is_err());
    resume.send(()).unwrap();
    let manual_restart = next_id.recv_timeout(TIMEOUT).unwrap();
    eprintln!("Repeated Stop, then immediate Start: {manual_restart:?}");
    assert!(manual_restart.unwrap() > 0);
    next_run.join().unwrap();
    wait_idle(&state);
    assert_eq!(
        state.instances.lock().unwrap()[ID]
            .task_run_state
            .overall_status
            .as_deref(),
        Some("Succeeded")
    );

    // Lose the mock device after submission. The framework sets stopping and
    // clears Queued, but cannot post its synthetic stop task after disconnect.
    batch(app, &state, &["Hold", "Queued"], true);
    await_start.recv_timeout(TIMEOUT).unwrap();
    let observer = attach_child(&state);
    online.store(false, Ordering::SeqCst);
    let missing_marker = tasker.post_stop().unwrap();
    assert_eq!(missing_marker, 0);
    assert!(tasker.stopping());
    resume.send(()).unwrap();
    wait_idle(&state);
    let snapshot = {
        let instances = state.instances.lock().unwrap();
        let instance = &instances[ID];
        (
            instance.task_run_state.overall_status.clone(),
            instance.agent_children.len(),
            child_is_running(&observer),
        )
    };
    online.store(true, Ordering::SeqCst);
    let restarted = run_task_impl(app, &state, ID, "Warm", "{}", None).unwrap();
    wait_idle(&state);
    assert_eq!(
        state.instances.lock().unwrap()[ID]
            .task_run_state
            .overall_status
            .as_deref(),
        Some("Succeeded")
    );
    eprintln!("single={single:?} bulk={bulk:?} agent_stop={normal_agent_status:?} late_marked={late_marked} disconnect={snapshot:?} restart={restarted}");
    assert!(
        single.is_err() && bulk.is_empty(),
        "native rejection published as a queued task"
    );
    assert_eq!(normal_agent_status.as_deref(), Some("Failed"));
    assert!(
        !late_marked,
        "previous marker cancelled the replacement run"
    );
    assert_eq!(snapshot, (Some("Failed".into()), 0, false));
    assert!(restarted > 0);

    let (terminal, await_terminal) = mpsc::channel();
    let (leave_terminal, await_leave_terminal) = mpsc::channel();
    let await_leave_terminal = Mutex::new(await_leave_terminal);
    tasker
        .add_sink(move |message, detail| {
            if message == "Tasker.Task.Succeeded"
                && serde_json::from_str::<serde_json::Value>(detail).unwrap()["entry"]
                    == "AfterCallback"
            {
                terminal.send(()).unwrap();
                await_leave_terminal
                    .lock()
                    .unwrap()
                    .recv_timeout(TIMEOUT)
                    .unwrap();
            }
        })
        .unwrap();
    batch(app, &state, &["AfterCallback", "Queued"], true);
    await_terminal.recv_timeout(TIMEOUT).unwrap();
    let after_terminal_child = attach_child(&state);
    online.store(false, Ordering::SeqCst);
    assert_eq!(tasker.post_stop().unwrap(), 0);
    assert!(tasker.stopping());
    leave_terminal.send(()).unwrap();
    wait_idle(&state);
    let remaining = {
        let instances = state.instances.lock().unwrap();
        let instance = &instances[ID];
        (
            instance.task_run_state.overall_status.clone(),
            instance.agent_children.len(),
            child_is_running(&after_terminal_child),
        )
    };
    eprintln!("After terminal callback: {remaining:?}");
    assert_eq!(remaining, (Some("Failed".into()), 0, false));

    // Both desktop snapshot handlers clear stop_in_progress. Repeated reads
    // must not resurrect the abandoned IDs as Running (HTTP does the same reset).
    for _ in 0..3 {
        assert!(
            !maa_get_instance_state(app.state(), ID.into())
                .unwrap()
                .is_running
        );
        assert!(!maa_get_all_states(app.state()).unwrap().instances[ID].is_running);
    }

    // Simulate an admitted append while the old final callback schedules its
    // completion worker. That worker must also reconcile an abandoned new tail.
    online.store(true, Ordering::SeqCst);
    batch(app, &state, &["Hold"], true);
    await_start.recv_timeout(TIMEOUT).unwrap();
    let completion = state.instances.lock().unwrap()[ID].run_completion.clone();
    let append_permit = completion.acquire_start();
    resume.send(()).unwrap();
    let until = Instant::now() + TIMEOUT;
    while tasker.running() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    // Inject the same native posts/state registration performed after an async
    // Agent-registration await, while retaining its actual submission permit.
    {
        let mut instances = state.instances.lock().unwrap();
        let instance = instances.get_mut(ID).unwrap();
        for entry in ["AfterCallback", "Queued"] {
            let id = tasker.post_task(entry, "{}").unwrap().id;
            assert!(id > 0 && tasker.running());
            instance.task_run_state.pending_task_ids.push(id);
            instance.task_run_state.mappings.insert(id, entry.into());
            instance
                .task_run_state
                .statuses
                .insert(entry.into(), "pending".into());
        }
        instance.task_run_state.overall_status = Some("Running".into());
    }
    let append_child = attach_child(&state);
    drop(append_permit);
    await_terminal.recv_timeout(TIMEOUT).unwrap();
    online.store(false, Ordering::SeqCst);
    assert_eq!(tasker.post_stop().unwrap(), 0);
    leave_terminal.send(()).unwrap();
    wait_idle(&state);
    assert_eq!(
        state.instances.lock().unwrap()[ID]
            .task_run_state
            .overall_status
            .as_deref(),
        Some("Failed")
    );
    assert!(!child_is_running(&append_child));
    eprintln!("Append after terminal callback: existing completion reconciled its missing tail");

    // The next Start can be the first operation to observe an abandoned idle
    // queue; it must reap the old child before accepting its replacement task.
    online.store(true, Ordering::SeqCst);
    let old_child = attach_child(&state);
    {
        let mut instances = state.instances.lock().unwrap();
        let instance = instances.get_mut(ID).unwrap();
        instance.stop_in_progress = false;
        instance.task_run_state.overall_status = Some("Running".into());
        assert!(instance.queue_result().is_none());
    }
    assert!(run_task_impl(app, &state, ID, "Warm", "{}", None).unwrap() > 0);
    assert!(
        !child_is_running(&old_child),
        "Start admitted before old Agent cleanup"
    );
    wait_idle(&state);

    // A retired observer/callback must not mutate a replacement with the same ID.
    batch(app, &state, &["Hold", "Queued"], true);
    await_start.recv_timeout(TIMEOUT).unwrap();
    let (resource, controller, old_completion) = {
        let instances = state.instances.lock().unwrap();
        let instance = &instances[ID];
        (
            instance.resource.clone(),
            instance.controller.clone(),
            instance.run_completion.clone(),
        )
    };
    destroy_instance_impl(&state, ID).unwrap();
    let mut replacement = InstanceRuntime::default();
    replacement.resource = resource;
    replacement.controller = controller;
    state
        .instances
        .lock()
        .unwrap()
        .insert(ID.into(), replacement);
    resume.send(()).unwrap();
    let until = Instant::now() + TIMEOUT;
    while tasker.running() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(old_completion
        .try_acquire_generation(old_completion.generation())
        .is_none());
    assert!(run_task_impl(app, &state, ID, "Warm", "{}", None).unwrap() > 0);
    wait_idle(&state);
    assert_eq!(
        state.instances.lock().unwrap()[ID]
            .task_run_state
            .overall_status
            .as_deref(),
        Some("Succeeded")
    );
    eprintln!("Replacement: old observer retired, same-ID queue succeeded");
}

#[test]
#[ignore = "bounded child process started by native_stop_restart"]
fn controlled_child() {
    std::thread::sleep(Duration::from_secs(15));
}
