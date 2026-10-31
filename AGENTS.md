# MXU 开发者与 AI 指南 (AGENTS.md)

本文档为 MXU 项目的开发规范与架构指南，旨在为人类开发者及 AI 辅助工具提供统一的代码理解与协作标准。

## 1. 项目概述

**MXU** 是一款基于 [MaaFramework ProjectInterface V2](https://github.com/MaaXYZ/MaaFramework/blob/main/docs/zh_cn/3.3-ProjectInterfaceV2协议.md) 协议的通用图形界面客户端。

- **核心目标**：实现对 MaaFramework 生态项目的零配置/低配置自动化支持。
- **技术选型**：
  - **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS
  - **Backend**: Tauri 2 (Rust) + Axum (Web 服务)
  - **State Management**: Zustand
  - **Internationalization**: Custom i18n implementation

## 2. 目录架构索引

为了快速定位功能模块，请参考以下结构：

- `src/`：前端源代码
  - `components/`：UI 组件库，按功能领域划分（如 `connection/`, `settings/`, `ui/`）。
  - `services/`：核心业务逻辑层（配置管理、自动更新、Maa 服务封装）。
  - `stores/`：基于 Zustand 的全局状态存储。
  - `i18n/`：多语言定义与本地化资源。
  - `types/`：TypeScript 类型定义，包括 PI V2 协议相关定义（`interface.ts`）和 MXU 特殊任务系统（`specialTasks.ts`）。
  - `utils/`：通用工具函数（日志、路径处理、样式助手）。
- `src-tauri/`：Rust 后端逻辑
  - `src/commands/`：Tauri 指令集，处理文件 IO、网络下载、Maa FFI 调用等底层逻辑。
  - `capabilities/`：Tauri 权限配置文件。

## 3. 开发准则与最佳实践

### 3.1 代码质量与重构

- **DRY 原则**：优先复用 `src/components/ui/` 中的原子组件及 `src/utils/` 中的工具函数。
- **适度重构**：在修改功能时，若发现冗余代码，应在确保行为一致的前提下进行抽象，保持代码库整洁。

### 3.2 国际化 (i18n)

- **严禁硬编码**：所有面向用户的文本必须定义在 `src/i18n/locales/` 中。
- **多语言一致性**：新增文本需同步更新 `zh-CN`, `en-US` 等主流语言包。

### 3.3 安全性与鲁棒性

- **更新系统 (Update Service)**：涉及 `updateService.ts` 及 Rust 端下载指令的修改需极度审慎。更新逻辑的失效会导致用户无法通过常规手段修复软件。
- **权限管理**：涉及系统资源访问（如文件系统、网络）时，需检查 `src-tauri/capabilities/default.json` 是否配置了相应权限。
- **Win32 API**：涉及 Win32 API 的调用时，请尽量使用 WinSafe Nightly 中封装好的安全 API。

### 3.4 状态管理

- **单一事实来源**：业务状态应托管于 `src/stores/`，组件通过 Selector 消费状态，避免 Props 深度传递。

## 4. 开发手册

以下手册提供特定开发场景的详细指引，**按需读取**对应文档即可：

| 场景                         | 文档                                                 | 何时阅读                                                      |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| 新增 MXU 特殊任务            | [docs/add-special-task.md](docs/add-special-task.md) | 需要添加基于 Custom Action 的内置功能任务（如延迟、通知等）时 |
| Rust feature（可选构建行为） | [docs/rust-features.md](docs/rust-features.md)       | 需要启用或新增 Cargo feature（如 `xdg-data-dir`）时           |

## 5. 相关资源

- [MaaFramework Core](https://github.com/MaaXYZ/MaaFramework)
- [ProjectInterface V2 协议文档](https://github.com/MaaXYZ/MaaFramework/blob/main/docs/zh_cn/3.3-ProjectInterfaceV2协议.md)
- [Tauri V2 Documentation](https://tauri.app/v2/)
- [Zustand Guide](https://zustand-demo.pmnd.rs/)
- [WinSafe Nightly Documentation](https://rodrigocfd.github.io/winsafe/winsafe/)
