# Screenshot lifecycle regression

Run `pnpm test:screenshots` after `pnpm install --frozen-lockfile`. This builds the
real React components, store and screenshot hook with the existing Vite dependency,
then runs them in a headless Chromium browser. Chrome, Edge and common Chromium
locations are detected; set `MXU_TEST_BROWSER` to an executable path otherwise.
The runner uses its own temporary browser profile and never opens a user profile.

The fixture replaces Maa calls and blocks network requests. Browser virtual time
covers the 30-second subscription expiry without a long wall-clock wait. It checks
lease renewal, independent subscribers, late subscription acknowledgements,
disconnect/reconnect, stale frames, tab switches, folding, pause and consecutive
capture failures. These tests do not verify native screenshot contents or real
device connectivity. They are separate from `pnpm test`, which needs no browser.

Backend lifecycle tests run without a MaaFramework DLL or a connected device:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib screenshot_service::tests
```

They cover missing instances, waiting for controllers without restarting the
capture loop, lease expiry, and retiring streams when an instance ID is reused.

On Windows, Tauri's library test executable may exit before running tests with
`STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`) because it lacks the desktop app's
Common Controls v6 manifest. From a Developer PowerShell with the Windows SDK's
`mt.exe` on `PATH`, embed the supplied manifest in a private copy of the test
executable (the Cargo artifact is left intact):

```powershell
$artifacts = cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --no-run --message-format=json | ConvertFrom-Json
if ($LASTEXITCODE) { throw 'Cargo build failed' }
$binary = $artifacts | Where-Object { $_.executable -and $_.target.name -eq 'mxu_lib' } | Select-Object -Last 1
$testCopy = Join-Path ([System.IO.Path]::GetTempPath()) "mxu-screenshot-$([guid]::NewGuid()).exe"
try {
    Copy-Item -LiteralPath $binary.executable -Destination $testCopy
    mt.exe -nologo -manifest tests/screenshots/test.manifest "-outputresource:$testCopy;#1"
    if ($LASTEXITCODE) { throw 'Manifest embedding failed' }
    & $testCopy screenshot_service::tests --nocapture
    if ($LASTEXITCODE) { throw 'Screenshot backend tests failed' }
} finally {
    Remove-Item -LiteralPath $testCopy -ErrorAction SilentlyContinue
}
```
