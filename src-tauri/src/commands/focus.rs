use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};

#[derive(Clone, serde::Serialize)]
pub struct PendingFocus {
    pub request_id: String,
    pub instance_id: String,
    pub message: String,
    pub details: serde_json::Value,
}

#[derive(Default)]
struct Waiter {
    released: Mutex<bool>,
    changed: Condvar,
}
impl Waiter {
    fn wait(&self) {
        let released = self.released.lock().unwrap_or_else(|e| e.into_inner());
        drop(
            self.changed
                .wait_while(released, |released| !*released)
                .unwrap_or_else(|e| e.into_inner()),
        );
    }
    fn release(&self) {
        *self.released.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.changed.notify_all();
    }
}
struct Gate {
    request: PendingFocus,
    app: tauri::AppHandle,
    waiter: Waiter,
}
#[derive(Default)]
struct FocusState {
    pending: HashMap<String, Arc<Gate>>,
    stopped: HashSet<String>,
    closing: bool,
}
static STATE: LazyLock<Mutex<FocusState>> = LazyLock::new(|| Mutex::new(FocusState::default()));
static SESSION_ID: LazyLock<u128> = LazyLock::new(|| {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
});
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn is_blocking(value: &serde_json::Value, message: &str) -> bool {
    let entry = &value["focus"][message];
    if entry["content"].as_str().is_none_or(str::is_empty) {
        return false;
    }
    let display = &entry["display"];
    display.as_str() == Some("modal")
        || display
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("modal")))
}

pub fn begin_run(instance_id: &str) {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .stopped
        .remove(instance_id);
}

/// Context sink 在 MaaFW 的执行线程同步调用；在回调返回前等待确认，流水线才会真正暂停。
pub fn emit_context(app: &tauri::AppHandle, instance_id: &str, message: &str, details: &str) {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(details) else {
        super::utils::emit_callback_event(app, message, details);
        return;
    };
    let blocking = is_blocking(&value, message);
    if !value.is_object() {
        super::utils::emit_callback_event(app, message, details);
        return;
    }
    value["__mxu_instance_id"] = instance_id.into();
    let gate = if blocking {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing || state.stopped.contains(instance_id) {
            return;
        }
        let id = format!(
            "focus-{}-{}",
            *SESSION_ID,
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        value["__mxu_focus_id"] = id.clone().into();
        let gate = Arc::new(Gate {
            app: app.clone(),
            waiter: Waiter::default(),
            request: PendingFocus {
                request_id: id.clone(),
                instance_id: instance_id.into(),
                message: message.into(),
                details: value.clone(),
            },
        });
        state.pending.insert(id, gate.clone());
        Some(gate)
    } else {
        None
    };
    super::utils::emit_callback_event(app, message, value.to_string().as_str());
    if let Some(gate) = gate {
        gate.waiter.wait();
    }
}

fn finish(gate: &Gate) {
    gate.waiter.release();
    super::utils::emit_state_changed(
        &gate.app,
        &gate.request.instance_id,
        &format!("focus-closed:{}", gate.request.request_id),
    );
}

#[tauri::command]
pub fn acknowledge_focus(request_id: String) -> bool {
    let gate = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pending
        .remove(&request_id);
    if let Some(gate) = gate {
        finish(&gate);
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn pending_focus() -> Vec<PendingFocus> {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut pending: Vec<_> = state
        .pending
        .values()
        .map(|gate| gate.request.clone())
        .collect();
    pending.sort_by_key(|request| {
        request
            .request_id
            .rsplit('-')
            .next()
            .unwrap_or_default()
            .parse::<u64>()
            .unwrap_or(0)
    });
    pending
}

pub fn cancel_instance(instance_id: &str) {
    let gates = {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped.insert(instance_id.to_owned());
        let ids: Vec<_> = state
            .pending
            .iter()
            .filter(|(_, gate)| gate.request.instance_id == instance_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| state.pending.remove(&id))
            .collect::<Vec<_>>()
    };
    for gate in gates {
        finish(&gate);
    }
}

pub fn cancel_all() {
    let gates: Vec<_> = {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.closing = true;
        state.pending.drain().map(|(_, gate)| gate).collect()
    };
    for gate in gates {
        finish(&gate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modal_requires_content_and_accepts_channel_arrays() {
        assert!(is_blocking(
            &serde_json::json!({"focus":{"event":{"content":"Continue?","display":["log","modal"]}}}),
            "event"
        ));
        assert!(!is_blocking(
            &serde_json::json!({"focus":{"event":{"display":"modal","trace":true}}}),
            "event"
        ));
        assert!(!is_blocking(
            &serde_json::json!({"focus":{"event":{"content":"Note","display":"dialog"}}}),
            "event"
        ));
    }
    #[test]
    fn execution_waits_until_acknowledgement_and_early_ack_is_not_lost() {
        let waiter = Arc::new(Waiter::default());
        let other = waiter.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            other.wait();
            sender.send(()).unwrap();
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        waiter.release();
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        thread.join().unwrap();
        waiter.wait();
    }
}
