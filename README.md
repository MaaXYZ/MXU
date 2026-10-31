# MXU

**MXU** 是一个基于 [MaaFramework PI V2](https://github.com/MaaXYZ/MaaFramework/blob/main/docs/zh_cn/3.3-ProjectInterfaceV2%E5%8D%8F%E8%AE%AE.md) 协议的通用 GUI 客户端，使用 Tauri + React + TypeScript 构建。

它可以解析任何符合 PI V2 标准的 `interface.json` 文件，为 MaaFramework 生态中的自动化项目提供开箱即用的图形界面。

## ✨ 特性

> [!TIP]
>
> MXU 已支持最新最潮的 PI v2.5.0 协议！

- 📋 **任务管理** - 可视化配置任务列表，支持拖拽排序
- 🔧 **多实例支持** - 同时管理多个独立运行的实例（标签页多开）
- 🎮 **多控制器类型** - 支持 Adb、Win32、MacOS、Linux、PlayCover、Gamepad
- 🌍 **国际化** - 界面内置多种语言，自动加载 `interface.json` 中的翻译
- 🎨 **明暗主题** - 支持 Light/Dark 主题切换
- 📱 **实时截图** - 显示设备实时画面，可自定义帧率
- 📝 **运行日志** - 查看任务执行日志和 Agent 输出
- ⏰ **定时任务** - 支持配置定时执行策略
- 🔄 **自动更新** - 支持 MirrorChyan 和 GitHub 自动下载更新
- 🤖 **Agent 支持** - 支持 MaaAgentClient 实现自定义识别器和动作

## 🚀 快速开始

### 依赖文件

[MXU Releases](https://github.com/MistEO/MXU/releases) 中提供了单可执行文件（Windows 为 `mxu.exe`，Linux/macOS 为 `mxu`），您需要配置以下依赖：

- [MaaFramework](https://github.com/MaaXYZ/MaaFramework/releases) 运行库 ( >= `v5.12.1` ) ，将压缩包中的 `bin` 文件夹内容解压到 `maafw` 文件夹中
- [interface.json](https://github.com/MaaXYZ/MaaFramework/blob/main/sample/interface.json) 及相关资源文件，请参考 [PI 协议文档](https://github.com/MaaXYZ/MaaFramework/blob/main/docs/zh_cn/3.3-ProjectInterfaceV2%E5%8D%8F%E8%AE%AE.md) 编写

目录结构如下

```text
your-project/
├── mxu.exe (或 mxu)
├── maafw/
│   ├── MaaFramework.dll (Windows)
│   ├── MaaToolkit.dll
│   └── ... 其他依赖库
├── interface.json
└── resource/
```

随后运行 `mxu.exe`（Windows）或 `./mxu`（Linux/macOS）即可！~

### 命令行参数

MXU 支持以下启动参数：

| 参数                                  | 功能                   | 说明                                                                                                                                                        |
| ------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h` / `--help`                       | 显示帮助信息           | 输出 MXU 当前支持的命令行参数说明并退出，不启动图形界面。                                                                                                   |
| `--autostart`                         | 标记为“开机自启动”启动 | 进入开机自启动模式，并触发自动执行逻辑。该参数主要由 MXU 创建的系统自启动任务自动传入，通常无需手动设置。                                                   |
| `-i <实例名>` / `--instance <实例名>` | 指定要自动启动的实例   | 仅在 `--autostart` 模式下生效。若指定的实例名存在，则优先使用该实例，而不是设置中配置的默认自动执行实例。也支持 `-i=<实例名>`、`--instance=<实例名>` 写法。 |
| `-q` / `--quit-after-run`             | 自动执行完成后退出程序 | 当本次启动实际触发了自动执行后，等待任务结束并自动关闭 MXU，适合配合自启动场景做“一次性后台执行”。                                                          |

示例：

```bash
# 查看命令行帮助
mxu.exe --help

# 使用系统自启动模式，并指定自动执行的实例名
mxu.exe --autostart --instance "日常任务"

# 自动执行完成后自动退出
mxu.exe --autostart -i "日常任务" --quit-after-run
```

### 用户文件

用户配置保存在 `config` 文件夹中，调试日志保存在 `debug` 文件夹中。亦可在 设置 - 调试 中直接打开文件夹。

## 📖 开发调试

### 🧭 开发说明

MXU 在很大程度上属于 **vibe coding**：开发与产品决策主要由维护者的直觉、审美与真实使用场景驱动，在主观判断下保持体验一致，而不是先锁定一份长期冻结的技术蓝图或与外部共识逐条对齐。由此，仓库整体是**产品导向**而非技术导向——优先级放在**用户体验**与**运行稳定性**上；实现方式、工程「潮流」或技术细节并非讨论焦点。

关于贡献与合并预期，请事先了解：

- **缺陷修复**：欢迎直接提交 Pull Request；聚焦问题、范围清晰的修复通常更易审阅与合入。
- **新功能、重构或行为/交互层面的较大改动**：维护者会按产品方向与一致性独立判断，**不保证接受**。若未经事先沟通就投入大量开发，存在合入被拒的可能。
- **小众与极客向功能**：仅服务于极少数场景、或需要大量背景知识才能理解的价值主张，**大概率不会通过**。维护者优先面向大多数用户保持界面清晰；每多一个入口、开关或选项，都会抬高学习与决策成本，因此会刻意控制功能暴露面。
- **建议流程**：若计划增加能力或调整架构/交互，请先提交 **Issue** 说明动机、用户场景与拟定方案，与维护者对齐设计后再实现，以减少无效劳动与预期落差。

_说白了就是：怎么写、合什么，主要看维护者顺不顺眼、普通用户会不会多背一层菜单；不是堆技术秀肌肉，也没法照单全收所有点子。想上大改动先开个 Issue 对一下，比闷头做完被拒省心。_

感谢配合与理解。

### 安装依赖

**Node.js** (>= 18)

```bash
# macOS (Homebrew)
brew install node

# Windows (winget)
winget install OpenJS.NodeJS
```

**pnpm** (>= 8)

```bash
npm install -g pnpm
```

**Rust** (>= 1.70)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

<!-- markdownlint-disable MD036 -->

**项目依赖**

<!-- markdownlint-enable MD036 -->

```bash
pnpm install
```

### 开发调试

```bash
pnpm tauri dev
```

启动前端开发服务器和 Tauri 桌面应用，支持热重载。

### 生产构建

```bash
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/` 目录。

## 🤝 相关项目

- [MaaFramework](https://github.com/MaaXYZ/MaaFramework) - 基于图像识别的自动化黑盒测试框架

## 📄 License

[GNU Affero General Public License v3.0](LICENSE)

## ❤️ 鸣谢

感谢以下开发者对 MXU 作出的贡献：

[![贡献者](https://contrib.rocks/image?repo=MistEO/MXU&max=1000)](https://github.com/MistEO/MXU/graphs/contributors)

## ☕ 赞助

<!-- markdownlint-disable MD033 MD045 -->
<a href="https://afdian.com/a/misteo">
  <img width="200" src="https://pic1.afdiancdn.com/static/img/welcome/button-sponsorme.png">
</a>
<!-- markdownlint-enable MD033 MD045 -->
