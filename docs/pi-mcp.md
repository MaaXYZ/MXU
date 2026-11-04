# PI MCP 使用与迁移

MXU 按 [MaaFramework #1601](https://github.com/MaaXYZ/MaaFramework/pull/1601) 中的 PI MCP 1.0 提案提供 MCP 工具。协议提案仍在审阅中，后续调整会同步适配。

## 启用

在「设置 → Web 与 AI」中启用 Web 服务和 AI 助手。服务默认关闭；任务执行和截图各有独立开关，默认均关闭。升级后保留已有服务开关，但首次使用新功能时需要分别授权执行和截图。

连接地址继续使用设置页显示的本机 HTTP 地址，例如 `http://127.0.0.1:12701/mcp`。端口取决于实际 Web 服务配置。MCP 只接受本机连接，打开局域网 WebUI 不会将 MCP 开放到局域网。HTTP 来源检查不能代替对本机程序的信任；仅向信任的本地 AI 客户端启用访问。

升级或修改权限后，重新连接 AI 客户端以更新工具列表。即使未授权执行，也能在单独授权截图后使用截图工具。资源作者无需修改 `interface.json`。

## 工具变化

这是一次不兼容的 MCP 接口迁移，旧接口不保留别名：

| 旧接口                                                       | PI MCP 1.0                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `list_tabs`                                                  | `list_instances`，实例标识必须显式传递，不使用当前焦点        |
| `list_available_tasks`                                       | `list_tasks`，只列出适用的 PI `task`，支持游标分页            |
| `describe_task`                                              | 返回基础取值；cases 默认收起，指定 `option_key` 后分页读取    |
| `get_task_list` / `add_task` / `update_task` / `remove_task` | 移除。直接提交一次运行，不改写保存的列表和参数                |
| `start_tasks`                                                | 接受有序任务及参数，立即返回 `run_id`，准备和运行状态均可查询 |
| `stop_tasks` / `get_run_status`                              | 必须传 `instance_id` 和 `run_id`，操作指定运行                |
| `capture_screen`                                             | 独立可选，返回 PNG、时间和像素尺寸；不会自动连接              |

预任务使用 Client 已有的本地配置，随正常启动流程处理。MXU 特殊任务不出现在 PI MCP 的任务目录中。正常的 UI 任务管理功能继续使用原有流程。

## 调用流程

1. `list_instances` 返回 `pi_mcp_version: "1.0"`、实例信息及 `context_revision`。实例标识由本次服务生成，和 UI 内部标签页 ID 分开。
2. `list_tasks` 找到任务，再用 `describe_task` 查看选项和基础取值。使用 PI 的 `name` 和选项键，不传显示标签。列表/选项的 `limit` 默认为 50，上限为 100。
3. 用户明确要求执行后，调用 `start_tasks`：

```json
{
  "instance_id": "从 list_instances 获取",
  "context_revision": "从实例或选项描述获取",
  "request_id": "caller-intent-42",
  "tasks": [
    {
      "name": "FarmStage",
      "option": {
        "Stage": "Stage4",
        "Times": { "count": "3" }
      }
    }
  ]
}
```

这里的任务、选项和 case 名称需要替换为项目实际声明的内容。接受后立即返回：

```json
{ "run_id": "run-id", "state": "starting" }
```

4. 用 `get_run_status({instance_id, run_id})` 查询。状态为 `starting`、`running`、`stopping`、`succeeded`、`failed` 或 `stopped`。日志默认取最近 20 条，可用返回的游标作为 `after` 增量读取；日志被裁剪时设置 `logs_truncated`。
5. 停止使用 `stop_tasks({instance_id, run_id})`。`stopping` 表示尚在取消/清理；只有启动流程和 Tasker 工作结束后才进入终态。

## 参数与运行规则

- 参数格式沿用 PI preset：select/switch 传实际 `case.name`，checkbox 传不重复的名称数组，input/hotkey 传字段到字符串的对象。数字和布尔值不再自动转成字符串，switch 不再接受布尔值或额外别名。
- 子选项按最终父选项选择验证，与 JSON 键顺序无关。全部任务及参数通过校验后才开始准备，不部分执行非法请求。
- 基础值使用该实例中唯一的同名任务配置，未配置时使用 PI 默认值。同名 UI 任务有不同参数时返回 `configuration_required`，需要先明确本地基准，不能猜测其中一项。
- 传入参数仅覆盖本次快照。全局、资源、控制器级选项、预任务和前置程序沿用本地配置；MCP 不提供这些持久配置的修改接口。
- 密码值、密文、掩码占位符和密码默认值均不回传。MCP 拒绝写入密码字段；缺少凭据时应在 Client 本地填写。
- 任务按请求顺序逐个提交，同名任务可以带不同参数重复出现。失败后不再提交后续任务，运行中也不追加任务。UI 中新增的任务仍可保存为以后使用，但不会加入当前 MCP 运行。
- 同一实例的桌面、WebUI、快捷键、定时任务和 MCP 启动共用后端占用记录。停止启动中的运行会阻断后续启动步骤；其他实例的停止独立处理。旧运行的停止请求不会停止后来的运行。
- 每次准备使用已接受的配置快照，之后的配置修改不改变该运行。MCP 临时任务完成时不会清除保存列表中的单次运行标记。

## 超时与保留范围

启动结果未知时，使用原参数和同一 `request_id` 重试；重试返回同一运行，不重新执行。同一标识配不同参数会返回 `request_conflict`。连接断开、请求取消和调用超时不表示任务已取消。

运行及去重记录仅在当前服务生命周期内保留，服务重启后需要重新发现实例并核实先前结果，不自动重放未知请求。正常关闭实例前先停止并等待清理完成。

当前进程保留最多 1000 个运行记录，每次运行最多保留 500 条日志；分页游标最多保留 1000 个。达到运行记录上限后拒绝新启动，不通过遗忘请求标识来允许重复执行。终态仅保留脱敏结果，释放包含本地凭据的执行快照。

## 开发验证

```bash
pnpm test
pnpm build
pnpm format:check
cd src-tauri
cargo test --locked --lib
```

自动测试覆盖实际 MCP 桥接的配置隔离、版本/分页、重试去重、停止准备流程、失败后中止序列、密码限制、权限独立性以及后端跨入口占用。设备连接与截图仍需在资源项目中实机验证。
