//! Per-task execution times. These are runtime data, never project configuration.

use serde::{Deserialize, Serialize};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTiming {
    /// Unix timestamps in milliseconds, for display in each client's local time.
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub duration_ms: Option<u64>,
    /// Duration must not depend on wall-clock changes while a task runs.
    #[serde(skip)]
    started_instant: Option<Instant>,
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl TaskTiming {
    pub fn start() -> Self {
        Self::start_at(timestamp_ms(), Instant::now())
    }

    fn start_at(timestamp: u64, instant: Instant) -> Self {
        Self {
            started_at: timestamp,
            finished_at: None,
            duration_ms: None,
            started_instant: Some(instant),
        }
    }

    pub fn finish(&mut self) {
        self.finish_at(timestamp_ms(), Instant::now());
    }

    fn finish_at(&mut self, timestamp: u64, instant: Instant) {
        // Stop freezes the time; a later success/failure callback must not extend it.
        if self.finished_at.is_some() {
            return;
        }
        self.finished_at = Some(timestamp);
        self.duration_ms = Some(
            self.started_instant
                .map(|start| instant.saturating_duration_since(start).as_millis() as u64)
                .unwrap_or_else(|| timestamp.saturating_sub(self.started_at)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn finishing_uses_monotonic_time_even_when_wall_clock_moves_back() {
        let start = Instant::now();
        let mut timing = TaskTiming::start_at(10_000, start);
        timing.finish_at(9_000, start + Duration::from_millis(2_345));
        assert_eq!(timing.started_at, 10_000);
        assert_eq!(timing.finished_at, Some(9_000));
        assert_eq!(timing.duration_ms, Some(2_345));
    }

    #[test]
    fn late_callback_cannot_extend_a_stopped_task() {
        let start = Instant::now();
        let mut timing = TaskTiming::start_at(1_000, start);
        timing.finish_at(1_500, start + Duration::from_millis(500));
        timing.finish_at(3_000, start + Duration::from_secs(2));
        assert_eq!(timing.finished_at, Some(1_500));
        assert_eq!(timing.duration_ms, Some(500));
    }

    #[test]
    fn snapshots_include_display_times_but_not_the_process_clock() {
        let start = Instant::now();
        let mut timing = TaskTiming::start_at(1_000, start);
        assert_eq!(
            serde_json::to_value(&timing).unwrap(),
            serde_json::json!({"started_at": 1000, "finished_at": null, "duration_ms": null})
        );
        timing.finish_at(2_500, start + Duration::from_millis(1_500));
        let snapshot: TaskTiming =
            serde_json::from_value(serde_json::to_value(&timing).unwrap()).unwrap();
        assert_eq!(snapshot.finished_at, Some(2_500));
        assert_eq!(snapshot.duration_ms, Some(1_500));
        assert!(snapshot.started_instant.is_none());
    }
}
