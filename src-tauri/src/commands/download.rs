//! 下载相关命令
//!
//! 提供流式文件下载功能，支持进度回调和取消

use log::{error, info, warn};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tauri::Emitter;

use super::types::GitHubRelease;
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};

use super::types::{DownloadProgressEvent, DownloadResult};
use super::update::move_to_old_folder;
use super::utils::build_user_agent;

/// 进度上报任务的守卫，在函数任意返回路径上都能确保发送停止信号
struct ProgressEmitterGuard(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for ProgressEmitterGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

/// 临时文件清理守卫，在函数异常退出时自动删除 .downloading 半成品。
/// 成功重命名后需调用 `disarm()`，避免 drop 时冗余的 `remove_file`。
struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// 成功重命名后调用，使 drop 时不再尝试删除（文件已移至目标路径）。
    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            // 必须同步删除，避免竞态条件：
            // 如果异步删除，可能在下一次下载创建同名临时文件后才执行，导致误删。
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 全局下载取消标志
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);
/// 当前下载的 session ID，用于区分不同的下载任务
static CURRENT_DOWNLOAD_SESSION: AtomicU64 = AtomicU64::new(0);

fn apply_proxy(
    mut client_builder: reqwest::ClientBuilder,
    proxy_url: Option<&str>,
    log_prefix: &str,
    target_url: &str,
) -> Result<reqwest::ClientBuilder, String> {
    if let Some(proxy) = proxy_url.filter(|proxy| !proxy.is_empty()) {
        info!("[{}] 使用代理: {}", log_prefix, proxy);
        info!("[{}] 目标: {}", log_prefix, target_url);
        let reqwest_proxy = reqwest::Proxy::all(proxy).map_err(|e| {
            error!("代理配置失败: {} (代理地址: {})", e, proxy);
            format!(
                "代理配置失败: {}。请检查代理格式是否正确（支持 http:// 或 socks5://）",
                e
            )
        })?;
        client_builder = client_builder.proxy(reqwest_proxy);
    }

    Ok(client_builder)
}

/// 根据版本号获取 GitHub Release URL
///
/// 使用 GitHub API 获取指定版本的 Release 信息，支持使用 GitHub PAT 和代理
/// 解析 GitHub API 返回的 JSON 数据，找到与 target_version 匹配的 release，并返回 URL
#[tauri::command]
pub async fn get_github_release_by_version(
    owner: String,
    repo: String,
    target_version: String,
    github_pat: Option<String>,
    proxy_url: Option<String>,
) -> Result<Option<GitHubRelease>, String> {
    let url = format!("https://api.github.com/repos/{}/{}/releases", owner, repo);

    // 构造请求头
    let mut client_builder = reqwest::Client::builder()
        .user_agent("mxu")
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(3));

    client_builder = apply_proxy(client_builder, proxy_url.as_deref(), "检查更新", &url)?;

    let client = client_builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut request = client
        .get(&url)
        .header(ACCEPT, "application/vnd.github.v3+json")
        .header(USER_AGENT, "mxu");

    // 添加 PAT 认证（如果提供）
    if let Some(pat) = github_pat {
        if !pat.trim().is_empty() {
            request = request.header(AUTHORIZATION, format!("token {}", pat.trim()));
        }
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API 错误: {}", response.status()));
    }

    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let normalize = |v: &str| {
        v.trim_start_matches(|c| c == 'v' || c == 'V')
            .to_lowercase()
    };
    let target_normalized = normalize(&target_version);

    for release in releases {
        if normalize(&release.tag_name) == target_normalized {
            info!(
                "找到匹配的 Release: {} (tag: {})",
                release.name, release.tag_name
            );
            return Ok(Some(release));
        }
    }
    warn!("未找到匹配的 Release: target_version={}", target_version);
    Ok(None)
}

/// 检查下载链接的 HTTP 状态码，支持使用代理
#[tauri::command]
pub async fn probe_download_url(url: String, proxy_url: Option<String>) -> Result<u16, String> {
    let client_builder = reqwest::Client::builder()
        .user_agent(build_user_agent())
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(3));
    let client_builder = apply_proxy(
        client_builder,
        proxy_url.as_deref(),
        "检查直接下载链接",
        &url,
    )?;
    let client = client_builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    Ok(response.status().as_u16())
}

