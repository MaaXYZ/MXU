//! Cross-window admission. The frontend lease alone cannot serialize a WebUI start.
use crate::commands::{
    types::{InstanceRuntime, MaaState},
    utils::emit_state_changed,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::State;

#[derive(Default)]
struct Slots(HashMap<String, Slot>);
struct Slot {
    token: String,
    mcp: bool,
    cancelled: bool,
}
static SLOTS: OnceLock<Mutex<Slots>> = OnceLock::new();
fn slots() -> &'static Mutex<Slots> {
    SLOTS.get_or_init(Mutex::default)
}

impl Slots {
    fn acquire(&mut self, id: &str, token: &str, mcp: bool) -> Result<(), String> {
        if let Some(slot) = self.0.get(id) {
            return if slot.token == token && !slot.cancelled {
                Ok(())
            } else {
                Err("instance_busy".into())
            };
        }
        self.0.insert(
            id.into(),
            Slot {
                token: token.into(),
                mcp,
                cancelled: false,
            },
        );
        Ok(())
    }
    fn release(&mut self, id: &str, token: &str) -> Result<(), String> {
        if self.0.get(id).is_some_and(|slot| slot.token != token) {
            return Ok(());
        }
        self.0.remove(id);
        Ok(())
    }
}

pub fn reserved_ids() -> HashSet<String> {
    slots()
        .lock()
        .map(|slots| slots.0.keys().cloned().collect())
        .unwrap_or_default()
}
pub fn mcp_reserved(id: &str) -> bool {
    slots()
        .lock()
        .map(|slots| slots.0.get(id).is_some_and(|slot| slot.mcp))
        .unwrap_or(true)
}
pub fn cancel(id: &str) {
    if let Ok(mut slots) = slots().lock() {
        if let Some(slot) = slots.0.get_mut(id) {
            slot.cancelled = true;
        }
    }
}
pub fn validate_start(id: &str, token: Option<&str>) -> Result<(), String> {
    let slots = slots().lock().map_err(|_| "instance_busy")?;
    if let Some(slot) = slots.0.get(id) {
        if slot.cancelled {
            return Err("MXU_PRE_ACTION_CANCELLED".into());
        }
        if slot.mcp && token != Some(slot.token.as_str()) {
            return Err("instance_busy".into());
        }
    }
    Ok(())
}
pub fn acquire(
    app: &tauri::AppHandle,
    state: &Arc<MaaState>,
    id: &str,
    token: &str,
    mcp: bool,
) -> Result<(), String> {
    if id.is_empty() || token.is_empty() {
        return Err("instance_busy".into());
    }
    {
        let mut slots = slots().lock().map_err(|_| "instance_busy")?;
        let mut instances = state.instances.lock().map_err(|_| "instance_busy")?;
        let instance = instances
            .entry(id.into())
            .or_insert_with(InstanceRuntime::default);
        if !slots.0.get(id).is_some_and(|slot| slot.token == token) && instance.is_running() {
            return Err("instance_busy".into());
        }
        slots.acquire(id, token, mcp)?;
    }
    emit_state_changed(app, id, "execution-starting");
    Ok(())
}
pub fn release(app: &tauri::AppHandle, id: &str, token: &str) -> Result<(), String> {
    slots()
        .lock()
        .map_err(|_| "instance_busy")?
        .release(id, token)?;
    emit_state_changed(app, id, "execution-settled");
    Ok(())
}
#[derive(Serialize)]
pub struct ExecutionStatus {
    pub busy: bool,
    pub cancelled: bool,
}
pub fn status(id: &str, token: &str) -> ExecutionStatus {
    match slots().lock() {
        Ok(slots) => {
            let slot = slots.0.get(id);
            ExecutionStatus {
                busy: slot.is_some(),
                cancelled: slot.is_none_or(|slot| slot.token != token || slot.cancelled),
            }
        }
        Err(_) => ExecutionStatus {
            busy: true,
            cancelled: true,
        },
    }
}

#[tauri::command]
pub fn execution_acquire(
    app: tauri::AppHandle,
    state: State<'_, Arc<MaaState>>,
    instance_id: String,
    token: String,
    mcp: bool,
) -> Result<(), String> {
    acquire(&app, &state, &instance_id, &token, mcp)
}
#[tauri::command]
pub fn execution_release(
    app: tauri::AppHandle,
    instance_id: String,
    token: String,
) -> Result<(), String> {
    release(&app, &instance_id, &token)
}
#[tauri::command]
pub fn execution_status(instance_id: String, token: String) -> ExecutionStatus {
    status(&instance_id, &token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_clients_share_one_slot_and_old_owners_cannot_release_new_runs() {
        let mut slots = Slots::default();
        slots.acquire("a", "desktop", true).unwrap();
        assert!(slots.acquire("a", "web", false).is_err());
        slots.acquire("b", "web", false).unwrap();
        slots.release("a", "desktop").unwrap();
        slots.acquire("a", "later", true).unwrap();
        slots.release("a", "desktop").unwrap();
        assert_eq!(slots.0["a"].token, "later");
        assert_eq!(slots.0["b"].token, "web");
    }
}
