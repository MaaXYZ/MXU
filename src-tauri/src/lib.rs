pub mod commands;
mod mxu_actions;
pub mod screenshot_service;
mod tray;
mod web_server;
pub mod ws_broadcast;

use commands::{AppConfigState, MaaState};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use ws_broadcast::WsBroadcast;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 日志目录：exe 目录/debug/logs（与前端日志同目录）
    let logs_dir = commands::utils::get_logs_dir();

    // 确保日志目录存在
    let _ = std::fs::create_dir_all(&logs_dir);

    // 自动迁移旧版注册表自启动到任务计划程序
    //TODO：26年2月写的，应该过几个月这自动迁移就能去除了，等旧版的都更上来
    #[cfg(windows)]
    commands::system::migrate_legacy_autostart();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart".into()]),
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                // 默认约 40KB + KeepOne 会整文件删除，不便排查；改为单文件更大且保留多份轮转档
                .max_file_size(1 * 1024 * 1024)
                .rotation_strategy(RotationStrategy::KeepSome(8))
                .targets({
                    #[allow(unused_mut)]
                    let mut targets = vec![Target::new(TargetKind::Folder {
                        path: logs_dir,
                        file_name: Some("mxu-tauri".into()),
                    })];
                    // debug 构建额外输出到标准流便于开发调试
                    #[cfg(debug_assertions)]
                    targets.push(Target::new(TargetKind::Stdout));
                    targets
                })
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .setup(|app| {
            // Tauri 可能在 WebView 创建失败后仍注册逻辑窗口并执行 setup。
            // 此时 HWND 不可用，必须先退出，避免留下托盘和后台服务。
            #[cfg(windows)]
            if app
                .get_webview_window("main")
                .and_then(|window| window.hwnd().ok())
                .is_none()
            {
                log::error!(
                    "Main WebView creation failed (pid={}); aborting startup before initializing backend services and tray",
                    std::process::id()
                );
                app.handle().exit(1);
                return Ok(());
            }

            // 创建 MaaState 并注册为 Tauri 管理状态
            let maa_state = Arc::new(MaaState::default());

            // 创建 AppConfigState：加载 interface.json 和配置文件
            let app_config = Arc::new(AppConfigState::default());

            // 创建 WebSocket 广播器（容量 256，被 emit_callback_event/emit_agent_output 共用）
            let ws_broadcast = Arc::new(WsBroadcast::new(256));

            // 加载 interface.json（含 import 处理和翻译）
            match commands::utils::get_exe_directory() {
                Ok(exe_dir) => {
                    app_config.load_interface(&exe_dir);
                }
                Err(e) => {
                    log::warn!("AppConfigState: could not get exe dir: {}", e);
                }
            }

            // 加载配置文件
            match commands::utils::get_app_data_dir() {
                Ok(data_dir) => {
                    app_config.load_config(&data_dir);
                }
                Err(e) => {
                    log::warn!("AppConfigState: could not get data dir: {}", e);
                }
            }

            // 尽早初始化遥测，使后续启动流程中的崩溃也能上报
            commands::telemetry::init_at_startup(&app_config);

            // 先注册共享状态，再启动依赖这些状态的后台任务，避免启动竞态
            app.manage(ws_broadcast.clone());
            app.manage(app_config.clone());

            // 启动 HTTP Web 服务器（后台 tokio 任务，不阻塞 Tauri 启动）
            {
                let maa_clone = maa_state.clone();
                let cfg_clone = app_config.clone();
                let ws_clone = ws_broadcast.clone();
                let app_handle = app.handle().clone();

                let settings = app_config
                    .config
                    .lock()
                    .unwrap();
                let settings_obj = settings.get("settings");

                let web_server_enabled = settings_obj
                    .and_then(|s| s.get("webServerEnabled"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let allow_lan_access = settings_obj
                    .and_then(|s| s.get("allowLanAccess"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let web_port = settings_obj
                    .and_then(|s| s.get("webServerPort"))
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u16::try_from(v).ok())
                    .filter(|&p| p > 0)
                    .unwrap_or(web_server::DEFAULT_PORT);

                web_server::set_web_server_enabled(web_server_enabled);

                drop(settings);

                if web_server_enabled {
                    tauri::async_runtime::spawn(async move {
                        web_server::start_web_server(
                            cfg_clone,
                            maa_clone,
                            app_handle,
                            ws_clone,
                            web_port,
                            allow_lan_access,
                        )
                            .await;
                    });
                }
            }

            // Windows 下移除系统标题栏（使用自定义标题栏）
            // macOS/Linux 保留完整的原生标题栏
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            // 启动时异步清理 cache/old 目录（更新残留的旧文件），不阻塞应用启动
            // 路径与更新时移入旧文件的位置一致（macOS 上数据目录与程序目录不同）
            if let Ok(old_dir) = commands::update::get_old_dir() {
                if old_dir.exists() {
                    std::thread::spawn(move || {
                        // 与全量更新互斥：更新期间 cache/old 中是回滚备份
                        let _guard = commands::update::OLD_DIR_LOCK
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        let (deleted, failed) = commands::cleanup_dir_contents(&old_dir);
                        if deleted > 0 || failed > 0 {
                            if failed == 0 {
                                log::info!("Cleaned up cache/old: {} items deleted", deleted);
                            } else {
                                log::warn!(
                                    "Cleaned up cache/old: {} deleted, {} failed",
                                    deleted,
                                    failed
                                );
                            }
                        }
                    });
                }
            }

            // 启动时自动加载 MaaFramework DLL
            if let Ok(maafw_dir) = commands::get_maafw_dir() {
                if maafw_dir.exists() {
                    #[cfg(windows)]
                    let dll_path = maafw_dir.join("MaaFramework.dll");
                    #[cfg(target_os = "macos")]
                    let dll_path = maafw_dir.join("libMaaFramework.dylib");
                    #[cfg(target_os = "linux")]
                    let dll_path = maafw_dir.join("libMaaFramework.so");

                    match maa_framework::load_library(&dll_path) {
                        Ok(()) => {
                            log::info!("MaaFramework loaded from {:?}", dll_path);
                            // 预先设置 lib_dir，使 HTTP /api/maa/initialized 立即反映加载状态
                            *maa_state.lib_dir.lock().unwrap() = Some(maafw_dir.clone());
                        }
                        Err(e) => {
                            log::error!("Failed to load MaaFramework: {}", e);
                            // 检查是否是 DLL 存在但加载失败的情况（可能是运行库缺失）
                            if dll_path.exists() {
                                log::warn!(
                                    "DLLs exist but failed to load, possibly missing VC++ runtime: {}",
                                    e
                                );
                                // 设置标记，前端加载完成后会查询此标记
                                commands::system::set_vcredist_missing(true);
                            }
                        }
                    }
                } else {
                    log::warn!("MaaFramework directory not found: {:?}", maafw_dir);
                }
            }

            // DLL 加载完成后再注册 maa_state（确保 lib_dir 已设置）
            app.manage(maa_state);

            // 初始化系统托盘
            if let Err(e) = tray::init_tray(app.handle()) {
                log::error!("Failed to initialize system tray: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Maa 核心命令
            commands::maa_core::maa_init,
            commands::maa_core::maa_set_resource_dir,
            commands::maa_core::maa_get_version,
            commands::maa_core::maa_check_version,
            commands::maa_core::maa_find_adb_devices,
            commands::maa_core::maa_find_win32_windows,
            commands::maa_core::maa_find_wlroots_sockets,
            commands::maa_core::maa_find_gamescope_instances,
            commands::maa_core::maa_create_instance,
            commands::maa_core::maa_destroy_instance,
            commands::maa_core::maa_connect_controller,
            commands::maa_core::maa_get_connection_status,
            commands::maa_core::maa_load_resource,
            commands::maa_core::maa_is_resource_loaded,
            commands::maa_core::maa_get_resource_hash,
            commands::maa_core::maa_destroy_resource,
            commands::maa_core::maa_run_task,
            commands::maa_core::maa_get_task_status,
            commands::maa_core::maa_stop_task,
            commands::maa_core::maa_override_pipeline,
            commands::maa_core::maa_is_running,
            commands::maa_core::maa_post_click,
            commands::maa_core::maa_post_screencap,
            commands::maa_core::maa_get_cached_image,
            commands::maa_core::maa_screenshot_subscribe,
            commands::maa_core::maa_screenshot_unsubscribe,
            // Agent 命令
            commands::maa_agent::maa_start_tasks,
            commands::maa_agent::maa_stop_agent,
            // 文件操作命令
            commands::file_ops::read_local_file,
            commands::file_ops::read_local_file_base64,
            commands::file_ops::local_file_exists,
            commands::file_ops::get_exe_dir,
            commands::file_ops::get_data_dir,
            commands::file_ops::clear_log_files,
            commands::file_ops::get_cwd,
            commands::file_ops::check_exe_path,
            commands::file_ops::set_executable,
            commands::file_ops::export_logs,
            // 状态查询命令
            commands::state::maa_get_instance_state,
            commands::state::maa_get_all_states,
            commands::state::maa_get_cached_adb_devices,
            commands::state::maa_get_cached_win32_windows,
            commands::state::maa_get_cached_wlroots_sockets,
            commands::state::maa_get_cached_gamescope_instances,
            commands::state::log_to_stdout,
            commands::state::push_log,
            commands::state::get_all_logs,
            commands::state::clear_instance_logs,
            // 更新安装命令
            commands::update::extract_zip,
            commands::update::check_changes_json,
            commands::update::apply_incremental_update,
            commands::update::apply_full_update,
            commands::update::cleanup_extract_dir,
            commands::update::fallback_update,
            commands::update::move_file_to_old,
            commands::update::cleanup_update_artifacts,
            commands::update::current_exe_exists,
            // 下载命令
            commands::download::get_github_release_by_version,
            commands::download::download_file,
            commands::download::cancel_download,
            // 系统相关命令
            commands::system::is_elevated,
            commands::system::is_workstation_locked,
            commands::system::is_autostart,
            commands::system::get_start_instance,
            commands::system::has_quit_after_run_flag,
            commands::system::restart_as_admin,
            commands::system::maa_set_save_draw,
            commands::system::open_file,
            commands::system::run_and_wait,
            commands::system::set_pre_action_stop,
            commands::system::run_action,
            commands::system::run_pretask,
            commands::system::is_process_running,
            commands::system::get_process_path_from_hwnd,
            commands::system::retry_load_maa_library,
            commands::system::check_vcredist_missing,
            commands::system::autostart_enable,
            commands::system::autostart_disable,
            commands::system::autostart_is_enabled,
            commands::system::get_arch,
            commands::system::get_os,
            commands::system::get_system_info,
            commands::system::get_web_server_port,
            commands::system::get_local_lan_ip,
            commands::system::get_webview2_dir,
            // 托盘相关命令
            commands::tray::set_minimize_to_tray,
            commands::tray::get_minimize_to_tray,
            commands::tray::update_tray_icon,
            commands::tray::update_tray_tooltip,
            // 配置同步命令（WebUI 实时同步）
            commands::app_config::notify_config_changed,
            commands::app_config::take_config_recovery_notice,
            // 系统通知命令
            commands::notification::send_system_notification,
            // 匿名遥测命令
            commands::telemetry::telemetry_init,
            commands::telemetry::telemetry_set_enabled,
        ])
        .on_window_event(|window, event| {
            match event {
                // 窗口关闭请求：检查是否最小化到托盘
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if tray::handle_close_requested(window.app_handle()) {
                        api.prevent_close();
                    }
                }
                // 窗口销毁时清理所有 agent 子进程
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.try_state::<Arc<MaaState>>() {
                        state.cleanup_all_agent_children();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(windows)]
    let requested_exit_code = std::rc::Rc::new(std::cell::Cell::new(None));
    #[cfg(windows)]
    let final_exit_code = requested_exit_code.clone();

    let on_event = move |_app_handle: &tauri::AppHandle, event: tauri::RunEvent| {
        #[cfg(windows)]
        if let tauri::RunEvent::ExitRequested { code, .. } = &event {
            requested_exit_code.set(*code);
        }

        // 退出前收尾遥测（结束 Session 与悬挂 Transaction 并 flush）
        if matches!(event, tauri::RunEvent::Exit) {
            commands::telemetry::on_app_exit();
        }
    };

    #[cfg(windows)]
    {
        // tauri-runtime-wry 2.9.3 的 ControlFlow::Exit 丢失请求的退出码。
        // 先让事件循环完成退出回调和框架清理，再向操作系统报告该退出码。
        let runtime_exit_code = app.run_return(on_event);
        std::process::exit(final_exit_code.get().unwrap_or(runtime_exit_code));
    }
    #[cfg(not(windows))]
    app.run(on_event);
}
