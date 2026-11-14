$ErrorActionPreference = 'Stop'

# Build the real library tests. Wry needs Common Controls v6 even for non-GUI tests.
$messages = & cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json
$buildExitCode = $LASTEXITCODE
$events = $messages | ForEach-Object { $_ | ConvertFrom-Json }
$events | Where-Object { $_.reason -eq 'compiler-message' -and $_.message.rendered } |
    ForEach-Object { Write-Host $_.message.rendered }
if ($buildExitCode -ne 0) { throw 'Failed to build library tests' }
$artifact = $events |
    Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'mxu_lib' -and $_.executable } |
    Select-Object -Last 1
if (-not $artifact) { throw 'Library test executable not found' }

$testDir = Join-Path $PWD 'src-tauri/target/window-target-tests'
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
$testExe = Join-Path $testDir 'window-target-tests.exe'
Copy-Item -LiteralPath $artifact.executable -Destination $testExe -Force
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$mt = Get-ChildItem -Path "$sdk/*/x64/mt.exe" |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if (-not $mt) { throw 'Windows SDK mt.exe not found' }
& $mt.FullName -nologo -manifest tests/windows/task-stop-lifecycle/test.manifest "-outputresource:$testExe;#1"
if ($LASTEXITCODE -ne 0) { throw 'Failed to embed test host manifest' }
& $testExe 'commands::window_target::tests' --nocapture
if ($LASTEXITCODE -ne 0) { throw 'Window target regressions failed' }
