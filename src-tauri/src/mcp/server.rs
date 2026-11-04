//! MCP Server 定义：工具与 instructions

use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock as Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::schemars::{self, JsonSchema};
use rmcp::service::RequestContext;
use rmcp::RoleServer;
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::bridge::McpBridge;
use super::screen;
use super::texts;
use crate::commands::app_config::AppConfigState;
use crate::commands::types::MaaState;

/// 普通桥接请求的超时
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
/// 启动任务可能需要自动连接设备、加载资源，放宽超时
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// 停止任务需要等待任务真正停下
const STOP_TIMEOUT: Duration = Duration::from_secs(60);

const INSTRUCTIONS: &str = r#"你正在通过 MCP 操作 MXU。MXU 是基于 MaaFramework 的通用自动化客户端，具体自动化哪个项目以 list_tabs 返回的项目信息为准。

## 你能做什么
- 管理任务列表：查看、添加、修改、删除任务（含 MXU 特殊任务，如延迟、定时等待、启动程序）
- 启动 / 停止任务，查询运行状态与日志
- 查看设备当前画面截图
画面上的操作全部由 MXU 的任务执行，你不能直接点击或滑动。

## 基本概念
- 标签页：MXU 界面顶部的每个标签页，各自有独立的设备连接、任务列表和运行状态。不传 tab_id 时使用当前选中的标签页。
- 任务：由项目定义，用 list_available_tasks 查看当前可添加的任务；任务可带选项，用 describe_task 查看。
- 任务列表里的每一项有独立的 task_id，同名任务可以出现多次。
- 返回结果中的 label 是界面显示的名称（已按当前界面语言翻译），name 是内部名称；调用工具时传 name。

## 推荐流程
1. 先调用 list_tabs；有多个标签页且用户没说明时，先问用户要操作哪个。
2. 修改任务列表前先调用 get_task_list 了解现状，避免重复添加。
3. 添加任务：
   - 用 list_available_tasks 的名称和描述匹配用户的说法；对应关系不确定时先问用户，不要猜。
   - 用 describe_task 查看选项，只传用户要求修改的选项，其余保持默认。
   - 选项值使用 describe_task 返回的取值名称；校验失败时根据错误中的合法取值修正。
4. 启动任务：start_tasks 会立即返回，之后每 10～30 秒调用一次 get_run_status，直到运行结束；运行中不要重复启动。
5. 排查失败：先看 get_run_status 返回的日志，必要时用 capture_screen 查看画面；向用户汇报时把证据和推测分开说。

## 注意事项
- 只在用户明确要求时才启动任务：任务会操控用户的设备。
- 运行中不能修改或删除任务；运行中添加的普通任务和特殊任务会追加到当前执行队列末尾，前置任务（pretask）要到下次启动才生效。
- 删除任务不会弹出确认，删除前确认 task_id 是用户要删的那一项。
- 截图需要设备已连接；未连接时不要为了截图而启动任务，先询问用户。
- 密码类选项的值已打码；不要让用户在对话中提供密码，请用户在 MXU 界面里填写。
- 你的所有写操作都会记录在 MXU 的日志面板中。"#;

// ============================================================================
// 参数定义
// ============================================================================

#[derive(Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct InstanceParams {
    /// 标签页 ID（来自 list_tabs）；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct DescribeTaskParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 任务名称（list_available_tasks 返回的 name）
    pub task_name: String,
    /// 只查看这一个选项（含子选项），取值列表完整列出；用于查看标记了 cases_omitted 的选项
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddTaskParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 任务名称（list_available_tasks 返回的 name）
    pub task_name: String,
    /// 选项值，键为 describe_task 返回的选项 key，只传需要修改的选项：
    /// select 传取值名称字符串；checkbox 传取值名称数组；switch 传 "Yes" / "No"；
    /// input 传 { 字段名: 字符串值 } 对象
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Map<String, Value>>,
    /// 是否勾选启用，默认 true
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct UpdateTaskParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 任务列表中的任务 ID（get_task_list 返回的 task_id）
    pub task_id: String,
    /// 要修改的选项，只传需要修改的选项，未传的保持当前值；格式与 add_task 的 options 相同
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Map<String, Value>>,
    /// 是否勾选启用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct TaskIdParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 任务列表中的任务 ID（get_task_list 返回的 task_id）
    pub task_id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct StartTasksParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 只运行这一个任务（get_task_list 返回的 task_id）；不传则运行所有已勾选的任务
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RunStatusParams {
    /// 标签页 ID；不传则使用当前选中的标签页
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// 返回最近多少条日志，默认 20，最大 200
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_limit: Option<u32>,
}

// ============================================================================
// Server
// ============================================================================

#[derive(Clone)]
pub struct MxuMcpServer {
    bridge: Arc<McpBridge>,
    maa_state: Arc<MaaState>,
    app_config: Arc<AppConfigState>,
    version: String,
    tool_router: ToolRouter<Self>,
}