/// 流式下载文件，支持进度回调和取消
///
/// 使用 reqwest 进行流式下载，直接写入文件而不经过内存缓冲，
/// 解决 JavaScript 下载大文件时的性能问题
///
/// 返回 DownloadResult，包含 session_id 和实际保存路径
/// 如果检测到重定向后的 URL 或 Content-Disposition 包含正确的文件名，
/// 会使用该文件名保存（替换原始 save_path 的文件名部分）
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    url: String,
    save_path: String,
    total_size: Option<u64>,
    proxy_url: Option<String>,
) -> Result<DownloadResult, String> {
    use futures_util::StreamExt;
    use std::io::Write;
    use tokio::time::{sleep, Duration};

    info!("download_file: {} -> {}", url, save_path);

    // 生成新的 session ID，使旧下载的进度事件无效
    let session_id = CURRENT_DOWNLOAD_SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    info!("download_file session_id: {}", session_id);

    // 重置取消标志
    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);

    let save_path_obj = std::path::Path::new(&save_path);

    // 确保目录存在
    if let Some(parent) = save_path_obj.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {}", e))?;
    }

    // 构建 HTTP 客户端和请求
    let mut client_builder = reqwest::Client::builder()
        .user_agent(build_user_agent())
        .timeout(std::time::Duration::from_secs(1800)) // 30 分钟超时，足够下载大文件但防止无限挂起
        .connect_timeout(std::time::Duration::from_secs(10));

    // 配置代理（如果提供）
    if let Some(ref proxy) = proxy_url {
        if !proxy.is_empty() {
            info!("[下载] 使用代理: {}", proxy);
            info!("[下载] 目标: {}", url);
            let reqwest_proxy = reqwest::Proxy::all(proxy).map_err(|e| {
                error!("代理配置失败: {} (代理地址: {})", e, proxy);
                format!(
                    "代理配置失败: {}。请检查代理格式是否正确（支持 http:// 或 socks5://）",
                    e
                )
            })?;
            client_builder = client_builder.proxy(reqwest_proxy);
        } else {
            info!("[下载] 直连（无代理）: {}", url);
        }
    } else {
        info!("[下载] 直连（无代理）: {}", url);
    }

    let client = client_builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP 错误: {}", response.status()));
    }

    // 尝试从 Content-Disposition header 或最终 URL 提取文件名
    let detected_filename = extract_filename_from_response(&response);
    if let Some(ref name) = detected_filename {
        info!("[下载] 检测到文件名: {}", name);
    }

    // 确定实际保存路径
    let actual_save_path = if let Some(ref filename) = detected_filename {
        // 使用检测到的文件名，保持原目录
        if let Some(parent) = save_path_obj.parent() {
            parent.join(filename).to_string_lossy().to_string()
        } else {
            filename.clone()
        }
    } else {
        save_path.clone()
    };

    let actual_save_path_obj = std::path::Path::new(&actual_save_path);

    // 使用包含 session_id 的临时文件名，避免取消后立即重试时新旧任务竞争同一临时文件
    let temp_path = format!("{}.{}.downloading", actual_save_path, session_id);
    let mut temp_guard = TempFileGuard::new(PathBuf::from(&temp_path));

    // 获取文件大小
    let content_length = response.content_length();
    let total = total_size.or(content_length).unwrap_or(0);

    // 有界通道将网络读取与磁盘写入解耦：
    // - 下载循环纯异步，不阻塞 runtime，可全速消费 TCP 流
    // - 写入线程用同步 BufWriter，单线程从头跑到尾，避免 tokio::fs 逐次 spawn_blocking 的调度开销
    let (write_tx, write_rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(64);

    let temp_path_for_writer = temp_path.clone();
    let write_handle = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&temp_path_for_writer)
            .map_err(|e| format!("无法创建文件: {}", e))?;
        let mut writer = std::io::BufWriter::with_capacity(512 * 1024, file);
        let mut write_rx = write_rx;
        while let Some(chunk) = write_rx.blocking_recv() {
            writer
                .write_all(&chunk)
                .map_err(|e| format!("写入文件失败: {}", e))?;
        }
        writer
            .flush()
            .map_err(|e| format!("刷新写入缓冲区失败: {}", e))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("同步文件失败: {}", e))?;
        Ok(())
    });

    // 共享下载字节计数，用于独立的进度上报任务
    let downloaded_shared = Arc::new(AtomicU64::new(0));
    let downloaded_for_emitter = downloaded_shared.clone();

    // 启动独立任务定期上报进度，避免在下载循环中因 emit 阻塞导致”卡卡停停”
    let app_for_emitter = app.clone();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let progress_guard = ProgressEmitterGuard(Some(stop_tx));
    tokio::spawn(async move {
        let mut last_downloaded = 0u64;
        let mut last_instant = tokio::time::Instant::now();
        let mut smoothed_speed: f64 = 0.0;
        const EMA_ALPHA: f64 = 0.3;
        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    break;
                }
                _ = sleep(Duration::from_millis(100)) => {
                    let downloaded = downloaded_for_emitter.load(Ordering::Relaxed);
                    let now = tokio::time::Instant::now();
                    let elapsed = now.duration_since(last_instant);
                    if elapsed.as_millis() == 0 {
                        continue;
                    }

                    let bytes_in_interval = downloaded.saturating_sub(last_downloaded);
                    let instant_speed = if elapsed.as_secs_f64() > 0.0 {
                        bytes_in_interval as f64 / elapsed.as_secs_f64()
                    } else {
                        0.0
                    };

                    smoothed_speed = if smoothed_speed == 0.0 {
                        instant_speed
                    } else {
                        EMA_ALPHA * instant_speed + (1.0 - EMA_ALPHA) * smoothed_speed
                    };

                    let progress = if total > 0 {
                        ((downloaded as f64 / total as f64) * 100.0).min(100.0)
                    } else {
                        0.0
                    };

                    let _ = app_for_emitter.emit(
                        "download-progress",
                        DownloadProgressEvent {
                            session_id,
                            downloaded_size: downloaded,
                            total_size: total,
                            speed: smoothed_speed as u64,
                            progress,
                        },
                    );

                    last_downloaded = downloaded;
                    last_instant = now;
                }
            }
        }
    });

    // 说明：downloaded_shared 仅用于进度上报的近实时采样，对 UI 来说允许“最终一致”，
    // 因此这里使用 Relaxed 内存序即可，避免在热路径上引入不必要的全序栅栏。

    // 流式下载
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut download_err: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst)
            || CURRENT_DOWNLOAD_SESSION.load(Ordering::SeqCst) != session_id
        {
            info!("download_file cancelled (session {})", session_id);
            download_err = Some("下载已取消".to_string());
            break;
        }

        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                download_err = Some(format!("下载数据失败: {}", e));
                break;
            }
        };

        let len = chunk.len() as u64;
        if write_tx.send(chunk).await.is_err() {
            download_err = Some("磁盘写入线程异常退出".to_string());
            break;
        }
        downloaded += len;
        downloaded_shared.store(downloaded, Ordering::Relaxed);
    }

    // 最后再检查一次取消标志
    if download_err.is_none()
        && (DOWNLOAD_CANCELLED.load(Ordering::SeqCst)
            || CURRENT_DOWNLOAD_SESSION.load(Ordering::SeqCst) != session_id)
    {
        info!(
            "download_file cancelled before finalization (session {})",
            session_id
        );
        download_err = Some("下载已取消".to_string());
    }

    // 关闭发送端，通知写入线程所有数据已发送完毕
    drop(write_tx);

    // 等待写入线程完成，确保文件句柄关闭后再进行重命名等后续操作
    let write_thread_result = write_handle
        .await
        .map_err(|e| format!("写入任务异常: {}", e))?;

    if let Some(err) = download_err {
        // 写入线程通常持有更具体的 I/O 错误信息（如磁盘满），优先返回
        if let Err(write_err) = write_thread_result {
            return Err(write_err);
        }
        return Err(err);
    }
    write_thread_result?;

    // 发送最终进度
    let _ = app.emit(
        "download-progress",
        DownloadProgressEvent {
            session_id,
            downloaded_size: downloaded,
            total_size: if total > 0 { total } else { downloaded },
            speed: 0,
            progress: 100.0,
        },
    );

    // 将可能存在的旧文件移动到 old 文件夹
    if actual_save_path_obj.exists() {
        let _ = move_to_old_folder(actual_save_path_obj);
    }

    // 重命名临时文件（使用异步版本避免阻塞 runtime 线程）
    tokio::fs::rename(&temp_path, &actual_save_path)
        .await
        .map_err(|e| format!("重命名文件失败: {}", e))?;
    temp_guard.disarm();

    info!(
        "download_file completed: {} bytes -> {} (session {})",
        downloaded, actual_save_path, session_id
    );

    // 显式 drop progress_guard 以停止进度上报任务
    drop(progress_guard);

    Ok(DownloadResult {
        session_id,
        actual_save_path,
        detected_filename,
    })
}

