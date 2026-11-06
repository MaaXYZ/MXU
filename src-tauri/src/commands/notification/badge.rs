use std::collections::HashSet;

#[derive(Default)]
pub(super) struct BadgeState {
    read: HashSet<String>,
}

pub(super) enum ReadAction {
    None,
    Through(f64),
    One(String),
}

pub(super) struct DeliveredNotification {
    pub id: String,
    pub delivered_at: f64,
}

impl BadgeState {
    pub(super) fn synchronize(
        &mut self,
        delivered: Vec<DeliveredNotification>,
        action: ReadAction,
    ) -> usize {
        match action {
            ReadAction::None => {}
            // 截止时间在焦点事件入队时捕获，不能把排队期间新送达的通知标为已读。
            ReadAction::Through(cutoff) => self.read.extend(
                delivered
                    .iter()
                    .filter(|notification| notification.delivered_at <= cutoff)
                    .map(|notification| notification.id.clone()),
            ),
            ReadAction::One(id) => {
                self.read.insert(id);
            }
        }
        let delivered: HashSet<_> = delivered
            .into_iter()
            .map(|notification| notification.id)
            .collect();
        self.read.retain(|id| delivered.contains(id));
        delivered.difference(&self.read).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<DeliveredNotification> {
        values
            .iter()
            .map(|value| DeliveredNotification {
                id: value.to_string(),
                delivered_at: 1.0,
            })
            .collect()
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
        assert_eq!(
            state.synchronize(ids(&["a", "b"]), ReadAction::Through(1.0)),
            0
        );
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
        state.synchronize(ids(&["a"]), ReadAction::Through(1.0));
        state.synchronize(ids(&[]), ReadAction::None);
        assert_eq!(state.synchronize(ids(&["a", "a"]), ReadAction::None), 1);
    }

    #[test]
    fn focus_does_not_read_notifications_delivered_while_the_command_is_queued() {
        let mut state = BadgeState::default();
        let notifications = || {
            vec![
                DeliveredNotification {
                    id: "old".into(),
                    delivered_at: 1.0,
                },
                DeliveredNotification {
                    id: "new".into(),
                    delivered_at: 3.0,
                },
            ]
        };
        assert_eq!(
            state.synchronize(notifications(), ReadAction::Through(2.0)),
            1
        );
        assert_eq!(state.synchronize(notifications(), ReadAction::None), 1);
        assert_eq!(
            state.synchronize(notifications(), ReadAction::Through(4.0)),
            0
        );
    }
}
