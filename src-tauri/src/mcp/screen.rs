//! 截图能力（后端直接处理，不经过前端）

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::texts;
use crate::commands::types::MaaState;

/// 等待一次截图完成的最长时间
const SCREENCAP_TIMEOUT: Duration = Duration::from_secs(10);

/// 获取标签页（实例）当前画面，返回 base64 编码的 PNG
///
/// - 任务运行中：pipeline 会持续刷新截图缓存，直接取缓存，避免与任务争抢截图
/// - 未运行：主动截一次并等待完成，保证拿到的是最新画面
pub async fn capture_png_base64(
    maa_state: &Arc<MaaState>,
    instance_id: &str,
) -> Result<String, String> {
    let (controller, is_running) = {
        let instances = maa_state.instances.lock().map_err(|e| e.to_string())?;
        let instance = instances
            .get(instance_id)
            // 后端只在连接设备时才为标签页创建运行时实例，查不到即视为未连接
            .ok_or_else(not_connected)?;
        let controller = instance
            .controller
            .as_ref()
            .filter(|c| c.connected())
            .ok_or_else(not_connected)?
            .clone();
        let is_running = instance.tasker.as_ref().is_some_and(|t| t.running());
        (controller, is_running)
    };

    if !is_running {
        let ctrl = controller.clone();
        let wait = tokio::task::spawn_blocking(move || {
            let id = ctrl.post_screencap().map_err(|e| e.to_string())?;
            Ok::<_, String>(ctrl.wait(id))
        });
        match tokio::time::timeout(SCREENCAP_TIMEOUT, wait).await {
            Ok(Ok(Ok(status))) if status.succeeded() => {}
            Ok(Ok(Ok(_))) => return Err(texts::error("captureFailed", "截图失败", &[])),
            Ok(Ok(Err(e))) => return Err(capture_failed(&e)),
            Ok(Err(e)) => return Err(capture_failed(&e.to_string())),
            Err(_) => return Err(texts::error("captureTimeout", "截图超时", &[])),
        }
    }

    let buffer = controller.cached_image().map_err(|e| e.to_string())?;
    let data = buffer
        .to_vec()
        .ok_or_else(|| texts::error("readImageFailed", "读取截图数据失败", &[]))?;
    if data.is_empty() {
        return Err(texts::error("noImageData", "暂无截图数据", &[]));
    }
    Ok(STANDARD.encode(&data))
}

fn not_connected() -> String {
    texts::error("deviceNotConnected", "设备未连接，无法截图", &[])
}

fn capture_failed(error: &str) -> String {
    texts::error(
        "captureFailedWithError",
        "截图失败：{error}",
        &[("error", error)],
    )
}
