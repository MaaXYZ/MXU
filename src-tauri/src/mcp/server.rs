//! PI MCP 1.0: explicit instances and immutable, asynchronous runs.
use super::{bridge::McpBridge, screen, texts};
use crate::commands::{app_config::AppConfigState, types::MaaState};
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock as Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::schemars::{self, JsonSchema};
use rmcp::service::RequestContext;
use rmcp::{tool, tool_handler, tool_router, ErrorData, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstanceParams {
    #[schemars(length(min = 1))]
    pub instance_id: String,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListTaskParams {
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DescribeTaskParams {
    pub instance_id: String,
    pub task_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunTask {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option: Option<serde_json::Map<String, Value>>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StartTasksParams {
    pub instance_id: String,
    pub context_revision: String,
    pub request_id: String,
    #[schemars(length(min = 1))]
    pub tasks: Vec<RunTask>,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunParams {
    pub instance_id: String,
    pub run_id: String,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunStatusParams {
    pub instance_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
}

#[derive(Clone)]
pub struct MxuMcpServer {
    bridge: Arc<McpBridge>,
    maa_state: Arc<MaaState>,
    app_config: Arc<AppConfigState>,
    version: String,
    tool_router: ToolRouter<Self>,
}

fn tool_allowed(name: &str, execution: bool, screenshot: bool) -> bool {
    match name {
        "start_tasks" | "stop_tasks" => execution,
        "capture_screen" => screenshot,
        _ => true,
    }
}

fn allowed(name: &str) -> bool {
    super::is_mcp_enabled()
        && tool_allowed(
            name,
            super::execution_enabled(),
            super::screenshot_enabled(),
        )
}

fn json_result(data: &Value, failed: bool) -> CallToolResult {
    let content = vec![Content::text(data.to_string())];
    let mut result = if failed {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    };
    result.structured_content = Some(data.clone());
    result
}

fn failure(code: &str) -> CallToolResult {
    let message = texts::get(&["errors", code]).unwrap_or_else(|| code.to_string());
    json_result(&json!({"error": {"code": code, "message": message}}), true)
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
    fn display_title(&self) -> String {
        let project = self
            .app_config
            .project_interface
            .lock()
            .ok()
            .and_then(|pi| {
                let pi = pi.as_ref()?;
                let name = pi.get("name")?.as_str()?;
                Some(name.to_string())
            });
        project
            .map(|name| format!("MXU - {name}"))
            .unwrap_or_else(|| "MXU".into())
    }
    async fn forward<P: Serialize>(
        &self,
        op: &str,
        params: &P,
    ) -> Result<CallToolResult, ErrorData> {
        if !allowed(op) {
            return Ok(failure("permission_denied"));
        }
        let args = serde_json::to_value(params)
            .map_err(|_| ErrorData::invalid_params(op.to_owned(), None))?;
        for field in [
            "instance_id",
            "request_id",
            "context_revision",
            "run_id",
            "task_name",
        ] {
            if args
                .get(field)
                .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
            {
                return Err(ErrorData::invalid_params(field, None));
            }
        }
        match self.bridge.call(op, args, TIMEOUT).await {
            Ok(data) => Ok(json_result(&data, false)),
            Err(reason) => {
                let detail = serde_json::from_str::<Value>(&reason)
                    .ok()
                    .filter(|value| value.get("code").is_some());
                Ok(detail
                    .map(|error| json_result(&json!({"error": error}), true))
                    .unwrap_or_else(|| failure("execution_failed")))
            }
        }
    }
}

#[tool_router]
impl MxuMcpServer {
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_instances(
        &self,
        Parameters(_params): Parameters<EmptyParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("list_instances", &json!({})).await
    }
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_tasks(
        &self,
        Parameters(params): Parameters<ListTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("list_tasks", &params).await
    }
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn describe_task(
        &self,
        Parameters(params): Parameters<DescribeTaskParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("describe_task", &params).await
    }
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = true,
        idempotent_hint = true,
        open_world_hint = true
    ))]
    async fn start_tasks(
        &self,
        Parameters(params): Parameters<StartTasksParams>,
    ) -> Result<CallToolResult, ErrorData> {
        if params.tasks.is_empty() {
            return Err(ErrorData::invalid_params("tasks", None));
        }
        self.forward("start_tasks", &params).await
    }
    #[tool(annotations(read_only_hint = false, idempotent_hint = true, open_world_hint = true))]
    async fn stop_tasks(
        &self,
        Parameters(params): Parameters<RunParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("stop_tasks", &params).await
    }
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_run_status(
        &self,
        Parameters(params): Parameters<RunStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        self.forward("get_run_status", &params).await
    }
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn capture_screen(
        &self,
        Parameters(params): Parameters<InstanceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        if !allowed("capture_screen") {
            return Ok(failure("permission_denied"));
        }
        let resolved = self.forward("resolve_instance", &params).await?;
        if resolved.is_error == Some(true) {
            return Ok(resolved);
        }
        let Some(backend_id) = resolved
            .structured_content
            .as_ref()
            .and_then(|value| value.get("backend_instance_id"))
            .and_then(Value::as_str)
        else {
            return Ok(failure("instance_not_found"));
        };
        // Recheck after the bridge await: permissions can change while resolving the instance.
        if !allowed("capture_screen") {
            return Ok(failure("permission_denied"));
        }
        let capture = match screen::capture_png(&self.maa_state, backend_id).await {
            Ok(capture) => capture,
            Err(screen::CaptureError::NotConnected) => return Ok(failure("not_connected")),
            Err(screen::CaptureError::Failed) => return Ok(failure("execution_failed")),
        };
        let data = json!({"instance_id": params.instance_id, "captured_at": capture.captured_at,
            "width": capture.width, "height": capture.height});
        let mut result = json_result(&data, false);
        result
            .content
            .push(Content::image(capture.base64, "image/png"));
        Ok(result)
    }
}

fn localize_tool(mut tool: Tool) -> Tool {
    let name = tool.name.to_string();
    if let Some(title) = texts::get(&["tools", &name, "title"]) {
        tool.title = Some(title);
    }
    if let Some(description) = texts::get(&["tools", &name, "description"]) {
        tool.description = Some(description.into());
    }
    let mut schema = (*tool.input_schema).clone();
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        for (key, definition) in properties {
            if let (Some(description), Some(object)) =
                (texts::get(&["params", key]), definition.as_object_mut())
            {
                object.insert("description".into(), Value::String(description));
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
                Implementation::new("mxu-pi-mcp", self.version.clone())
                    .with_title(self.display_title()),
            )
            .with_instructions(texts::get(&["instructions"]).unwrap_or_default())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(
            self.tool_router
                .list_all()
                .into_iter()
                .filter(|tool| allowed(tool.name.as_ref()))
                .map(localize_tool)
                .collect(),
        ))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        if !allowed(name) {
            return None;
        }
        self.tool_router.get(name).cloned().map(localize_tool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permissions_are_independent() {
        assert!(tool_allowed("capture_screen", false, true));
        assert!(!tool_allowed("start_tasks", false, true));
        assert!(!tool_allowed("capture_screen", true, false));
        assert!(tool_allowed("get_run_status", false, false));
    }
    #[test]
    fn only_profile_tools_are_registered() {
        let mut names: Vec<String> = MxuMcpServer::tool_router()
            .list_all()
            .iter()
            .map(|tool| tool.name.to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "capture_screen",
                "describe_task",
                "get_run_status",
                "list_instances",
                "list_tasks",
                "start_tasks",
                "stop_tasks"
            ]
        );
    }
    #[test]
    fn legacy_and_incomplete_start_parameters_are_rejected() {
        assert!(serde_json::from_value::<StartTasksParams>(json!({"tab_id":"x"})).is_err());
        assert!(serde_json::from_value::<RunParams>(json!({"instance_id":"x"})).is_err());
        assert!(
            serde_json::from_value::<InstanceParams>(json!({"instance_id":"x","tab_id":"y"}))
                .is_err()
        );
    }
    #[test]
    fn results_have_matching_structured_and_text_content() {
        let data = json!({"run_id":"r","state":"starting"});
        let result = json_result(&data, false);
        assert_eq!(result.structured_content, Some(data));
        assert_ne!(result.is_error, Some(true));
    }
}
