"""Run MXU's pretask commands with real child processes, without starting the app."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib


fixture = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("repo", nargs="?", type=Path, default=fixture.parents[1],
                    help="MXU checkout (defaults to this script's repository)")
parser.add_argument("--ref", help="Read source from a Git revision instead of the working tree")
parser.add_argument("--offline", action="store_true", help="Use only cached Cargo dependencies")
args = parser.parse_args()
repo = args.repo.resolve()


def read_repo(path):
    if args.ref:
        return subprocess.check_output(
            ["git", "-C", str(repo), "show", f"{args.ref}:{path}"], encoding="utf-8"
        )
    return (repo / path).read_text(encoding="utf-8")


def source(name):
    return read_repo("src-tauri/src/" + name)


def function(code, marker):
    start = code.index(marker)
    # MXU formats each top-level function's closing brace at column zero.
    return code[start:code.index("\n}", start) + 2]


packages = tomllib.loads(read_repo("src-tauri/Cargo.lock"))["package"]


def locked_version(name):
    versions = {package["version"] for package in packages if package["name"] == name}
    if len(versions) != 1:
        raise ValueError(f"Expected one locked version of {name}, found {versions}")
    return versions.pop()


system = source("commands/system.rs")
types = source("commands/types.rs")
field = next(line for line in types.splitlines() if "pub pre_action_stop_requests:" in line)
control_types = ""
if "PreActionStops" in field:
    control_types = source("commands/pre_action_stops.rs")

with tempfile.TemporaryDirectory(prefix="mxu-pretask-regression-") as temp:
    project = Path(temp)
    src = project / "src"
    src.mkdir()
    shutil.copy(fixture / "harness.rs", src / "main.rs")
    (src / "control.rs").write_text(control_types, encoding="utf-8")
    (src / "state.rs").write_text(
        "#[derive(Default)] pub struct MaaState {\n" + field + "\n}", encoding="utf-8"
    )
    (src / "commands.rs").write_text(
        "\n\n".join(function(system, marker) for marker in (
            "pub fn set_pre_action_stop(", "pub async fn run_action(", "pub async fn run_pretask_impl("
        )), encoding="utf-8"
    )
    (src / "web.rs").write_text(
        function(source("web_server.rs"), "async fn handle_stop_pretask("), encoding="utf-8"
    )
    (src / "launch.rs").write_text(
        function(source("commands/utils.rs"), "pub fn build_launch_command("), encoding="utf-8"
    )
    (project / "Cargo.toml").write_text(
        '[package]\nname="pretask-fixture"\nversion="0.1.0"\nedition="2021"\n'
        '[dependencies]\n'
        f'tokio={{version="={locked_version("tokio")}", features=["rt","time","sync"]}}\n'
        f'serde_json="={locked_version("serde_json")}"\n'
        f'shell-words="={locked_version("shell-words")}"\n',
        encoding="utf-8"
    )
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(project / "target")
    cargo_flags = ["--quiet"] + (["--offline"] if args.offline else [])
    print("Source:", args.ref or "working tree", repo, flush=True)
    subprocess.run(["cargo", "build", *cargo_flags], cwd=project, env=env,
                   check=True, timeout=180)
    if control_types:
        subprocess.run(["cargo", "test", *cargo_flags], cwd=project, env=env,
                       check=True, timeout=180)
    binary = project / "target/debug" / ("pretask-fixture.exe" if os.name == "nt" else "pretask-fixture")
    result = subprocess.run([str(binary)], cwd=project, timeout=30, check=False)
    raise SystemExit(result.returncode)
