# 自启动相关

### 勾选 `设置 > 通用 > 开机自启动` 时发生了什么？

#### Windows

勾选 `开机自启动` 后，前端会调用 Tauri command `autostart_enable` 。Rust 侧会创建 Windows 计划任务：

```text
schtasks /create
  /tn MXU
  /tr "<当前 mxu.exe 路径>" --autostart
  /sc onlogon
  /delay 0000:30
  /it
  /rl highest
  /f
```

含义是：用户登录后触发，延迟 30 秒启动；以交互式桌面会话运行；请求最高权限；任务名固定为 `MXU`；如果已存在则覆盖。启动命令只带 `--autostart`，不会自动带 `--instance` 或 `--quit-after-run`。

取消勾选后会执行：

```text
schtasks /delete /tn MXU /f
```

同时清理旧版注册表自启动项：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  mxu
  MXU
```

查询开关状态时，Windows 会认为下面任意一种存在就是已启用：

```text
schtasks /query /tn MXU
```

或旧版注册表项还存在。

另外，程序每次启动时有一个迁移逻辑：如果检测到旧版注册表自启动，会自动创建新的计划任务，然后删除旧注册表项；如果已有计划任务但缺少 `InteractiveToken` 或 30 秒延迟，并且任务处于启用状态，也会自动重建成新配置。

#### macOS

MXU 使用的是：

```rust
MacosLauncher::LaunchAgent
```

所以勾选后会创建 `~/Library/LaunchAgents/mxu.plist` 。程序将会在用户登陆后自动执行。

plist 里核心字段是：

```xml
<key>Label</key>
<string>mxu</string>
<key>ProgramArguments</key>
<array>
  <string><current_exe_path></string>
  <string>--autostart</string>
</array>
<key>RunAtLoad</key>
<true/>
```

取消勾选就是删除这个 plist；是否已启用同样只看 plist 是否存在。它不是 macOS “登录项” AppleScript 方式，而是 LaunchAgent，所以不会走系统登录项 UI 的那套添加逻辑。

#### Linux

勾选后会创建 `~/.config/autostart/mxu.desktop` 。对于有 GUI 的 Linux 系统，程序将会在用户登陆后自动执行。

内容大致是：

```ini
[Desktop Entry]
Type=Application
Version=1.0
Name=mxu
Comment=mxustartup script
Exec=<app_path> --autostart
StartupNotify=false
Terminal=false
```

`<app_path>` 优先用 AppImage 路径；如果不是 AppImage，则用当前可执行文件路径。取消勾选就是删除这个 `.desktop` 文件；是否已启用只看这个文件是否存在。

### 运行 `MXU --autostart` 会发生什么？

Windows/macOS/Linux 自启动时会带 `--autostart`，因此前端启动流程会：

1. 调用 `is_autostart`，识别为自动模式。
2. 设置 `isAutoStartMode = true`。
3. 如果设置了“自动模式默认执行”的实例，就激活该实例。
4. 等更新检查流程结束后触发 `mxu-start-tasks` 开始执行。
5. 任务结束后不会自动退出，除非添加命令行参数 `--quit-after-run` 。
