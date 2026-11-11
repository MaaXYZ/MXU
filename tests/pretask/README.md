# Pretask cancellation regression

From the repository root, with Python 3.11+ and Rust 1.89+:

```sh
python tests/pretask/run.py
# Use cached Cargo dependencies without accessing the network:
python tests/pretask/run.py --offline
# Check a revision before the fix; cancellation assertions should fail:
python tests/pretask/run.py --offline --ref <revision>
```

The runner copies the selected checkout's actual `run_pretask_impl`, `run_action`,
desktop/Web stop setters, cancellation registry, and launch-command builder into
a temporary Rust crate. It uses the direct dependency versions in that checkout's
Cargo.lock. App handles, event/log sinks, and HTTP wrappers are stubbed; command
logic and child-process operations are unchanged. This does not exercise Tauri,
HTTP transport, or a real Maa resource.

The child is the fixture executable itself. A ready file and a manually polled
future hold the first command inside its wait loop while Stop, reset, and a new
command complete. This deterministically checks that resetting the next run does
not erase the first run's cancellation. Other cases cover ordinary Stop,
redundant reset, stopping before spawn, instance isolation, normal exit codes,
and cancellation of a user-configured pre-action wait without killing its program.
An exclusive file lock checks that a canceled managed child has exited before
the command returns. Each waiting child also exits on its own after four seconds;
the runner has build and execution timeouts and keeps artifacts in a temporary
directory.

The registry's unit tests also run in the fixture and remain available through
the application's normal `cargo test --lib` suite. This standalone fixture is
useful when app linking or Windows app-manifest setup prevents running that suite.
