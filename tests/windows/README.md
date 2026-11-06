# Windows 启动回归验证

使用 PowerShell 7，先构建实际 MXU 可执行文件，再运行 `startup.ps1`。
Release 程序默认自提权，因此验证 Release 时请使用管理员 PowerShell，避免把提权前的父进程退出误当成应用退出。

```powershell
./tests/windows/startup.ps1 -Executable /absolute/path/to/mxu.exe -Scenario creation-failure -EvidenceDirectory /absolute/path/to/evidence
./tests/windows/startup.ps1 -Executable /absolute/path/to/mxu.exe -Scenario normal-close -EvidenceDirectory /absolute/path/to/evidence
./tests/windows/startup.ps1 -Executable /absolute/path/to/mxu.exe -Scenario hidden-window -EvidenceDirectory /absolute/path/to/evidence
./tests/windows/startup.ps1 -Executable /absolute/path/to/mxu.exe -Scenario minimize-to-tray -EvidenceDirectory /absolute/path/to/evidence
```

每个用例会复制可执行文件到独立的便携目录，并提供无任务的测试配置。
`creation-failure` 仅为测试进程指定不存在的 WebView2 运行时路径，让真正的窗口创建失败；Release 框架自带的缺失运行时提示由脚本确认，然后检查操作系统实际退出码为 1，且没有初始化托盘和后台服务。
该注入方式验证失败处理路径，并不模拟某台机器出现 `0x80070057` 的具体原因。

`repeated-startup.ps1` 覆盖短时间重复启动：每组从同一可执行文件和真实缓存目录启动两个实例，交替使用同时启动和间隔 350 毫秒启动。它不注入无效 API 参数，也不需要修改 Wry；检查两个实例都显示真实窗口、创建托盘，并能正常关闭。窗口创建阶段的 `MoveFocus` 失败在本地 WebView2 154.0.4258.62 上可通过此条件触发，其他环境中的失败频率可能不同。

```powershell
./tests/windows/repeated-startup.ps1 -Executable /absolute/path/to/MaaEnd.exe -EvidenceDirectory /absolute/path/to/evidence -Pairs 6
```

`normal-close` 检查正常关闭退出；`hidden-window` 检查有效隐藏窗口可保持运行；`minimize-to-tray` 使用完整前端加载配置，检查关闭后隐藏、进程继续运行，再向该测试进程的托盘菜单窗口发送“显示主窗口”的原生菜单命令，执行 MXU 的真实 `on_menu_event` 处理程序并等待主窗口恢复。脚本不会直接显示主窗口。当前 Windows 启动中 `show` 是第一个菜单项，锁定的 muda 0.17.1 从 1000 分配原生命令 ID；调整菜单初始化顺序或更新依赖时需检查此约定。
最后一个用例需要包含已构建前端的 Release 程序。

脚本只操作自己启动的测试 PID。失败时保留日志、结果 JSON 和超时转储；转储可能包含内存中的敏感信息，请勿直接公开上传。

## 系统通知回归验证

在 Windows 交互式桌面的项目根目录执行，可分别在普通权限和管理员 PowerShell 中验证：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::notification::windows::tests --locked -- --include-ignored --nocapture
```

测试覆盖中文与 XML 特殊字符、空正文，以及未安装的独立程序首次发送通知。最后一项会实际发送系统通知，并核对 Windows 通知历史中的标题和正文，以及来源名称和图标的注册类型；使用本次测试独有的应用标识，结束后清理测试通知、图标缓存与注册信息。它默认被忽略，普通 `cargo test` 不会弹通知。

项目名称、国际化图标路径、ICO 转 PNG 和无效图标回退的测试：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::notification::branding --locked
```

设置环境变量 `MXU_NOTIFICATION_PREVIEW=1` 后运行通知测试，会保留测试通知 15 秒供目视检查。弹窗左上角应显示 MXU 彩色图标和来源名 `MXU notification test`，而非 `com.misteo.mxu...`。实际应用的来源名称和图标来自 `interface.json` 的 `name` / `icon`；未配置时回退为 `mxu` 和 MXU 内置图标。

Windows 通知来源图标的格式约定：`icon`（含国际化解析结果）必须是项目目录内的本地 PNG 或 ICO。URL、SVG 及其他格式仍可用于前端界面，但通知来源图标会回退为 MXU 图标并记录格式提示；需要统一显示时请在项目中提供 PNG/ICO。缓存会验证实际 PNG 内容，并原子替换损坏条目。通知身份按项目所在目录区分，同名项目不会覆盖彼此的名称和图标；移动项目目录会生成新的通知身份。

锁定的 `windows-core 0.61.2` 在工厂激活遇到 `CO_E_NOTINITIALIZED` 时会调用 `CoIncrementMTAUsage` 后重试。工作线程回归测试不预先初始化 COM，分别覆盖首次激活和缓存工厂，避免通过测试准备掩盖真实入口问题。WinSafe 0.0.28 未封装 `GetUserDefaultUILanguage` / `LCIDToLocaleName`，这两项保留现有的 `windows` 调用。
