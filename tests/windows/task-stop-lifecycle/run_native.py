"""Build the native regression in a scratch copy of a checkout and run it with a deadline."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def copy_backend(checkout, dest, ref):
    if ref:
        archive = dest / "source.tar"
        subprocess.run(["git", "archive", "-o", archive, ref, "src-tauri"], cwd=checkout, check=True)
        with tarfile.open(archive) as source:
            source.extractall(dest, filter="data")
        return
    names = subprocess.check_output(
        ["git", "ls-files", "-co", "--exclude-standard", "-z", "--", "src-tauri"], cwd=checkout
    ).decode().split("\0")
    for name in filter(None, names):
        if (checkout / name).is_file():
            (dest / name).parent.mkdir(exist_ok=True, parents=True)
            shutil.copyfile(checkout / name, dest / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("dll", type=Path, help="MaaFramework.dll from the Windows x64 SDK")
    parser.add_argument("log", type=Path)
    parser.add_argument("--ref", help="copy this Git ref instead of working files")
    parser.add_argument("--target-dir", type=Path, help="reusable isolated Cargo target directory")
    parser.add_argument("--offline", action="store_true", help="use only cached Cargo dependencies")
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parent
    checkout = args.checkout.resolve(strict=True)
    dll = args.dll.resolve(strict=True)
    target = (args.target_dir or checkout / "src-tauri/target/native-stop-lifecycle").resolve()
    args.log = args.log.resolve()
    args.log.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mxu-native-stop-") as scratch:
        scratch = Path(scratch)
        copy_backend(checkout, scratch, args.ref)
        tests = scratch / "src-tauri/tests"
        tests.mkdir(exist_ok=True)
        shutil.copyfile(fixtures / "native_stop_restart.rs", tests / "native_stop_restart.rs")
        result = subprocess.run(
            ["cargo", "test", "--locked", "--test", "native_stop_restart", "--no-run",
             "--message-format=json", "--target-dir", target,
             *(["--offline"] if args.offline else [])],
            cwd=tests.parent, capture_output=True, timeout=600,
        )
        messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith(b"{")]
        if result.returncode:
            for msg in messages:
                if msg.get("reason") == "compiler-message":
                    print(msg["message"]["rendered"])
            print(result.stderr.decode(errors="replace"))
            raise SystemExit(result.returncode)
        exe = next(m["executable"] for m in messages if m.get("target", {}).get("name") == "native_stop_restart" and m.get("executable"))
        # The Wry test host requires Common Controls v6. Embed its manifest in a scratch copy.
        test_exe = scratch / "native-stop.exe"
        shutil.copyfile(exe, test_exe)
        sdk = Path(os.environ["ProgramFiles(x86)"]) / "Windows Kits/10/bin"
        mt = max(sdk.glob("*/x64/mt.exe"), key=lambda p: tuple(map(int, p.parents[1].name.split("."))))
        manifest = fixtures / "test.manifest"
        subprocess.run([mt, "-nologo", "-manifest", manifest, f"-outputresource:{test_exe};#1"], check=True, timeout=10)
        env = dict(os.environ, MXU_TEST_MAA_DLL=str(dll), PATH=str(dll.parent) + os.pathsep + os.environ["PATH"])
        with args.log.open("wb") as log:
            result = subprocess.run(
                [test_exe, "--exact", "native_stop_restart", "--nocapture"],
                env=env, cwd=scratch, stdout=log, stderr=subprocess.STDOUT, timeout=60,
            )
    output = args.log.read_text(encoding="utf-8", errors="replace")
    for line in output.splitlines():
        if line.startswith(("Framework ", "All rejected:", "Normal append:", "After terminal callback:", "Append after terminal callback:", "Replacement:", "single=", "test result:", "thread '", "assertion ", " right:", "  left:")):
            print(line)
    if "1 passed" not in output:
        raise SystemExit(result.returncode or 1)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
