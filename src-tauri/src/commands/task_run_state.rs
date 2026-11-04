//! Lifecycle bookkeeping keyed by Maa execution, with a latest-execution view for the UI.

use super::task_timing::{TaskTimestamp, TaskTiming};
use super::types::TaskRunState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TaskEvent {
    Starting,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone)]
pub(super) struct TaskExecution {
    status: &'static str,
    timing: Option<TaskTiming>,
    stopped_at: Option<TaskTimestamp>,
}

impl TaskRunState {
    pub(super) fn register_task(&mut self, task_id: i64, selected_id: Option<&str>) {
        self.pending_task_ids.push(task_id);
        self.executions.insert(
            task_id,
            TaskExecution {
                status: "pending",
                timing: None,
                stopped_at: None,
            },
        );
        if let Some(selected_id) = selected_id {
            self.mappings.insert(task_id, selected_id.to_string());
            // Appending the same UI task must not erase its current execution's time.
            if self.statuses.get(selected_id).map(String::as_str) != Some("running") {
                self.statuses
                    .insert(selected_id.to_string(), "pending".to_string());
            }
        }
        self.overall_status = Some("Running".to_string());
    }

    pub(super) fn apply_task_event(
        &mut self,
        task_id: i64,
        event: TaskEvent,
        observed: TaskTimestamp,
    ) -> Option<bool> {
        let index = self.pending_task_ids.iter().position(|&id| id == task_id)?;
        let execution = self.executions.get_mut(&task_id)?;

        if event == TaskEvent::Starting {
            if execution.timing.is_some()
                || (execution.status != "pending" && execution.stopped_at.is_none())
            {
                return None;
            }
            execution.timing = Some(TaskTiming::from_callback(observed, execution.stopped_at));
            // A real, delayed Starting gets a frozen timing without reviving a stopped task.
            if execution.stopped_at.is_none() {
                execution.status = "running";
                self.current_task_index = self.current_task_index.max(index);
            }
        } else {
            if execution.status != "pending" && execution.status != "running" {
                return None;
            }
            if let Some(timing) = execution.timing.as_mut() {
                timing.finish_at_timestamp(observed);
            }
            execution.status = if event == TaskEvent::Succeeded {
                "succeeded"
            } else {
                "failed"
            };
        }

        if let Some(selected_id) = self.mappings.get(&task_id) {
            let displayed_index = self
                .displayed_executions
                .get(selected_id)
                .and_then(|displayed| self.pending_task_ids.iter().position(|id| id == displayed));
            // A late callback for an older execution cannot overwrite a newer execution.
            if displayed_index.is_none_or(|displayed| index >= displayed) {
                self.displayed_executions
                    .insert(selected_id.clone(), task_id);
                self.statuses
                    .insert(selected_id.clone(), execution.status.to_string());
                if let Some(timing) = &execution.timing {
                    self.timings.insert(selected_id.clone(), timing.clone());
                } else {
                    self.timings.remove(selected_id);
                }
            }
        }

        let all_done = self.overall_status.as_deref() == Some("Running")
            && self
                .executions
                .values()
                .all(|execution| matches!(execution.status, "succeeded" | "failed"));
        if all_done {
            self.overall_status = Some(
                if self
                    .executions
                    .values()
                    .any(|execution| execution.status == "failed")
                {
                    "Failed"
                } else {
                    "Succeeded"
                }
                .to_string(),
            );
        }
        Some(all_done)
    }

    pub(super) fn stop_tasks(
        &mut self,
        request_stop: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        request_stop()?;
        self.stop_at(TaskTimestamp::now());
        Ok(())
    }

