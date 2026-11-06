# 新增 MXU 特殊任务指南

MXU 特殊任务是通过 MaaFramework 的 `Custom Action` 机制实现的内置功能任务（如延迟/睡眠、启动程序），不依赖项目的 pipeline 资源。

现有示例：

- `MXU_SLEEP` —— 倒计时等待指定秒数（单选项 input 示例）
- `MXU_WAITUNTIL` —— 等待到指定时间点（time 类型 input 示例）
- `MXU_LAUNCH` —— 启动外部程序（多选项 input + switch 示例）

## 架构概览

```text
用户操作 → 前端添加任务 → 生成 pipeline_override → MaaFramework 执行
                                                        ↓
                                              Rust custom action 回调
```

涉及修改的文件（按顺序）：

| 步骤 | 文件 | 职责 |
| ------ | ------ | ------ |
| 1 | `src-tauri/src/mxu_actions.rs` | 实现 Rust 回调并注册 |
| 2 | `src/types/specialTasks.ts` | 注册任务/选项定义到 `MXU_SPECIAL_TASKS` |
| 3 | `src/i18n/locales/*.ts` | 添加所有语言的翻译文本 |
| 4 | `src/utils/pipelineOverride.ts` | **无需修改**（自动复用 `collectOptionOverrides`） |
| 5 | `src/stores/appStore.ts` | **无需修改**（通用 `addMxuSpecialTask` 自动处理） |
| 6 | UI 组件 | **无需修改**（`TaskItem`/`AddTaskPanel`/`OptionEditor` 自动适配） |

## 步骤 1：实现 Rust 回调

在 `src-tauri/src/mxu_actions.rs` 中添加：

### 1a. 定义动作名称常量

```rust
const MXU_EXAMPLE_ACTION: &str = "MXU_EXAMPLE_ACTION";
```

**命名规则**：`MXU_<NAME>_ACTION`，与前端 `MXU_SPECIAL_TASKS` 中 `custom_action` 字段一致。

### 1b. 实现回调函数

```rust
extern "C" fn mxu_example_action(
    _context: *mut MaaContext,
    _task_id: MaaId,
    _current_task_name: *const c_char,
    _custom_action_name: *const c_char,
    custom_action_param: *const c_char,
    _reco_id: MaaId,
    _box_rect: *const MaaRect,
    _trans_arg: *mut c_void,
) -> MaaBool {
    let result = std::panic::catch_unwind(|| {
        let param_str = if custom_action_param.is_null() {
            warn!("[MXU_EXAMPLE] param is null");
            "{}".to_string()
        } else {
            unsafe { from_cstr(custom_action_param) }
        };

        info!("[MXU_EXAMPLE] param: {}", param_str);

        let json: serde_json::Value = serde_json::from_str(&param_str).unwrap_or_default();
        // 从 json 中读取参数并执行逻辑
        // ...

        1u8 // 返回 1 表示成功，0 表示失败
    });

    match result {
        Ok(ret) => ret,
        Err(e) => {
            log::error!("[MXU_EXAMPLE] Panic: {:?}", e);
            0
        }
    }
}

pub fn get_mxu_example_action() -> MaaCustomActionCallback {
    Some(mxu_example_action)
}
```

**关键要求**：

- 签名必须与 `MaaCustomActionCallback` 完全匹配（8 个参数 + `MaaBool` 返回值）
- 必须用 `std::panic::catch_unwind` 包裹，防止 panic 跨 FFI 边界
- `custom_action_param` 是 JSON 字符串，由前端 `pipeline_override` 中的 `custom_action_param` 字段传入

### 1c. 在 `register_all_mxu_actions` 中注册

```rust
pub fn register_all_mxu_actions(lib: &MaaLibrary, resource: *mut MaaResource) -> Result<(), String> {
    // 已有的 MXU_SLEEP 注册...

    // 注册新动作
    let action_name = to_cstring(MXU_EXAMPLE_ACTION);
    let result = unsafe {
        (lib.maa_resource_register_custom_action)(
            resource,
            action_name.as_ptr(),
            get_mxu_example_action(),
            std::ptr::null_mut(),
        )
    };
    if result != 0 {
        info!("[MXU] Custom action {} registered", MXU_EXAMPLE_ACTION);
    } else {
        warn!("[MXU] Failed to register {}", MXU_EXAMPLE_ACTION);
    }

    Ok(())
}
```

## 步骤 2：注册任务定义

在 `src/types/specialTasks.ts` 的 `MXU_SPECIAL_TASKS` 注册表中添加条目。

### 2a. 定义常量

