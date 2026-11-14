//! Coordinate task completion, Agent cleanup and the next submission.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// None while any framework task is pending; otherwise whether all succeeded.
/// An empty submitted queue is already terminal and has no callback to wait for.
/// UI-selected task IDs are optional and must not affect queue completion.
pub fn task_queue_result(task_ids: &[i64], results: &HashMap<i64, bool>) -> Option<bool> {
    if task_ids.iter().any(|id| !results.contains_key(id)) {
        return None;
    }
    Some(task_ids.iter().all(|id| results[id]))
}

#[derive(Default)]
struct CompletionState {
    generation: u64,
    starting: bool,
    submitting: bool,
    cancelled: bool,
    pending: bool,
    completed: bool,
    observing_idle: bool,
}

#[derive(Default)]
pub struct RunCompletion {
    state: Mutex<CompletionState>,
    changed: Condvar,
    retired: AtomicBool,
}

/// Own the whole startup operation, including asynchronous Agent registration.
/// The framework callback never waits for this guard; only its cleanup worker does.
pub struct StartPermit(Arc<RunCompletion>);

impl Drop for StartPermit {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.starting = false;
        state.submitting = false;
        self.0.changed.notify_all();
    }
}

impl RunCompletion {
    /// Instance IDs can be reused. Its old worker must never publish completion
    /// for the replacement (which would also clear the replacement's run-once tasks).
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }

    pub fn acquire_start(self: &Arc<Self>) -> StartPermit {
        self.acquire(None).expect("unconditional start permit")
    }

    /// A queued stop owns only the run observed when it was requested. If a
    /// submission won the permit first, it must not lose its newly added Agents.
    pub fn acquire_generation(self: &Arc<Self>, generation: u64) -> Option<StartPermit> {
        self.acquire(Some(generation))
    }

    /// An idle observer must never wait for (or cancel) an admitted submission.
    /// This may be called under the instance lock, unlike acquire_generation.
    pub fn try_acquire_generation(self: &Arc<Self>, generation: u64) -> Option<StartPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if generation != state.generation
            || state.starting
            || state.pending
            || state.completed
            || self.retired.load(Ordering::Acquire)
        {
            return None;
        }
        state.starting = true;
        state.submitting = false;
        Some(StartPermit(Arc::clone(self)))
    }

    /// Observe native idle once per queue, independently of its final callback.
    pub fn begin_idle_observer(&self) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.observing_idle || state.pending || state.completed {
            return None;
        }
        state.observing_idle = true;
        Some(state.generation)
    }

    fn acquire(self: &Arc<Self>, generation: Option<u64>) -> Option<StartPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if generation.is_some_and(|generation| generation != state.generation) {
                return None;
            }
            if !state.pending && !state.starting {
                break;
            }
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.starting = true;
        state.submitting = generation.is_none();
        if state.submitting {
            state.cancelled = false;
            state.completed = false;
        }
        Some(StartPermit(Arc::clone(self)))
    }

    /// Cancel an admitted submission even before its first framework task exists.
    /// An explicit Agent cleanup permit is not a submission to cancel.
    pub fn cancel_submission(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.submitting {
            state.cancelled = true;
        }
        state.submitting
    }

    pub fn submission_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancelled
    }

    pub fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .generation
    }

    /// Called under the instance lock and start permit when opening an idle queue,
    /// before any asynchronous Agent registration. Appends keep this generation.
    pub fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.completed = false;
        state.observing_idle = false;
        self.changed.notify_all();
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
        if !self.retired.load(Ordering::Acquire) {
            notify();
        }
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{task_queue_result, RunCompletion};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn idle_observer_cannot_enter_an_active_submission_or_another_generation() {
        let completion = Arc::new(RunCompletion::default());
        let start = completion.acquire_start();
        completion.reset();
        let generation = completion.begin_idle_observer().unwrap();
        assert!(completion.begin_idle_observer().is_none());
        assert!(completion.try_acquire_generation(generation).is_none());
        assert!(!completion.submission_cancelled());
        drop(start);

        let observation = completion.try_acquire_generation(generation).unwrap();
        assert!(!completion.cancel_submission());
        drop(observation);
        let next = completion.acquire_start();
        completion.reset();
        let replacement = completion.begin_idle_observer().unwrap();
        assert_ne!(generation, replacement);
        drop(next);
        assert!(completion.try_acquire_generation(generation).is_none());
        assert!(completion.try_acquire_generation(replacement).is_some());
        completion.retire();
        assert!(completion.try_acquire_generation(replacement).is_none());
    }

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

    #[test]
    fn delayed_agent_stop_cannot_take_a_later_runs_permit() {
        let completion = Arc::new(RunCompletion::default());
        completion.reset();
        let observed_generation = completion.generation();
        assert!(completion.begin());
        let waiting = Arc::clone(&completion);
        let (requested, request_seen) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        let stop = thread::spawn(move || {
            requested.send(()).unwrap();
            // Pause a stop after it snapshots the old run. A new submit can
            // win the non-FIFO permit while this request is descheduled.
            resumed.recv().unwrap();
            waiting.acquire_generation(observed_generation).is_some()
        });
        request_seen.recv().unwrap();
        completion.finish_when_idle(|| false, || {}, || {});
        let next = completion.acquire_start();
        completion.reset();
        assert!(completion.begin());
        drop(next);
        resume.send(()).unwrap();
        assert!(!stop.join().unwrap());
        completion.finish_when_idle(|| false, || {}, || {});
        assert!(completion
            .acquire_generation(completion.generation())
            .is_some());
    }

    #[test]
    fn stop_during_agent_startup_cancels_only_that_submission() {
        let completion = Arc::new(RunCompletion::default());
        let startup = completion.acquire_start();
        assert!(completion.cancel_submission());
        assert!(completion.submission_cancelled());
        assert!(completion.begin());
        let finishing = Arc::clone(&completion);
        let (events, received) = mpsc::channel();
        let worker = thread::spawn(move || {
            finishing.finish_when_idle(|| false, || {}, || events.send("completed").unwrap());
        });
        assert!(received.recv_timeout(Duration::from_millis(50)).is_err());
        drop(startup);
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        let next = completion.acquire_start();
        assert!(!completion.submission_cancelled());
        drop(next);
        // Stopping already idle Agents must not cancel a later task submission.
        let cleanup = completion
            .acquire_generation(completion.generation())
            .unwrap();
        assert!(!completion.cancel_submission());
        drop(cleanup);
    }

    #[test]
    fn a_destroyed_instances_worker_cannot_publish_for_a_reused_id() {
        let completion = Arc::new(RunCompletion::default());
        assert!(completion.begin());
        let events = std::cell::RefCell::new(Vec::new());
        completion.finish_when_idle(
            || false,
            || {
                events.borrow_mut().push("cleanup");
                // Destruction can happen during slow Agent disconnect/reaping.
                completion.retire();
            },
            || events.borrow_mut().push("completed"),
        );
        assert_eq!(*events.borrow(), ["cleanup"]);
        assert!(!completion.is_pending());
        let replacement = Arc::new(RunCompletion::default());
        assert!(replacement.begin());
        replacement.finish_when_idle(
            || false,
            || {},
            || events.borrow_mut().push("new-completed"),
        );
        assert_eq!(*events.borrow(), ["cleanup", "new-completed"]);
    }

    #[test]
    fn framework_terminal_events_finish_queues_without_ui_selected_task_ids() {
        // Single /tasks/run request with selected_task_id omitted.
        let mut results = HashMap::new();
        assert_eq!(task_queue_result(&[41], &results), None);
        results.insert(41, true);
        assert_eq!(task_queue_result(&[41], &results), Some(true));
        results.insert(41, false);
        assert_eq!(task_queue_result(&[41], &results), Some(false));

        // A bulk request can mix mapped and unmapped tasks. Finishing one must
        // not hide a still-pending task just because it has no UI status entry.
        results.clear();
        results.insert(41, true);
        assert_eq!(task_queue_result(&[41, 42], &results), None);
        results.insert(42, false);
        assert_eq!(task_queue_result(&[41, 42], &results), Some(false));
        results.insert(42, true);
        assert_eq!(task_queue_result(&[41, 42], &results), Some(true));
        assert_eq!(task_queue_result(&[], &results), Some(true));
    }
}