impl MxuMcpServer {
    pub fn new(
        bridge: Arc<McpBridge>,
        maa_state: Arc<MaaState>,
        app_config: Arc<AppConfigState>,
        version: String,
    ) -> Self {
        Self {
            bridge,
            maa_state,
            app_config,
            version,
            tool_router: Self::tool_router(),
        }
    }

    /// 显示名称：带上当前加载的项目，便于同时运行多个 MXU 时区分（如「MXU - MaaEnd v1.0.0」）
    fn display_title(&self) -> String {
        let project = self
            .app_config
            .project_interface
            .lock()
            .ok()
            .and_then(|pi| {
                let pi = pi.as_ref()?;
                let name = pi.get("label").or_else(|| pi.get("name"))?.as_str()?;
                // label 可能是 $ 开头的国际化 key，此时回退到 name
                let name = if name.starts_with('$') {
                    pi.get("name")?.as_str()?
                } else {
                    name
                };
                let version = pi.get("version").and_then(|v| v.as_str());
                Some(match version {
                    Some(v) => format!("{} {}", name, v),
                    None => name.to_string(),
                })
            });
        match project {
            Some(project) => format!("MXU - {}", project),
            None => "MXU".to_string(),
        }
    }

    /// 转发到前端，把业务错误作为工具错误结果返回给 AI（而非协议错误）
    async fn forward<P: Serialize>(
        &self,
        op: &str,
        params: &P,
        timeout: Duration,
    ) -> Result<CallToolResult, ErrorData> {
        let args = serde_json::to_value(params)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(match self.bridge.call(op, args, timeout).await {
            Ok(data) => json_result(&data),
            Err(e) => CallToolResult::error(vec![Content::text(e)]),
        })
    }
}

fn json_result(data: &Value) -> CallToolResult {
    // 紧凑 JSON：缩进对模型无益，复杂任务的选项结构缩进后体积会膨胀数倍
    let text = data.to_string();
    CallToolResult::success(vec![Content::text(text)])
}