```typescript
export const MXU_EXAMPLE_TASK_NAME = '__MXU_EXAMPLE__';
export const MXU_EXAMPLE_ENTRY = 'MXU_EXAMPLE';
export const MXU_EXAMPLE_ACTION = 'MXU_EXAMPLE_ACTION'; // 必须与 Rust 端一致
```

### 2b. 定义 TaskItem

```typescript
const MXU_EXAMPLE_TASK_DEF: TaskItem = {
  name: MXU_EXAMPLE_TASK_NAME,
  label: 'specialTask.example.label', // i18n key
  entry: MXU_EXAMPLE_ENTRY,
  option: ['__MXU_EXAMPLE_OPTION__'],
  pipeline_override: {
    [MXU_EXAMPLE_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_EXAMPLE_ACTION,
    },
  },
};
```

**说明**：

- `entry` 节点不需要预先存在于 pipeline 中，`pipeline_override` 会创建它
- MaaFramework 默认 `recognition: DirectHit`（直接命中，无需截图识别），适用于纯逻辑任务
- `label` 使用 i18n key，会被 `t()` 翻译

### 2c. 定义选项

根据需要选择选项类型：

**input 类型**（用户输入值）：

```typescript
const MXU_EXAMPLE_OPTION: InputOption = {
  type: 'input',
  label: 'specialTask.example.optionLabel',
  inputs: [
    {
      name: 'param_name',
      label: 'specialTask.example.inputLabel',
      default: '默认值',
      pipeline_type: 'int',     // 'string' | 'int' | 'bool'
      verify: '^[1-9]\\d*$',   // 可选，输入校验正则
      pattern_msg: 'specialTask.example.inputError', // 校验失败提示 i18n key
      input_type: 'file',       // PI v2.10.5: 'text' | 'file' | 'directory'
    },
  ],
  pipeline_override: {
    [MXU_EXAMPLE_ENTRY]: {
      custom_action_param: {
        param_name: '{param_name}', // 占位符，运行时替换为用户输入值
      },
    },
  },
};
```

选项定义使用 PI V2 标准字段。内置任务如需时间选择器或占位提示，请在 `src/types/specialTasks.ts` 的 `MXU_INPUT_UI` 中配置 `timePicker` / `placeholderKey`；这些是客户端内部界面配置，不从 `interface.json` 读取。

**switch 类型**（开关）：

```typescript
const MXU_EXAMPLE_SWITCH_OPTION: SwitchOption = {
  type: 'switch',
  label: 'specialTask.example.switchLabel',
  description: 'specialTask.example.switchDescription', // 可选，显示在开关下方的说明文本
  cases: [
    {
      name: 'Yes',  // 开启时的 case，name 必须是 Yes/yes/Y/y 之一
      label: 'specialTask.example.switchYes',
      pipeline_override: {
        [MXU_EXAMPLE_ENTRY]: {
          custom_action_param: { some_flag: true },
        },
      },
    },
    {
      name: 'No',   // 关闭时的 case，name 必须是 No/no/N/n 之一
      label: 'specialTask.example.switchNo',
      pipeline_override: {
        [MXU_EXAMPLE_ENTRY]: {
          custom_action_param: { some_flag: false },
        },
      },
    },
  ],
  default_case: 'No', // 默认状态
};
```

**select 类型**（下拉选择）：也完全支持，参考 ProjectInterface V2 协议的 option 定义。

**`pipeline_type` 占位符替换规则**：

- `'string'`：`"{param}"` → `"用户输入"`
- `'int'`：`"{param}"` → `123`（去掉引号，变为 JSON 数字）
- `'bool'`：`"{param}"` → `true`/`false`（去掉引号，变为 JSON 布尔值）

### 多选项任务与 pipeline_override 合并

一个任务可以引用多个选项（在 `taskDef.option` 数组中列出），每个选项独立贡献 `pipeline_override`。

> **关键限制**：MaaFramework 对同一节点的同名字段执行**完整替换**而非深合并。例如，若两个 override 都设置了 `custom_action_param`，后者会完全覆盖前者，导致先前设置的参数丢失。

`generateMxuSpecialTaskOverride` 已在前端处理此问题：它会将所有 override 对象进行**深合并**后，作为单元素数组发送给 MaaFramework。因此，多个选项可以安全地各自设置 `custom_action_param` 的不同字段：

