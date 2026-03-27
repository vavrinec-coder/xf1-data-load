param(
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bundleRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $PSScriptRoot "out\XF1-Desktop-Companion" }
$appRoot = Join-Path $bundleRoot "app"
$envSource = Join-Path $repoRoot ".env"
$nodeSource = Join-Path $env:ProgramFiles "nodejs\node.exe"

if (-not (Test-Path $envSource)) {
  throw "Missing .env at $envSource"
}

if (-not (Test-Path $nodeSource)) {
  throw "Missing node.exe at $nodeSource"
}

if (Test-Path $bundleRoot) {
  Remove-Item -LiteralPath $bundleRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

$filesToCopy = @(
  "index.js",
  "db.js",
  "app-paths.js",
  "package.json",
  ".env"
)

foreach ($relativePath in $filesToCopy) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $relativePath) -Destination (Join-Path $appRoot $relativePath) -Force
}

Copy-Item -LiteralPath (Join-Path $repoRoot "node_modules") -Destination (Join-Path $appRoot "node_modules") -Recurse -Force
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $appRoot "node.exe") -Force

$startCmd = @'
@echo off
setlocal
set "APP_DIR=%~dp0app"
set "XF1_HOME=%LOCALAPPDATA%\XF1 Data Load"
set "LOG_DIR=%XF1_HOME%\logs"
set "RUNTIME_DIR=%XF1_HOME%\runtime"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
if exist "%RUNTIME_DIR%\xf1-companion.pid" (
  for /f %%p in (%RUNTIME_DIR%\xf1-companion.pid) do (
    tasklist /FI "PID eq %%p" | find "%%p" >nul
    if not errorlevel 1 (
      echo XF1 Desktop Companion is already running with PID %%p.
      exit /b 0
    )
  )
)
wscript.exe "%~dp0start-xf1-companion-hidden.vbs"
echo XF1 Desktop Companion started.
endlocal
'@

$stopCmd = @'
@echo off
setlocal
set "RUNTIME_DIR=%LOCALAPPDATA%\XF1 Data Load\runtime"
set "PID_FILE=%RUNTIME_DIR%\xf1-companion.pid"
if not exist "%PID_FILE%" (
  echo XF1 Desktop Companion is not running.
  exit /b 0
)
set /p XF1_PID=<"%PID_FILE%"
taskkill /PID %XF1_PID% /F >nul 2>&1
if exist "%PID_FILE%" del "%PID_FILE%" >nul 2>&1
echo XF1 Desktop Companion stopped.
endlocal
'@

$startVbs = @'
Set shell = CreateObject("WScript.Shell")
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\app"
logDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\XF1 Data Load\logs"
logFile = logDir & "\companion.log"
cmd = "cmd /c cd /d """ & appDir & """ && set ""XF1_DATA_LOAD_HOME=%LOCALAPPDATA%\XF1 Data Load"" && """ & appDir & "\node.exe"" index.js >> """ & logFile & """ 2>>&1"
shell.Run cmd, 0, False
'@

$readme = @'
# XF1 Desktop Companion

## Start

Double-click:

- `start-xf1-companion.cmd`

## Stop

Double-click:

- `stop-xf1-companion.cmd`

## Runtime location

The companion stores per-user data in:

- `%LOCALAPPDATA%\XF1 Data Load`

This includes:

- tokens
- SQLite cache
- logs

## Log file

- `%LOCALAPPDATA%\XF1 Data Load\logs\companion.log`

## Health check

When the companion is running, open:

- `http://localhost:3000/health`
'@

Set-Content -LiteralPath (Join-Path $bundleRoot "start-xf1-companion.cmd") -Value $startCmd -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "stop-xf1-companion.cmd") -Value $stopCmd -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "start-xf1-companion-hidden.vbs") -Value $startVbs -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "README.txt") -Value $readme -Encoding ASCII

Write-Host "Created companion bundle at $bundleRoot"
