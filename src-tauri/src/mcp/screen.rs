use crate::commands::types::MaaState;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{sync::Arc, time::Duration};

pub struct Screenshot {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: String,
}
pub enum CaptureError {
    NotConnected,
    Failed,
}

fn dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || !data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return None;
    }
    let width = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(data[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

pub async fn capture_png(
    maa_state: &Arc<MaaState>,
    instance_id: &str,
) -> Result<Screenshot, CaptureError> {
    let controller = {
        let instances = maa_state
            .instances
            .lock()
            .map_err(|_| CaptureError::Failed)?;
        instances
            .get(instance_id)
            .and_then(|instance| instance.controller.as_ref())
            .filter(|controller| controller.connected())
            .ok_or(CaptureError::NotConnected)?
            .clone()
    };
    // Capture a new image instead of timestamping an arbitrarily old task cache.
    let ctrl = controller.clone();
    let status = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let id = ctrl.post_screencap().map_err(|_| ())?;
            Ok::<_, ()>(ctrl.wait(id))
        }),
    )
    .await
    .map_err(|_| CaptureError::Failed)?
    .map_err(|_| CaptureError::Failed)?
    .map_err(|_| CaptureError::Failed)?;
    if !status.succeeded() {
        return Err(CaptureError::Failed);
    }
    let captured_at = chrono::Utc::now().to_rfc3339();
    let buffer = controller
        .cached_image()
        .map_err(|_| CaptureError::Failed)?;
    let data = buffer.to_vec().ok_or(CaptureError::Failed)?;
    let (width, height) = dimensions(&data).ok_or(CaptureError::Failed)?;
    Ok(Screenshot {
        base64: STANDARD.encode(data),
        width,
        height,
        captured_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dimensions_require_a_png_with_positive_dimensions() {
        assert_eq!(dimensions(&[]), None);
        let mut data = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
        data.extend(1280_u32.to_be_bytes());
        data.extend(720_u32.to_be_bytes());
        assert_eq!(dimensions(&data), Some((1280, 720)));
        data[20..24].copy_from_slice(&0_u32.to_be_bytes());
        assert_eq!(dimensions(&data), None);
    }
}