```typescript
// 任务定义引用两个选项
option: ['__MXU_EXAMPLE_OPTION__', '__MXU_EXAMPLE_SWITCH_OPTION__'],

// Input 选项的 pipeline_override 贡献：
{ MXU_EXAMPLE: { custom_action_param: { program: "xxx", args: "yyy" } } }

// Switch 选项的 pipeline_override 贡献：
{ MXU_EXAMPLE: { custom_action_param: { wait_for_exit: true } } }

// 前端深合并后发送给 MaaFramework 的实际内容（单元素数组）：
[{ MXU_EXAMPLE: { action: "Custom", custom_action: "...", custom_action_param: { program: "xxx", args: "yyy", wait_for_exit: true } } }]
```

**注意**：

- 此深合并仅在 MXU 特殊任务中生效（`generateMxuSpecialTaskOverride`），普通 PI V2 任务仍按原始数组格式发送。
- 深合并仅对对象类型递归合并；若两个 override 在同一路径下设置了非对象值（如字符串、数组），后者会覆盖前者。
- 普通 PI V2 任务的选项设计需自行避免对同一字段的重复设置，因为 MaaFramework 不会深合并。

### 2d. 注册到 `MXU_SPECIAL_TASKS`

```typescript
export const MXU_SPECIAL_TASKS: Record<string, MxuSpecialTaskDefinition> = {
  [MXU_SLEEP_TASK_NAME]: { /* 已有 */ },

  [MXU_EXAMPLE_TASK_NAME]: {
    taskName: MXU_EXAMPLE_TASK_NAME,
    entry: MXU_EXAMPLE_ENTRY,
    taskDef: MXU_EXAMPLE_TASK_DEF,
    optionDefs: {
      __MXU_EXAMPLE_OPTION__: MXU_EXAMPLE_OPTION,
    },
    iconName: 'Zap',                    // lucide-react 图标名
    iconColorClass: 'text-accent/80',   // Tailwind CSS 颜色类
  },
};
```

**`iconName` 可选值**：`'Clock'` | `'Zap'` | `'Bell'` | `'Timer'` | `'Pause'` | `'Play'`（见 `MxuSpecialTaskDefinition` 类型定义，如需新增图标需同步修改类型和 `AddTaskPanel.tsx` 中的 `ICON_MAP`）。

## 步骤 3：添加 i18n 翻译

在 **所有** 语言文件（`src/i18n/locales/`）的 `specialTask` 对象中添加：

```typescript
specialTask: {
  sleep: { /* 已有 */ },
  example: {
    label: '任务显示名称',
    optionLabel: '选项组标题',
    inputLabel: '输入框标签',
    inputError: '输入校验失败提示',
  },
},
```

必须同步更新的文件：`zh-CN.ts`, `en-US.ts`, `zh-TW.ts`, `ja-JP.ts`, `ko-KR.ts`。

## 命名约定速查

| 项目 | 格式 | 示例 |
| ------ | ------ | ------ |
| 任务名称常量 | `__MXU_<NAME>__` | `__MXU_SLEEP__` |
| 入口节点 | `MXU_<NAME>` | `MXU_SLEEP` |
| 动作名称 | `MXU_<NAME>_ACTION` | `MXU_SLEEP_ACTION` |
| 选项 key | `__MXU_<NAME>_<用途>_OPTION__` | `__MXU_LAUNCH_WAIT_OPTION__` |
| i18n 前缀 | `specialTask.<name>.` | `specialTask.sleep.label` |

**选项 key 命名说明**：选项 key 只需以 `__MXU_` 开头且全局唯一即可，不要求与任务名严格对应。系统通过 `findMxuOptionByKey()` 遍历所有注册的特殊任务来反查选项定义，因此命名可以灵活描述用途，例如 `__MXU_LAUNCH_OPTION__`（程序设置）和 `__MXU_LAUNCH_WAIT_OPTION__`（等待设置）。

## 无需手动处理的部分

以下逻辑已通用化，注册到 `MXU_SPECIAL_TASKS` 后自动生效：

- **Pipeline Override 生成**：`generateMxuSpecialTaskOverride` 复用 `collectOptionOverrides`，自动处理所有选项类型（input / switch / select 及嵌套选项）
- **任务添加/删除**：`addMxuSpecialTask` 根据注册表初始化选项值
- **UI 渲染**：`TaskItem` / `AddTaskPanel` / `OptionEditor` 检测 `__MXU_` 前缀自动适配
- **选项定义查找**：`OptionEditor` 通过 `findMxuOptionByKey()` 遍历所有特殊任务反查选项定义，无需选项 key 与任务名严格对应
- **i18n 翻译**：选项的 `label`、`description`、`pattern_msg` 等字段均通过 `t()` 翻译
- **配置持久化**：`appStore` 中的配置恢复逻辑通过 `isMxuSpecialTask` 正确保留选项值
- **任务校验**：配置加载时通过 `MXU_SPECIAL_TASKS` key 集合判断任务有效性
