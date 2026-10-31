# Rust feature

后端 (`src-tauri`) 用 Cargo feature 承载可选行为，默认构建保持既有行为。目前只有一个：

## `xdg-data-dir`

Linux 数据目录改为 `$XDG_DATA_HOME/{项目名}`（未设置时 `~/.local/share/{项目名}`）。默认关闭，此时与 macOS/Windows 一样按 exe 所在目录存放，旧版 Linux 数据（`config/`、`debug/`、`cache/`）因此无需迁移。

```bash
pnpm tauri build --features xdg-data-dir
cd src-tauri && cargo test --features xdg-data-dir
```

- 项目名取 exe 目录下 `interface.json` 的 `name`（JSONC，缺失时 `MXU`），必须是单段目录名，否则报错。
- `XDG_DATA_HOME` 非绝对路径时被忽略；`HOME` 也无效时报错。
- 开启后配置、日志、缓存、更新包下载目录都会改变，切换构建方式后需重启客户端。

实现见 `src-tauri/src/commands/utils.rs` 的 `get_app_data_dir` / `linux_data_dir`，单测随 feature 条件编译。