    fn stop_at(&mut self, stopped_at: TaskTimestamp) {
        for execution in self.executions.values_mut() {
            if execution.status == "pending" || execution.status == "running" {
                execution.status = "failed";
                execution.stopped_at = Some(stopped_at);
                if let Some(timing) = execution.timing.as_mut() {
                    timing.finish_at_timestamp(stopped_at);
                }
            }
        }
        for timing in self.timings.values_mut() {
            timing.finish_at_timestamp(stopped_at);
        }
        for status in self.statuses.values_mut() {
            if status == "pending" || status == "running" {
                *status = "failed".to_string();
            }
        }
        self.overall_status = Some("Failed".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn observed(base: Instant, ms: u64) -> TaskTimestamp {
        TaskTimestamp::at(10_000 + ms, base + Duration::from_millis(ms))
    }

    #[test]
    fn rejected_stop_does_not_freeze_an_execution() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(1, Some("task"));
        state.apply_task_event(1, TaskEvent::Starting, observed(base, 0));
        assert!(state.stop_tasks(|| Err("stop rejected".into())).is_err());
        assert_eq!(state.statuses["task"], "running");
        assert_eq!(state.overall_status.as_deref(), Some("Running"));
        assert_eq!(state.timings["task"].finished_at, None);
        assert_eq!(
            state.apply_task_event(1, TaskEvent::Succeeded, observed(base, 1_500)),
            Some(true)
        );
        assert_eq!(state.timings["task"].duration_ms, Some(1_500));
    }

    #[test]
    fn accepted_stop_freezes_running_tasks_and_late_starts_without_reviving_them() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(1, Some("running"));
        state.register_task(2, Some("delayed"));
        state.register_task(3, Some("queued"));
        state.apply_task_event(1, TaskEvent::Starting, observed(base, 0));
        state.stop_at(observed(base, 500));
        assert_eq!(state.timings["running"].duration_ms, Some(500));
        assert!(!state.timings.contains_key("queued"));
        // The event arrived before stop but waited for the same state lock.
        state.apply_task_event(2, TaskEvent::Starting, observed(base, 200));
        assert_eq!(state.timings["delayed"].duration_ms, Some(300));
        assert_eq!(state.timings["delayed"].finished_at, Some(10_500));
        assert_eq!(state.statuses["delayed"], "failed");
        assert_eq!(state.overall_status.as_deref(), Some("Failed"));
        assert_eq!(
            state.apply_task_event(2, TaskEvent::Succeeded, observed(base, 2_000)),
            None
        );
        assert_eq!(state.timings["delayed"].duration_ms, Some(300));
        assert_eq!(state.statuses["delayed"], "failed");
    }

    #[test]
    fn a_start_delivered_after_stop_has_a_frozen_zero_time_instead_of_restarting() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(1, Some("task"));
        state.stop_at(observed(base, 500));
        state.apply_task_event(1, TaskEvent::Starting, observed(base, 700));
        assert_eq!(state.statuses["task"], "failed");
        assert_eq!(state.timings["task"].started_at, 10_500);
        assert_eq!(state.timings["task"].finished_at, Some(10_500));
        assert_eq!(state.timings["task"].duration_ms, Some(0));
    }

    #[test]
    fn requeued_ui_task_has_independent_execution_times_and_completion() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(1, Some("task"));
        state.apply_task_event(1, TaskEvent::Starting, observed(base, 0));
        state.register_task(2, Some("task"));
        assert_eq!(state.statuses["task"], "running");
        assert_eq!(state.timings["task"].started_at, 10_000);
        assert_eq!(
            state.apply_task_event(1, TaskEvent::Succeeded, observed(base, 500)),
            Some(false)
        );
        assert_eq!(state.overall_status.as_deref(), Some("Running"));
        state.apply_task_event(2, TaskEvent::Starting, observed(base, 800));
        assert_eq!(state.timings["task"].started_at, 10_800);
        assert_eq!(state.timings["task"].finished_at, None);
        assert_eq!(
            state.apply_task_event(2, TaskEvent::Failed, observed(base, 1_800)),
            Some(true)
        );
        assert_eq!(state.timings["task"].duration_ms, Some(1_000));
        assert_eq!(
            state.executions[&1].timing.as_ref().unwrap().duration_ms,
            Some(500)
        );
        assert_eq!(state.overall_status.as_deref(), Some("Failed"));
    }

    #[test]
    fn older_execution_callbacks_cannot_finish_or_replace_a_newer_displayed_timing() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(1, Some("task"));
        state.register_task(2, Some("task"));
        state.apply_task_event(2, TaskEvent::Starting, observed(base, 500));
        state.apply_task_event(1, TaskEvent::Starting, observed(base, 0));
        state.apply_task_event(1, TaskEvent::Succeeded, observed(base, 700));
        assert_eq!(state.statuses["task"], "running");
        assert_eq!(state.timings["task"].started_at, 10_500);
        assert_eq!(state.timings["task"].finished_at, None);
        state.apply_task_event(2, TaskEvent::Succeeded, observed(base, 1_000));
        assert_eq!(state.timings["task"].duration_ms, Some(500));
    }

    #[test]
    fn old_run_callbacks_are_ignored_and_unmapped_executions_still_count_for_completion() {
        let base = Instant::now();
        let mut state = TaskRunState::default();
        state.register_task(2, Some("task"));
        state.register_task(3, None);
        assert_eq!(
            state.apply_task_event(1, TaskEvent::Starting, observed(base, 0)),
            None
        );
        state.apply_task_event(2, TaskEvent::Starting, observed(base, 100));
        assert_eq!(
            state.apply_task_event(2, TaskEvent::Succeeded, observed(base, 500)),
            Some(false)
        );
        assert_eq!(
            state.apply_task_event(3, TaskEvent::Succeeded, observed(base, 600)),
            Some(true)
        );
        let snapshot = serde_json::to_value(&state).unwrap();
        assert!(snapshot.get("executions").is_none());
        assert!(snapshot.get("displayed_executions").is_none());
        assert_eq!(snapshot["timings"]["task"]["duration_ms"], 400);
    }
}
