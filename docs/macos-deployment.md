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

脚本读取宿主 `CFBundleIdentifier` 进行本地 ad-hoc 签名，并验证整个应用包及签名标识；通过布局检查后，已经有效且标识一致的签名保持不变。签名后必须重新启动应用，不能继续使用替换前的运行进程。正式分发仍应使用项目自己的签名流程。

如果宿主依赖 entitlements，应在替换可执行文件**之前**保存原权限，并明确传入修复脚本：

```bash
# 替换前保存到应用包之外
codesign --display --entitlements :- /Applications/MaaEnd.app > ~/MaaEnd-entitlements.plist
# 替换后使用保存的权限
node scripts/macos-resign.mjs --repair-layout --entitlements ~/MaaEnd-entitlements.plist /Applications/MaaEnd.app
```

没有指定权限文件时，脚本检查当前可执行文件；发现已有权限或无法检查时停止，不静默丢弃权限。已经替换掉的原始宿主权限无法从新二进制推断，需要从原始应用或项目签名配置取得。ad-hoc 签名不能替代需要开发者身份或 provisioning profile 的分发签名。

## 便携目录与签名

`Contents/MacOS` 是代码目录。把 `config/maa_option.json`、`interface.json`、模型等数据放在其中，会使 `codesign` 报 `code object is not signed at all / In subcomponent: ...json`，此时整个 `.app` **并未签名成功**。

`--repair-layout` 按 Apple TN2206 的兼容方案处理：

- 逐文件把只读资源移到 `Contents/Resources/MXU-portable/`，在原位置创建包内相对符号链接。例如 `Contents/MacOS/interface.json` 指向 `../Resources/MXU-portable/interface.json`，原目录层次和 JSON 内容不变。
- 保持主程序和 Mach-O Agent/动态库的实际位置，避免破坏 `@loader_path` 和原有启动路径；混合目录只迁移数据项。已有符号链接不会被随意移动。
- 先检查全部目标路径和嵌套代码签名，遇到重名资源或包外链接时停止，不覆盖已有数据，也不对 JSON 执行签名。嵌套 Agent/框架的有效签名保持不变。
- 使用原子的硬链接创建目标，再替换原位置为兼容链接；目标在检查后被其他进程创建时也不会覆盖它。
- 在应用旁的 `<应用名>.app.mxu-repair/` 持久化迁移计划、主程序和原签名；迁移或签名失败会恢复原布局及文件。进程被终止后，再次运行相同修复命令会先恢复未完成的事务，再重新检查和签名。恢复失败时保留目录并报错，不能删除其中的恢复副本。
- 使用 macOS 内核文件锁串行化同一应用包的修复。`.app.mxu-repair.lock` 文件会保留，但锁在进程结束后自动释放；不要在修复运行期间删除锁文件。成功后清理恢复目录。

MXU 自身的配置、日志和 Toolkit 用户数据仍写入 `~/Library/Application Support/MXU/`。脚本拒绝迁移或重新封存已知可变数据，例如 `config`、`data`、`debug`、`logs`、`cache`、`userdata` 目录和日志/数据库文件，包括旧版本已迁移到 `MXU-portable` 的这些条目。先将需要保留的运行数据备份到应用包外，并让宿主或 Agent 使用应用支持目录；历史遗留、已经不用的运行数据也应从包中移出后再签名。脚本不会自动改变 Agent 的配置路径。

仅靠文件名无法识别全部可写资源。项目维护者仍需确认其他资源在运行时保持只读；包内只保留不可变的程序、模型和配置模板。

## 更新应用

应用内更新不会覆盖 macOS `.app` 内部的文件，包括全量更新、增量更新和失败兜底目录；下载包保留供手动安装。直接打开 DMG 安装程序和包外便携目录的更新流程保留。请退出应用，安装完整的新应用包；手动替换文件时，在启动前重新运行上述签名流程。

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
