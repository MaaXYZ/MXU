//! MCP 面向客户端的本地化文本
//!
//! 翻译统一放在前端语言包（`mcp.server`），由前端在启动及切换界面语言时推送过来。
//! 尚未收到时使用代码中的内置中文兜底。后端文本中的占位符写作 `{name}`。

use std::sync::RwLock;

use serde_json::Value;

static TEXTS: RwLock<Option<Value>> = RwLock::new(None);

/// 前端推送当前界面语言的 MCP 文本
#[tauri::command]
pub fn mcp_set_texts(texts: Value) {
    if let Ok(mut guard) = TEXTS.write() {
        *guard = Some(texts);
    }
}

/// 按路径读取文本，如 `get(&["tools", "add_task", "title"])`
pub fn get(path: &[&str]) -> Option<String> {
    let guard = TEXTS.read().ok()?;
    let mut node = guard.as_ref()?;
    for key in path {
        node = node.get(key)?;
    }
    node.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// 后端错误信息：优先使用推送的翻译，否则用内置中文；替换 `{name}` 占位符
pub fn error(key: &str, fallback: &str, params: &[(&str, &str)]) -> String {
    let mut text = get(&["errors", key]).unwrap_or_else(|| fallback.to_string());
    for (name, value) in params {
        text = text.replace(&format!("{{{}}}", name), value);
    }
    text
}
