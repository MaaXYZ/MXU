# Native task stop/restart regression (Windows x64)

This regression exercises the production task submission and callback handlers
against a real MaaFramework DLL, using a custom controller instead of a device.
It covers rejected posts, an entirely rejected batch without callbacks, Agent
PostStop, a late stop marker, repeated Stop followed immediately by Start, and
disconnect during Stop (including Stop after the last ordinary callback). It
also covers normal append, a completion worker already pending during append,
Start admission before idle recovery, repeated state reads, and destroy/recreate
with the same instance ID. Child process cleanup is checked with an independent
Windows process handle.

Requirements: Python 3.12+, the Rust/MSVC toolchain and Windows SDK (`mt.exe`),
WebView2 runtime, cached Cargo dependencies (when using `--offline`), and an
extracted Windows x64 MaaFramework SDK. Keep the SDK's DLLs together; the suite
has been verified with v5.16.0. No device, running MXU, or frontend build is needed.

From the repository root:

```powershell
python tests/windows/task-stop-lifecycle/run_native.py . C:/SDK/maa/bin/MaaFramework.dll native-stop.log --offline
```

The runner copies the backend to a temporary directory, injects the test there,
and embeds the included Common Controls v6 manifest in a copy of its executable.
This keeps the Wry test host out of ordinary `cargo test` runs. Build and execution
deadlines are 10 minutes and 60 seconds; the controlled child exits within 15
seconds even if an assertion fails. Cargo artifacts remain under
`src-tauri/target/native-stop-lifecycle`; override this with `--target-dir` to reuse
another cache. `--ref <commit>` tests the backend at a specific Git revision.

The fixture invokes native PostStop directly to model Agent-initiated stopping.
The append-await scenario holds the real submission permit and registers native
posts directly, reproducing the state at the end of Agent registration; it does
not launch an AgentIPC application or verify a physical controller.
The Web polling regressions run separately via `pnpm test`.