/// 取消下载
#[tauri::command]
pub fn cancel_download(save_path: String) -> Result<(), String> {
    info!("cancel_download called for: {}", save_path);

    // 设置取消标志，让下载循环退出
    DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);

    // 同时尝试删除临时文件（如果已经创建）
    let temp_path = format!("{}.downloading", save_path);
    let path = std::path::Path::new(&temp_path);

    if path.exists() {
        if let Err(e) = std::fs::remove_file(path) {
            // 文件可能正在被写入，记录警告但不报错
            warn!("cancel_download: failed to remove {}: {}", temp_path, e);
        } else {
            info!("cancel_download: removed {}", temp_path);
        }
    }

    Ok(())
}

/// 从 HTTP 响应中提取文件名
///
/// 优先级：
/// 1. Content-Disposition header 中的 filename
/// 2. 最终 URL（重定向后）的路径部分
fn extract_filename_from_response(response: &reqwest::Response) -> Option<String> {
    // 1. 尝试从 Content-Disposition header 提取
    if let Some(cd) = response.headers().get("content-disposition") {
        if let Ok(cd_str) = cd.to_str() {
            if let Some(filename) = parse_content_disposition(cd_str) {
                if let Some(safe) = sanitize_filename(&filename) {
                    return Some(safe);
                }
            }
        }
    }

    // 2. 尝试从最终 URL 提取（重定向后的 URL）
    let final_url = response.url();
    let path = final_url.path();

    // 获取路径的最后一部分
    if let Some(last_segment) = path.rsplit('/').next() {
        if !last_segment.is_empty() {
            // URL 解码
            if let Ok(decoded) = urlencoding::decode(last_segment) {
                let filename = decoded.to_string();
                // 确保有扩展名，并清理文件名
                if filename.contains('.') {
                    if let Some(safe) = sanitize_filename(&filename) {
                        return Some(safe);
                    }
                }
            }
        }
    }

    None
}