#[tool_router]
impl MxuMcpServer {
    #[tool(
        title = "查看标签页",
        description = "列出 MXU 的所有标签页（各自有独立的设备连接与任务列表）及其连接、运行状态，并返回当前加载的项目信息。返回的 tab_id 用于在其他工具中指定标签页。",
        annotations(title = "查看标签页", read_only_hint = true, open_world_hint = false)
    )]
    async fn list_tabs(&self) -> Result<CallToolResult, ErrorData> {
        self.forward("list_tabs", &json!({}), DEFAULT_TIMEOUT).await
    }

    #[tool(
        title = "查看可添加的任务",
        description = "列出标签页可以添加的任务（已按当前控制器/资源过滤），包括项目任务、前置任务（pretask: true）和 MXU 特殊任务（special: true）。只返回名称与简介，不含选项结构（用 describe_task 查看）；已添加的任务用 get_task_list 查看。",
        annotations(
            title = "查看可添加的任务",
            read_only_hint = true,
            open_world_hint = false
        )
    )]
    async fn list_available_tasks(
        &self,
        Parameters(params): Parameters<InstanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("list_available_tasks", &params, DEFAULT_TIMEOUT)
            .await
    }

    #[tool(
        title = "查看任务选项",
        description = "查看某个任务的选项结构，格式与 interface.json 一致：root_options 是顶层选项 key，options 是 key → 选项定义表（类型、label、默认值、可选取值、输入字段），取值下的 options 是选中后出现的子选项 key，到 options 表里查定义。只描述结构，不返回已添加任务的当前取值（用 get_task_list 查看）。取值列表与另一选项完全相同时省略 cases，用 cases_same_as 指明参照的选项 key；取值超过 50 项时省略 cases（cases_omitted，case_count 为数量），需要时传 option_key 单独查看该选项的完整取值。",
        annotations(title = "查看任务选项", read_only_hint = true, open_world_hint = false)
    )]
    async fn describe_task(
        &self,
        Parameters(params): Parameters<DescribeTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("describe_task", &params, DEFAULT_TIMEOUT)
            .await
    }

    #[tool(
        title = "查看任务列表",
        description = "查看标签页任务列表中已添加的任务：每项的 task_id、名称、是否勾选、运行状态及当前选项值（密码已打码）。要查看还能添加哪些任务用 list_available_tasks。",
        annotations(title = "查看任务列表", read_only_hint = true, open_world_hint = false)
    )]
    async fn get_task_list(
        &self,
        Parameters(params): Parameters<InstanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("get_task_list", &params, DEFAULT_TIMEOUT)
            .await
    }

    #[tool(
        title = "添加任务",
        description = "向标签页的任务列表添加一个任务，返回新任务的 task_id；选项的 key 与取值先用 describe_task 查看。标签页运行中时，普通任务和特殊任务会追加到当前执行队列，前置任务下次启动生效。只添加不启动，启动用 start_tasks。",
        annotations(
            title = "添加任务",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn add_task(
        &self,
        Parameters(params): Parameters<AddTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("add_task", &params, DEFAULT_TIMEOUT).await
    }

    #[tool(
        title = "修改任务",
        description = "修改任务列表中已有任务的选项或勾选状态，task_id 来自 get_task_list；只传要修改的选项，未传的保持当前值，选项的 key 与取值用 describe_task 查看。标签页运行中时不能修改，需先用 stop_tasks 停止。返回修改后的选项值。",
        annotations(
            title = "修改任务",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn update_task(
        &self,
        Parameters(params): Parameters<UpdateTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("update_task", &params, DEFAULT_TIMEOUT).await
    }

    #[tool(
        title = "删除任务",
        description = "从标签页的任务列表删除一个任务（不会弹出确认），task_id 来自 get_task_list。标签页运行中时不能删除，需先用 stop_tasks 停止。",
        annotations(
            title = "删除任务",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn remove_task(
        &self,
        Parameters(params): Parameters<TaskIdParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("remove_task", &params, DEFAULT_TIMEOUT).await
    }

    #[tool(
        title = "启动任务",
        description = "启动标签页的任务：运行所有已勾选的任务，或用 task_id 只运行其中一个。会自动连接设备、加载资源；启动后立即返回，不等待任务结束，进度用 get_run_status 查询。启动失败时返回原因（如未找到窗口/设备）。",
        annotations(
            title = "启动任务",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn start_tasks(
        &self,
        Parameters(params): Parameters<StartTasksParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("start_tasks", &params, START_TIMEOUT).await
    }

    #[tool(
        title = "停止任务",
        description = "停止标签页正在运行的任务，等待任务停下后返回。不会删除任务或修改任务列表。",
        annotations(
            title = "停止任务",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn stop_tasks(
        &self,
        Parameters(params): Parameters<InstanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("stop_tasks", &params, STOP_TIMEOUT).await
    }

    #[tool(
        title = "查看运行状态",
        description = "查询标签页的运行状态：是否在运行、本次运行中各任务的状态，以及最近的日志。不会启动或停止任务；任务列表的完整内容用 get_task_list 查看。",
        annotations(title = "查看运行状态", read_only_hint = true, open_world_hint = false)
    )]
    async fn get_run_status(
        &self,
        Parameters(params): Parameters<RunStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("get_run_status", &params, DEFAULT_TIMEOUT)
            .await
    }

    #[tool(
        title = "截取设备画面",
        description = "获取标签页所连设备的当前画面截图（PNG）。不会自动连接设备：未连接时返回错误，连接由 start_tasks 自动完成。",
        annotations(title = "截取设备画面", read_only_hint = true, open_world_hint = false)
    )]
    async fn capture_screen(
        &self,
        Parameters(params): Parameters<InstanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        // 标签页解析（默认当前选中的标签页）由前端完成
        let resolved = match self
            .bridge
            .call(
                "resolve_tab",
                serde_json::to_value(&params).unwrap_or_default(),
                DEFAULT_TIMEOUT,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let Some(instance_id) = resolved.get("tab_id").and_then(|v| v.as_str()) else {
            return Ok(CallToolResult::error(vec![Content::text(texts::error(
                "tabResolveFailed",
                "无法解析标签页",
                &[],
            ))]));
        };

        Ok(
            match screen::capture_png_base64(&self.maa_state, instance_id).await {
                Ok(b64) => CallToolResult::success(vec![Content::image(b64, "image/png")]),
                Err(e) => CallToolResult::error(vec![Content::text(e)]),
            },
        )
    }
}

/// 参数说明在语言包 `params` 中的 key（同名参数在不同工具里含义不同时单独区分）
fn param_text_key(tool: &str, param: &str) -> String {
    match (tool, param) {
        ("add_task", "options") => "options_add".into(),
        ("update_task", "options") => "options_update".into(),
        ("add_task", "enabled") => "enabled_add".into(),
        ("update_task", "enabled") => "enabled_update".into(),
        ("start_tasks", "task_id") => "task_id_start".into(),
        _ => param.into(),
    }
}

/// 用当前界面语言替换工具的标题、描述与参数说明；没有翻译时保留代码中的中文
fn localize_tool(mut tool: Tool) -> Tool {
    let name = tool.name.to_string();
    if let Some(title) = texts::get(&["tools", &name, "title"]) {
        if let Some(annotations) = tool.annotations.as_mut() {
            annotations.title = Some(title.clone());
        }
        tool.title = Some(title);
    }
    if let Some(description) = texts::get(&["tools", &name, "description"]) {
        tool.description = Some(description.into());
    }

    let mut schema = (*tool.input_schema).clone();
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        for (param, definition) in properties.iter_mut() {
            let Some(text) = texts::get(&["params", &param_text_key(&name, param)]) else {
                continue;
            };
            if let Value::Object(definition) = definition {
                definition.insert("description".into(), Value::String(text));
            }
        }
    }
    tool.input_schema = Arc::new(schema);
    tool
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MxuMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("mxu", self.version.clone()).with_title(self.display_title()),
            )
            .with_instructions(texts::get(&["instructions"]).unwrap_or_else(|| INSTRUCTIONS.into()))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .tool_router
            .list_all()
            .into_iter()
            .map(localize_tool)
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tool_router.get(name).cloned().map(localize_tool)
    }
}
