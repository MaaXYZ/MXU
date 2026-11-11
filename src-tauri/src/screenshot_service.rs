//! 后端统一截图服务
//!
//! 确保每个实例同一时刻只有一份 `post_screencap` 在执行。
//! 前端（Tauri App 和 Web UI）通过订阅/退订接口指定期望帧率，
//! 后端按所有订阅者中最快的速度驱动截图循环。
//!
//! # 设计
//!
//! - 每个实例维护一个 `InstanceScreenshotStream`，其中包含订阅者 Map 和截图循环运行标志。
//! - `subscribe` 确保截图循环仅被启动一次（CAS 原子操作）。
//! - 截图循环每次迭代清理超时（30s 无活动）的订阅者，按最小间隔驱动 `post_screencap`。
//! - 任务运行中跳过 `post_screencap`（任务管线已自动更新缓存）。

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use crate::commands::types::MaaState;

/// 订阅者超时时长：超过此时间无任何活动的订阅者将被自动清理。
const SUBSCRIBER_TIMEOUT_SECS: u64 = 30;
/// 截图最小间隔（ms），防止后端被过度请求。
const MIN_INTERVAL_MS: u64 = 100;

// ============================================================================
// 数据结构
// ============================================================================

struct ScreenshotSubscriber {
    interval_ms: u64,
    last_active: Instant,
}

struct InstanceScreenshotStream {
    subscribers: Mutex<HashMap<String, ScreenshotSubscriber>>,
    capture_running: AtomicBool,
}

/// 后端统一截图服务，挂载于 `MaaState` 中，全局单例。
#[derive(Default)]
pub struct ScreenshotService {
    streams: Mutex<HashMap<String, Arc<InstanceScreenshotStream>>>,
}

// ============================================================================
// 公开接口
// ============================================================================

impl ScreenshotService {
    /// 注册截图订阅者。
    ///
    /// 若该实例的截图循环尚未启动，则自动以最小订阅间隔驱动启动。
    /// 若 `subscriber_id` 已存在，则更新其 `interval_ms`（帧率变更时复用）。
    /// `handle` 是调用方提供的 tokio runtime handle，用于 spawn 截图循环。
    /// 调用方（async Tauri 命令或 axum handler）均运行在 tokio 上下文中，可通过
    /// `tokio::runtime::Handle::current()` 获取。
    pub fn subscribe(
        &self,
        maa_state: Arc<MaaState>,
        instance_id: String,
        subscriber_id: String,
        interval_ms: u64,
        handle: tokio::runtime::Handle,
    ) -> Result<(), String> {
        // Serialize registration with destroy/recreate of the same instance ID.
        let instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
        if !instances.contains_key(&instance_id) {
            return Err("Instance not found".into());
        }
        let stream = {
            let mut streams = self.streams.lock().unwrap();
            streams
                .entry(instance_id.clone())
                .or_insert_with(|| {
                    Arc::new(InstanceScreenshotStream {
                        subscribers: Mutex::new(HashMap::new()),
                        capture_running: AtomicBool::new(false),
                    })
                })
                .clone()
        };

        {
            let mut subs = stream.subscribers.lock().unwrap();
            subs.insert(
                subscriber_id,
                ScreenshotSubscriber {
                    interval_ms: interval_ms.max(MIN_INTERVAL_MS),
                    last_active: Instant::now(),
                },
            );
        }

        drop(instances);
        // CAS 保证只有一个 tokio task 负责该实例的截图循环
        if stream
            .capture_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            handle.spawn(capture_loop(stream, maa_state, instance_id));
        }
        Ok(())
    }

    /// Called while holding the instances lock, before a replacement can subscribe.
    pub fn remove_instance(&self, instance_id: &str) {
        if let Some(stream) = self.streams.lock().unwrap().remove(instance_id) {
            stream.subscribers.lock().unwrap().clear();
        }
    }

    /// 取消订阅。截图循环将在下次迭代检测到无订阅者时自动退出。
    pub fn unsubscribe(&self, instance_id: &str, subscriber_id: &str) {
        let streams = self.streams.lock().unwrap();
        if let Some(stream) = streams.get(instance_id) {
            stream.subscribers.lock().unwrap().remove(subscriber_id);
        }
    }

    /// 刷新订阅者的活跃时间戳，防止被 30s 超时清理。
    ///
    /// Web UI 可在每次 GET /screenshot 时调用，也可不调用（依赖显式 unsubscribe）。
    pub fn touch(&self, instance_id: &str, subscriber_id: &str) {
        let streams = self.streams.lock().unwrap();
        if let Some(stream) = streams.get(instance_id) {
            let mut subs = stream.subscribers.lock().unwrap();
            if let Some(sub) = subs.get_mut(subscriber_id) {
                sub.last_active = Instant::now();
            }
        }
    }
}

// ============================================================================
// 截图循环（每实例至多一个 tokio task）
// ============================================================================

