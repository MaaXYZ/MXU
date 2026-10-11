//! Tauri 命令模块
//!
//! 提供前端调用的 MaaFramework 功能接口
//!
//! 模块结构：
//! - `types`: 数据类型定义
//! - `utils`: 辅助函数
//! - `maa_core`: Maa 核心命令（初始化、设备搜索、控制器、资源、任务）
//! - `maa_agent`: Agent 相关命令
//! - `state`: 状态查询命令
//! - `file_ops`: 文件操作命令
//! - `update`: 更新安装相关命令
//! - `download`: 下载相关命令
//! - `system`: 系统相关命令
//! - `tray`: 托盘相关命令

pub mod types;
pub mod utils;

pub mod app_config;
pub mod download;
pub mod file_ops;
pub mod maa_agent;
pub mod maa_core;
pub mod notification;
pub mod state;
pub mod system;
mod task_diagnostics;
pub mod telemetry;
pub mod tray;
pub mod update;

// 重新导出类型（供 lib.rs 使用）
pub use app_config::AppConfigState;
pub use types::MaaState;

// 重新导出辅助函数（供 lib.rs 使用）
pub use update::cleanup_dir_contents;
pub use utils::get_maafw_dir;

// 重新导出 Tauri 命令（供 lib.rs 直接调用的函数）
pub use file_ops::get_data_dir;
pub use file_ops::get_exe_dir;
