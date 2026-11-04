//! Coordinate task completion, Agent cleanup and the next submission.

use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct CompletionState {
    starting: bool,
    pending: bool,
    completed: bool,
}

#[derive(Default)]
pub struct RunCompletion {
    state: Mutex<CompletionState>,
    changed: Condvar,
}

/// Own the whole startup operation, including asynchronous Agent registration.
/// The framework callback never waits for this guard; only its cleanup worker does.
pub struct StartPermit(Arc<RunCompletion>);

impl Drop for StartPermit {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.starting = false;
        self.0.changed.notify_all();
    }
}

impl RunCompletion {
    pub fn acquire_start(self: &Arc<Self>) -> StartPermit {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.pending || state.starting {
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.starting = true;
        StartPermit(Arc::clone(self))
    }

    /// Called while holding the instance lock, just before submitting new tasks.
    pub fn reset(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .completed = false;
    }

    /// Schedule at most one cleanup worker for each submitted run.
    pub fn begin(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending || state.completed {
            return false;
        }
        state.pending = true;
        true
    }

    pub fn is_pending(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.pending || state.starting
    }

    pub fn finish_when_idle(
        &self,
        mut is_running: impl FnMut() -> bool,
        cleanup: impl FnOnce(),
        notify: impl FnOnce(),
    ) {
        // A callback can finish while an append operation is registering Agents.
        // Let it submit its tasks before checking idle or taking Agent ownership.
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.starting {
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        drop(state);
        while is_running() {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        cleanup();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.pending = false;
        state.completed = true;
        // Publish completion before releasing a waiting new run. State queries
        // see idle only after Agent cleanup and the final notification are done.
        notify();
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::RunCompletion;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn delayed_framework_idle_and_agent_cleanup_both_keep_the_run_pending() {
        let completion = Arc::new(RunCompletion::default());
        assert!(completion.begin());
        let running = Arc::new(AtomicBool::new(true));
        let worker_running = Arc::clone(&running);
        let finishing = Arc::clone(&completion);
        let (cleanup_started, cleanup_observed) = mpsc::channel();
        let (allow_cleanup, cleanup_allowed) = mpsc::channel();
        let (notified, notification) = mpsc::channel();
        let worker = thread::spawn(move || {
            finishing.finish_when_idle(
                || worker_running.load(Ordering::SeqCst),
                || {
                    cleanup_started.send(()).unwrap();
                    cleanup_allowed.recv().unwrap();
                },
                || notified.send(()).unwrap(),
            );
        });
        let (finished, result) = mpsc::channel();
        let waiting = Arc::clone(&completion);
        let next_run = thread::spawn(move || {
            let _permit = waiting.acquire_start();
            finished.send(()).unwrap();
        });

        // Framework idle can occur after the old frontend's single 300ms query.
        assert!(cleanup_observed
            .recv_timeout(Duration::from_millis(350))
            .is_err());
        assert!(completion.is_pending());
        running.store(false, Ordering::SeqCst);
        cleanup_observed
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(completion.is_pending());
        assert!(notification.try_recv().is_err());
        assert!(result.try_recv().is_err());
        allow_cleanup.send(()).unwrap();
        notification.recv_timeout(Duration::from_secs(1)).unwrap();
        result.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        next_run.join().unwrap();
        assert!(!completion.is_pending());
    }

    #[test]
    fn a_completion_callback_cannot_clean_up_agents_during_startup_or_append() {
        let completion = Arc::new(RunCompletion::default());
        let startup = completion.acquire_start();
        assert!(completion.begin());
        let finishing = Arc::clone(&completion);
        let (events, received) = mpsc::channel();
        let cleanup_events = events.clone();
        let worker = thread::spawn(move || {
            finishing.finish_when_idle(
                || false,
                || cleanup_events.send("cleanup").unwrap(),
                || events.send("completed").unwrap(),
            );
        });
        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        completion.reset();
        drop(startup);
        worker.join().unwrap();
        assert_eq!(
            received.into_iter().collect::<Vec<_>>(),
            ["cleanup", "completed"]
        );
    }

    #[test]
    fn completion_notification_precedes_releasing_the_next_run() {
        let completion = Arc::new(RunCompletion::default());
        assert!(completion.begin());
        let (events, received) = mpsc::channel();
        let waiting = Arc::clone(&completion);
        let next_events = events.clone();
        let next_run = thread::spawn(move || {
            let _permit = waiting.acquire_start();
            next_events.send("start").unwrap();
        });
        completion.finish_when_idle(|| false, || {}, || events.send("completed").unwrap());
        next_run.join().unwrap();
        assert_eq!(
            received.into_iter().take(2).collect::<Vec<_>>(),
            ["completed", "start"]
        );
    }

    #[test]
    fn duplicate_terminal_callbacks_cannot_clean_up_a_completed_run_again() {
        let completion = Arc::new(RunCompletion::default());
        for _ in 0..2 {
            let startup = completion.acquire_start();
            completion.reset();
            drop(startup);
            assert!(completion.begin());
            assert!(!completion.begin());
            completion.finish_when_idle(|| false, || {}, || {});
            assert!(!completion.begin());
            assert!(!completion.is_pending());
        }
    }
}
