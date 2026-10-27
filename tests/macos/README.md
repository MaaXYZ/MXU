# macOS 系统通知验证

运行测试前，先按 [macOS 构建与宿主应用部署](../../docs/macos-deployment.md) 准备签名有效的 `.app`。裸命令行可执行文件没有有效的应用身份时会返回明确错误，通知运行测试需要实际的 `.app`。

## 自动化验证

在项目根目录执行：

```bash
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::notification --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::utils::tests --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib commands::update::bundle_update_tests --locked
```

`macosBundleSigning.test.ts` 验证文件迁移、权限传入、可写数据拒绝、并发目标冲突、修复互斥和中断后的持久化恢复。Windows 测试使用链接与锁适配器，`codesign` 调用使用模拟结果。macOS 专用的子进程测试使用实际内核锁，验证排他性和 `SIGKILL` 后锁释放，在 Windows 上跳过。实际签名和通知仍需在 macOS 验证。

Rust 测试验证通知内容配置、未读角标状态、迁移后的资源路径边界，以及全量/增量/兜底更新和清理操作在修改 `.app` 前返回错误；同时验证包外便携目录仍可正常更新。请额外检查界面拒绝覆盖更新时显示当前语言的说明、保留下载包，以及 DMG 安装流程可用。这些测试不代替系统通知运行测试。

## 通知与角标

在系统设置中允许宿主应用的通知、横幅、声音和标记后，从该 `.app` 分别验证：

1. 应用在前台时执行“系统通知”任务：显示横幅、播放默认提示音，Dock 图标出现角标。
2. 切换到其他应用，再触发系统通知：同样显示横幅、提示音和角标；连续发送两条未读通知时角标应为 2，而非固定为 1。
3. 在通知中心逐条清除或“全部清除”：应用运行期间约 2 秒内同步剩余未读数量，清空后角标消失。
4. 点击通知或切回主窗口：相应通知标记已读；之后的周期同步不会把旧通知重新标成未读。再发送一条新通知时角标应为 1。
5. 清空通知中心后重新启动应用：清除旧版本遗留的系统角标。关闭系统的应用角标设置后，不应强制显示角标。
6. focus 的 `toast` / `notification` 渠道使用同一发送入口，保持富文本转纯文本及去重行为。

角标不再写入每条通知的 `content.badge=1`。应用使用串行工作线程核对通知中心记录，同时更新 `UNUserNotificationCenter` 的系统计数和 Dock 显示；“全部清除”没有逐条响应回调时，由周期同步补齐。启动时即进行同步，退出时停止监控。

首次调用请求 Alert、Sound、Badge 三项授权，不申请静默的 provisional 授权。系统提交失败或拒绝授权会写入 `[MXU_NOTIFY]` 日志，并让通知任务返回失败。系统的专注模式或用户关闭的提醒选项仍由 macOS 决定，不绕过它们。
