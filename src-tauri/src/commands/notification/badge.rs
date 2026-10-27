use std::collections::HashSet;

#[derive(Default)]
pub(super) struct BadgeState {
    read: HashSet<String>,
}

pub(super) enum ReadAction {
    None,
    All,
    One(String),
}

impl BadgeState {
    pub(super) fn synchronize(&mut self, delivered: Vec<String>, action: ReadAction) -> usize {
        let delivered: HashSet<_> = delivered.into_iter().collect();
        match action {
            ReadAction::None => {}
            ReadAction::All => self.read.extend(delivered.iter().cloned()),
            ReadAction::One(id) => {
                self.read.insert(id);
            }
        }
        self.read.retain(|id| delivered.contains(id));
        delivered.difference(&self.read).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn clearing_notifications_reduces_and_then_clears_the_badge() {
        let mut state = BadgeState::default();
        assert_eq!(state.synchronize(ids(&["a", "b"]), ReadAction::None), 2);
        assert_eq!(state.synchronize(ids(&["b"]), ReadAction::None), 1);
        assert_eq!(state.synchronize(ids(&[]), ReadAction::None), 0);
    }

    #[test]
    fn returning_to_app_marks_existing_notifications_read_without_rebadging_them() {
        let mut state = BadgeState::default();
        assert_eq!(state.synchronize(ids(&["a", "b"]), ReadAction::All), 0);
        assert_eq!(state.synchronize(ids(&["a", "b"]), ReadAction::None), 0);
        assert_eq!(
            state.synchronize(ids(&["a", "b", "c"]), ReadAction::None),
            1
        );
    }

    #[test]
    fn clicking_one_notification_does_not_clear_other_unread_notifications() {
        let mut state = BadgeState::default();
        assert_eq!(
            state.synchronize(ids(&["a", "b"]), ReadAction::One("a".into())),
            1
        );
        assert_eq!(state.synchronize(ids(&["a", "b"]), ReadAction::None), 1);
        assert_eq!(state.synchronize(ids(&["b"]), ReadAction::None), 1);
    }

    #[test]
    fn removed_notifications_do_not_leave_read_state_for_reused_identifiers() {
        let mut state = BadgeState::default();
        state.synchronize(ids(&["a"]), ReadAction::All);
        state.synchronize(ids(&[]), ReadAction::None);
        assert_eq!(state.synchronize(ids(&["a", "a"]), ReadAction::None), 1);
    }
}
