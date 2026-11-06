//! Callback lifetimes and per-configuration connection creation gates.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

/// Each instance/connection attempt gets its own identity, even when an ID is reused.
#[derive(Clone)]
pub struct CallbackGuard(Arc<AtomicBool>);

impl Default for CallbackGuard {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
}

impl CallbackGuard {
    pub fn cancel(&self) {
        self.0.store(false, Ordering::Release);
    }

    pub fn is_active(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn is_current(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) && self.is_active()
    }
}

/// Serialize pool lookup through publication for a configuration without blocking
/// unrelated devices. Weak entries do not retain old configurations indefinitely.
pub struct ConnectionGates<K>(Mutex<HashMap<K, Weak<Mutex<()>>>>);

impl<K> Default for ConnectionGates<K> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

impl<K: Clone + Eq + Hash> ConnectionGates<K> {
    pub fn for_config(&self, config: &K) -> Result<Arc<Mutex<()>>, String> {
        let mut gates = self.0.lock().map_err(|e| e.to_string())?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(config).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(config.clone(), Arc::downgrade(&gate));
        Ok(gate)
    }
}

#[cfg(test)]
mod tests {
    use super::{CallbackGuard, ConnectionGates};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn cancelled_snapshot_cannot_emit_after_same_id_recreation() {
        let old_instance = CallbackGuard::default();
        let queued_callback = old_instance.clone();
        old_instance.cancel();
        let replacement = CallbackGuard::default();
        assert!(!queued_callback.is_active());
        assert!(!replacement.is_current(&queued_callback));
        assert!(replacement.is_active());
    }

    #[test]
    fn replaced_connection_attempt_cannot_publish_into_current_instance() {
        let first = CallbackGuard::default();
        let pending = first.clone();
        first.cancel();
        let latest = CallbackGuard::default();
        assert!(!latest.is_current(&pending));
        assert!(latest.is_current(&latest.clone()));
    }

    #[test]
    fn simultaneous_pool_misses_create_only_one_entry_per_config() {
        let gates = Arc::new(ConnectionGates::default());
        let pool = Arc::new(Mutex::new(None));
        let created = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let gates = gates.clone();
            let pool = pool.clone();
            let start = start.clone();
            let created = created.clone();
            handles.push(std::thread::spawn(move || {
                let gate = gates.for_config(&"same-device").unwrap();
                start.wait();
                let _connection = gate.lock().unwrap();
                // Lookup and publication are intentionally separate, as in connect_controller_impl.
                let existing = *pool.lock().unwrap();
                if let Some(entry) = existing {
                    entry
                } else {
                    let entry = created.fetch_add(1, Ordering::SeqCst) + 1;
                    std::thread::yield_now();
                    *pool.lock().unwrap() = Some(entry);
                    entry
                }
            }));
        }
        start.wait();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), 1);
        }
        assert_eq!(created.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(
            &gates.for_config(&"another-device").unwrap(),
            &gates.for_config(&"another-device").unwrap()
        ));
    }
}