async fn capture_loop(
    stream: Arc<InstanceScreenshotStream>,
    maa_state: Arc<MaaState>,
    instance_id: String,
) {
    log::debug!("[screenshot] capture_loop started: {}", instance_id);

    loop {
        let interval = {
            // Coordinate the frame with destroy/recreate before checking this stream.
            let instances = maa_state.instances.lock().ok();
            let mut subs = stream.subscribers.lock().unwrap();
            subs.retain(|_, sub| sub.last_active.elapsed().as_secs() < SUBSCRIBER_TIMEOUT_SECS);
            let Some(interval) = subs.values().map(|s| s.interval_ms).min() else {
                // A concurrent subscriber sees either a live loop or this idle flag.
                stream.capture_running.store(false, Ordering::SeqCst);
                break;
            };
            drop(subs);

            if let Some(inst) = instances.as_ref().and_then(|map| map.get(&instance_id)) {
                // While running, the pipeline updates the cached frame itself.
                if !inst.tasker.as_ref().is_some_and(|t| t.running()) {
                    if let Some(ctrl) = inst.controller.as_ref().filter(|ctrl| ctrl.connected()) {
                        let _ = ctrl.post_screencap();
                    }
                }
            }
            interval
        };
        // A temporarily missing controller waits for the next frame, like a connected one.
        tokio::time::sleep(tokio::time::Duration::from_millis(interval)).await;
    }

    log::debug!("[screenshot] capture_loop ended: {}", instance_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{maa_core::destroy_instance_impl, types::InstanceRuntime};
    use std::{future::Future, task::Poll, time::Duration};

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    fn state_with_instance() -> Arc<MaaState> {
        let state = Arc::new(MaaState::default());
        state
            .instances
            .lock()
            .unwrap()
            .insert("fixture".into(), InstanceRuntime::default());
        state
    }

    fn stream(last_active: Instant) -> Arc<InstanceScreenshotStream> {
        Arc::new(InstanceScreenshotStream {
            subscribers: Mutex::new(HashMap::from([(
                "view".into(),
                ScreenshotSubscriber {
                    interval_ms: MIN_INTERVAL_MS,
                    last_active,
                },
            )])),
            capture_running: AtomicBool::new(true),
        })
    }

    #[test]
    fn missing_instance_cannot_leave_a_capture_stream() {
        let runtime = runtime();
        let state = Arc::new(MaaState::default());
        let result = state.screenshot_service.subscribe(
            state.clone(),
            "missing".into(),
            "view".into(),
            100,
            runtime.handle().clone(),
        );
        assert!(result.is_err());
        assert!(state.screenshot_service.streams.lock().unwrap().is_empty());
    }

    #[test]
    fn absent_controller_waits_in_the_same_capture_loop() {
        runtime().block_on(async {
            let state = state_with_instance();
            let stream = stream(Instant::now());
            let capture = capture_loop(stream.clone(), state, "fixture".into());
            tokio::pin!(capture);

            // The old implementation returned here and spawned a replacement in
            // a tight loop. A controllerless stream must instead await its timer.
            std::future::poll_fn(|cx| {
                assert!(capture.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            assert!(stream.capture_running.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn expired_subscription_releases_the_running_flag() {
        runtime().block_on(async {
            let stream = stream(Instant::now() - Duration::from_secs(SUBSCRIBER_TIMEOUT_SECS + 1));
            tokio::time::timeout(
                Duration::from_secs(1),
                capture_loop(stream.clone(), state_with_instance(), "fixture".into()),
            )
            .await
            .expect("expired stream must stop");
            assert!(stream.subscribers.lock().unwrap().is_empty());
            assert!(!stream.capture_running.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn recreated_instance_does_not_inherit_the_old_stream() {
        runtime().block_on(async {
            let state = state_with_instance();
            let subscribe = |id: &str| {
                state
                    .screenshot_service
                    .subscribe(
                        state.clone(),
                        "fixture".into(),
                        id.into(),
                        MIN_INTERVAL_MS,
                        tokio::runtime::Handle::current(),
                    )
                    .unwrap();
            };
            subscribe("old-view");
            let old = state.screenshot_service.streams.lock().unwrap()["fixture"].clone();
            destroy_instance_impl(&state, "fixture").unwrap();
            assert!(old.subscribers.lock().unwrap().is_empty());
            assert!(state.screenshot_service.streams.lock().unwrap().is_empty());

            state
                .instances
                .lock()
                .unwrap()
                .insert("fixture".into(), InstanceRuntime::default());
            subscribe("new-view");
            let new = state.screenshot_service.streams.lock().unwrap()["fixture"].clone();
            assert!(!Arc::ptr_eq(&old, &new));
            state.screenshot_service.unsubscribe("fixture", "old-view");
            assert!(new.subscribers.lock().unwrap().contains_key("new-view"));

            tokio::time::timeout(Duration::from_secs(1), async {
                while old.capture_running.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("retired stream must stop even after its instance ID is reused");
            assert!(new.capture_running.load(Ordering::SeqCst));
        });
    }
}