/// 清理文件名，防止目录遍历攻击
///
/// - 移除路径分隔符（/ 和 \）
/// - 移除 .. 片段
/// - 只保留文件名部分
fn sanitize_filename(filename: &str) -> Option<String> {
    // 获取最后一个路径分隔符后的部分（处理 path/to/file.exe 或 path\to\file.exe）
    let name = filename
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(filename);

    // 过滤掉 .. 和空文件名
    if name.is_empty() || name == "." || name == ".." || name.starts_with("..") {
        return None;
    }

    // 确保有扩展名
    if !name.contains('.') {
        return None;
    }

    Some(name.to_string())
}

/// 解析 Content-Disposition header 提取文件名（大小写不敏感）
///
/// 支持格式：
/// - attachment; filename="example.exe"
/// - attachment; filename=example.exe
/// - attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.exe
/// - Attachment; Filename="example.exe" (大小写变体)
fn parse_content_disposition(header: &str) -> Option<String> {
    let header_lower = header.to_lowercase();

    // 首先尝试 filename*=（RFC 5987 编码，优先级更高）
    if let Some(start) = header_lower.find("filename*=") {
        let rest = &header[start + 10..];
        // 格式: UTF-8''encoded_filename 或 utf-8''encoded_filename
        if let Some(quote_pos) = rest.find("''") {
            let encoded = rest[quote_pos + 2..].split(';').next().unwrap_or("").trim();
            if let Ok(decoded) = urlencoding::decode(encoded) {
                let filename = decoded.trim_matches('"').to_string();
                if !filename.is_empty() {
                    return Some(filename);
                }
            }
        }
    }

    // 然后尝试普通的 filename=（但要确保不是 filename*=）
    // 查找 "filename=" 但排除 "filename*="
    let mut search_start = 0;
    while let Some(pos) = header_lower[search_start..].find("filename=") {
        let absolute_pos = search_start + pos;
        // 检查是否是 filename*=（前一个字符是 *）
        if absolute_pos > 0 && header.as_bytes().get(absolute_pos - 1) == Some(&b'*') {
            search_start = absolute_pos + 9;
            continue;
        }

        let rest = &header[absolute_pos + 9..];
        let filename = rest
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();
        if !filename.is_empty() {
            return Some(filename);
        }
        break;
    }

    None
}

#[cfg(test)]
mod tests {
    use super::probe_download_url;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn probe_download_url_uses_explicit_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test proxy");
        let proxy_address = listener.local_addr().expect("get test proxy address");
        let proxy = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept proxied request");
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 2048];
                let bytes_read = stream.read(&mut chunk).expect("read proxied request");
                assert!(bytes_read > 0, "proxy closed before request headers");
                request.extend_from_slice(&chunk[..bytes_read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
                assert!(
                    request.len() <= 64 * 1024,
                    "proxy request headers too large"
                );
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("HEAD http://example.invalid/update.zip HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("write proxy response");
        });

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build Tokio runtime");
        let status = runtime
            .block_on(probe_download_url(
                "http://example.invalid/update.zip".to_string(),
                Some(format!("http://{}", proxy_address)),
            ))
            .expect("probe through proxy");

        assert_eq!(status, 204);
        proxy.join().expect("join test proxy");
    }
}
