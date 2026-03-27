param(
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bundleRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $PSScriptRoot "out\XF1-Desktop-Companion" }
$appRoot = Join-Path $bundleRoot "app"
$envSource = Join-Path $repoRoot ".env"
$nodeSource = Join-Path $env:ProgramFiles "nodejs\node.exe"
$zipPath = Join-Path (Split-Path -Parent $bundleRoot) "XF1-Desktop-Companion.zip"

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

$installCmd = @'
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0install-xf1-companion.ps1"
'@

$uninstallCmd = @'
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0uninstall-xf1-companion.ps1"
'@

$installPs1 = @'
$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\XF1 Desktop Companion"
$programsFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\XF1 Desktop Companion"
$desktopFolder = [Environment]::GetFolderPath("Desktop")

if (Test-Path (Join-Path $installRoot "stop-xf1-companion.cmd")) {
  & (Join-Path $installRoot "stop-xf1-companion.cmd") | Out-Null
  Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

robocopy $sourceRoot $installRoot /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$robocopyExit = $LASTEXITCODE
if ($robocopyExit -ge 8) {
  throw "robocopy failed with exit code $robocopyExit"
}

New-Item -ItemType Directory -Path $programsFolder -Force | Out-Null

$wsh = New-Object -ComObject WScript.Shell

function New-Shortcut($shortcutPath, $targetPath, $workingDir, $description) {
  $shortcut = $wsh.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $targetPath
  $shortcut.WorkingDirectory = $workingDir
  $shortcut.Description = $description
  $shortcut.Save()
}

New-Shortcut (Join-Path $programsFolder "Start XF1 Desktop Companion.lnk") (Join-Path $installRoot "start-xf1-companion.cmd") $installRoot "Start XF1 Desktop Companion"
New-Shortcut (Join-Path $programsFolder "Stop XF1 Desktop Companion.lnk") (Join-Path $installRoot "stop-xf1-companion.cmd") $installRoot "Stop XF1 Desktop Companion"
New-Shortcut (Join-Path $desktopFolder "Start XF1 Desktop Companion.lnk") (Join-Path $installRoot "start-xf1-companion.cmd") $installRoot "Start XF1 Desktop Companion"

& (Join-Path $installRoot "start-xf1-companion.cmd")

for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:3000/health"
    if ($health.ok) {
      Write-Host "XF1 Desktop Companion health check passed."
      break
    }
  } catch {
    if ($attempt -eq 14) {
      throw "Installed files copied, but the companion did not respond on http://localhost:3000/health"
    }
  }
}

Write-Host "Installed XF1 Desktop Companion to $installRoot"
'@

$uninstallPs1 = @'
$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "Programs\XF1 Desktop Companion"
$programsFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\XF1 Desktop Companion"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Start XF1 Desktop Companion.lnk"

if (Test-Path (Join-Path $installRoot "stop-xf1-companion.cmd")) {
  & (Join-Path $installRoot "stop-xf1-companion.cmd") | Out-Null
  Start-Sleep -Seconds 2
}

if (Test-Path $desktopShortcut) {
  Remove-Item -LiteralPath $desktopShortcut -Force
}

if (Test-Path $programsFolder) {
  Remove-Item -LiteralPath $programsFolder -Recurse -Force
}

if (Test-Path $installRoot) {
  cmd /c rd /s /q "$installRoot"
}

Write-Host "Uninstalled XF1 Desktop Companion from $installRoot"
Write-Host "User data under %LOCALAPPDATA%\\XF1 Data Load was kept."
'@

Set-Content -LiteralPath (Join-Path $bundleRoot "install-xf1-companion.cmd") -Value $installCmd -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "uninstall-xf1-companion.cmd") -Value $uninstallCmd -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "install-xf1-companion.ps1") -Value $installPs1 -Encoding ASCII
Set-Content -LiteralPath (Join-Path $bundleRoot "uninstall-xf1-companion.ps1") -Value $uninstallPs1 -Encoding ASCII

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $bundleRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Created companion bundle at $bundleRoot"
Write-Host "Created companion zip at $zipPath"
