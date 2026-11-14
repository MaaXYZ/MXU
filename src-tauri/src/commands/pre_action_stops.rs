use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::watch;

/// A Stop belongs to the processes already waiting on this instance. Reset opens
/// the next run without clearing cancellation on their existing receivers.
#[derive(Default)]
pub struct PreActionStops(Mutex<HashMap<String, watch::Sender<bool>>>);

impl PreActionStops {
    pub fn subscribe(&self, instance_id: &str) -> watch::Receiver<bool> {
        let mut requests = self.0.lock().unwrap_or_else(|e| e.into_inner());
        requests.retain(|_, tx| tx.receiver_count() > 0 || *tx.borrow());
        requests
            .entry(instance_id.to_owned())
            .or_insert_with(|| watch::Sender::new(false))
            .subscribe()
    }

    pub fn set(&self, instance_id: String, stop: bool) {
        let mut requests = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if stop {
            requests
                .entry(instance_id)
                .or_insert_with(|| watch::Sender::new(false))
                .send_replace(true);
        } else if requests
            .get(&instance_id)
            .is_some_and(|tx| *tx.borrow() || tx.receiver_count() == 0)
        {
            requests.remove(&instance_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PreActionStops;

    #[test]
    fn reset_does_not_clear_stop_for_an_older_waiter() {
        let requests = PreActionStops::default();
        let first = requests.subscribe("A");
        let other = requests.subscribe("B");
        requests.set("A".into(), true);
        let already_stopped = requests.subscribe("A");
        requests.set("A".into(), false);
        let next = requests.subscribe("A");
        assert!(*first.borrow());
        assert!(*already_stopped.borrow());
        assert!(!*next.borrow());
        assert!(!*other.borrow());
    }

    #[test]
    fn repeated_reset_does_not_detach_an_active_waiter() {
        let requests = PreActionStops::default();
        let waiter = requests.subscribe("A");
        requests.set("A".into(), false);
        requests.set("A".into(), true);
        assert!(*waiter.borrow());
    }
}
