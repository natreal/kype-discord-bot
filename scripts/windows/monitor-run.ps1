# ===========================================================================
# Keeps the anyPS5 monitor window open until the reader closes it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File monitor-run.ps1
#   ... -Interval 30 -NoColor -Repo owner/name   (arguments go to monitor.ts)
#
# This is the body of the window: the console `monitorctl.ps1 start` opens, and the
# one the logon task opens. It exists because `npm run monitor` on its own has two
# ways to stop being a monitor:
#
#   * it crashes (a socket error, a Node failure, an out-of-memory) and leaves a
#     console sitting on the last frame it painted, which on screen is
#     indistinguishable from a monitor whose numbers happen to be old. Here the
#     window says it is restarting, and then restarts;
#   * it exits 0 because the reader pressed `q`, which is a request to leave. So a
#     clean exit closes the window rather than being undone a second later.
#
# The backoff starts at five seconds and doubles to a minute, and a run that stayed
# up for five minutes resets it. A monitor that dies during start-up every twenty
# seconds must not spin at full speed; a monitor that had been fine for hours must
# not sit out a whole minute before coming back.
#
# All of its own output goes to logs\monitor.log, because the screen belongs to the
# frame: the only thing this script prints in the window is a restart notice, which
# is exactly the thing the frame cannot say.
# ===========================================================================
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$MonitorArgs = @()
)

$ErrorActionPreference = "Continue"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunDir     = Join-Path $ProjectDir ".run"
$LogDir     = Join-Path $ProjectDir "logs"
$LogFile    = Join-Path $LogDir "monitor.log"
$PidFile    = Join-Path $RunDir "monitor.pid"

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path $LogFile -Value "$stamp $Message" -ErrorAction SilentlyContinue
}

function Resolve-Node {
  $exe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if ($exe) { return $exe }
  foreach ($candidate in @(
      "C:\Program Files\nodejs\node.exe",
      "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

$Node = Resolve-Node
if (-not $Node) {
  Write-Log "FATAL: node was not found. Install Node.js (>=24)."
  Write-Host "node was not found. Install Node.js (>=24)." -ForegroundColor Red
  exit 1
}
$NpmCmd = Join-Path (Split-Path $Node -Parent) "npm.cmd"

# The title is how `monitorctl.ps1 status` and a human tell this window from every
# other PowerShell on the desktop.
try { $Host.UI.RawUI.WindowTitle = "anyPS5 monitor" } catch { }

$PID | Set-Content -Path $PidFile -ErrorAction SilentlyContinue
try {
  Write-Log "window opened (pid $PID) with arguments: $(if ($MonitorArgs.Count -gt 0) { $MonitorArgs -join ' ' } else { 'none' })"

  $backoffSeconds = 5
  while ($true) {
    $startedAt = Get-Date
    Write-Log "monitor starting"

    & $NpmCmd run monitor -- @MonitorArgs
    $code = $LASTEXITCODE
    $stayedUp = ((Get-Date) - $startedAt).TotalSeconds

    if ($code -eq 0) {
      Write-Log ("monitor exited cleanly after {0:n0}s; the reader asked to leave, closing the window" -f $stayedUp)
      break
    }

    Write-Log ("monitor exited with code {0} after {1:n0}s; restarting in {2}s" -f $code, $stayedUp, $backoffSeconds)
    Write-Host ""
    Write-Host ("The monitor exited (code {0}). Restarting in {1}s - Ctrl-C closes the window." -f $code, $backoffSeconds) -ForegroundColor Yellow
    Start-Sleep -Seconds $backoffSeconds

    if ($stayedUp -ge 300) {
      $backoffSeconds = 5
    } else {
      $backoffSeconds = [Math]::Min(60, $backoffSeconds * 2)
    }
  }
} finally {
  Remove-Item $PidFile -ErrorAction SilentlyContinue
}
