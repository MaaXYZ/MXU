# macOS 构建与宿主应用部署

MXU 的 macOS 通知使用 `UNUserNotificationCenter` 和正在运行的 `.app` 的 `CFBundleIdentifier`。将 MXU 放入 MaaEnd 等宿主应用时，通知保留宿主身份，不替换为 MXU 的构建标识。

## 构建与替换

在 macOS 的项目根目录安装依赖并构建：

```bash
pnpm install --frozen-lockfile
pnpm tauri build --no-bundle
```

退出宿主应用，将构建出的 `src-tauri/target/release/mxu` 替换到 `.app/Contents/MacOS/`，并使用宿主 `Info.plist` 中 `CFBundleExecutable` 指定的名称。例如 MaaEnd 的目标路径为 `/Applications/MaaEnd.app/Contents/MacOS/MaaEnd`。

只替换并重命名文件会保留链接器生成的 `mxu-…` 临时签名；它没有绑定宿主的 `Info.plist` 和资源，不能作为有效的应用包签名用于现代通知授权。替换后执行：

```bash
node scripts/macos-resign.mjs --repair-layout /Applications/MaaEnd.app &&
open /Applications/MaaEnd.app
```

脚本读取宿主 `CFBundleIdentifier` 进行本地 ad-hoc 签名，并验证整个应用包及签名标识；已经有效且标识一致的签名保持不变。签名后必须重新启动应用，不能继续使用替换前的运行进程。正式分发仍应使用项目自己的签名流程。

## 便携目录与签名

`Contents/MacOS` 是代码目录。把 `config/maa_option.json`、`interface.json`、模型等数据放在其中，会使 `codesign` 报 `code object is not signed at all / In subcomponent: ...json`，此时整个 `.app` **并未签名成功**。

`--repair-layout` 按 Apple TN2206 的兼容方案处理：

- 把数据移到 `Contents/Resources/MXU-portable/`，在原位置创建包内相对符号链接。例如 `Contents/MacOS/config` 指向 `../Resources/MXU-portable/config`，原有 JSON 内容不变。
- 保持主程序和 Mach-O Agent/动态库的实际位置，避免破坏 `@loader_path` 和原有启动路径；混合目录只迁移数据项。已有符号链接不会被随意移动。
- 先检查全部目标路径和嵌套代码签名，遇到重名资源或包外链接时停止，不覆盖已有数据，也不对 JSON 执行签名。嵌套 Agent/框架的有效签名保持不变。
- 在临时目录备份主程序和原签名文件；迁移或签名失败会尝试恢复原布局及文件。若恢复失败，保留恢复副本并输出路径。成功后清理临时副本。

MXU 自身的配置、日志和 Toolkit 用户数据仍写入 `~/Library/Application Support/MXU/`。应用包内资源改变后需要重新签名；不能把仍会被写入的运行数据当成稳定的签名资源。

## 通知排查

若出现 `UNErrorDomain code=1`，先区分授权拒绝与包签名不完整：

```bash
codesign --verify --strict --verbose=2 /Applications/MaaEnd.app
codesign -d --verbose=2 /Applications/MaaEnd.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/MaaEnd.app/Contents/Info.plist
```

`code has no resources but signature indicates they must be present`、`Info.plist=not bound`、以及签名 `Identifier=mxu-…` 与宿主 `com.maaend.app` 不一致，说明需要完成上述布局修复及重签步骤。等 `codesign --verify --strict` 成功后再启动应用测试。签名验证正常时，再核对系统中实际宿主应用的通知授权。错误日志会包含失败阶段（`authorization` / `submission`）、实际 bundle ID、NSError domain 和 code。

使用 RustDesk 等屏幕共享工具时，还需开启 macOS 系统设置 → 通知 → “当镜像或共享显示器时显示通知”。这个全局选项独立于应用的横幅和声音开关；关闭时即使通知提交成功，也可能只显示在通知中心。

通知与角标的回归验证步骤见 [macOS 系统通知验证](../tests/macos/README.md)。
