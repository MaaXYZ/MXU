use std::collections::HashSet;

// Keep callback membership separate from the task history returned to clients.
#[derive(Default)]
pub struct TaskCompletion {
    pending: HashSet<i64>,
    failed: bool,
}

impl TaskCompletion {
    pub fn add(&mut self, id: i64) {
        if self.pending.is_empty() {
            self.failed = false;
        }
        self.pending.insert(id);
    }

    pub fn contains(&self, id: i64) -> bool {
        self.pending.contains(&id)
    }

    pub fn complete(&mut self, id: i64, succeeded: bool) -> bool {
        if !self.pending.remove(&id) {
            return false;
        }
        self.failed |= !succeeded;
        self.pending.is_empty()
    }

    pub fn failed(&self) -> bool {
        self.failed
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn cancel(&mut self) {
        self.pending.clear();
        self.failed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_and_duplicate_callbacks_cannot_complete_a_new_run() {
        let mut run = TaskCompletion::default();
        run.add(1);
        assert!(run.complete(1, true));
        run.add(2);
        assert!(!run.complete(1, false));
        assert!(!run.failed());
        assert!(run.contains(2));
        assert!(run.complete(2, true));
        assert!(!run.complete(2, true));
    }

    #[test]
    fn tracks_every_task_without_requiring_frontend_ids() {
        let mut run = TaskCompletion::default();
        run.add(10);
        run.add(11);
        assert!(!run.complete(10, false));
        run.add(12);
        assert!(!run.complete(11, true));
        assert!(run.complete(12, true));
        assert!(run.failed());
    }

    #[test]
    fn cancel_invalidates_queued_callbacks_and_next_run_resets_failure() {
        let mut run = TaskCompletion::default();
        run.add(1);
        run.add(2);
        run.cancel();
        assert!(!run.complete(1, true));
        run.add(3);
        assert!(!run.complete(2, false));
        assert!(run.complete(3, true));
        assert!(!run.failed());
    }
}
