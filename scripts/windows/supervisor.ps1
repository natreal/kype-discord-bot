# ===========================================================================
# Discord bot desktop supervisor (Windows).
#
# Windows port of scripts/desktop/supervisor.sh. Started by Start-Bot.cmd or by
# the task-scheduler login item.
#
# Responsibilities:
#   * single instance   - a lock directory guarantees only one bot runs;
#   * crash recovery    - the bot is relaunched whenever it exits, with a small
#                         and growing backoff so a crash loop cannot spin;
#   * offline recovery  - when Discord or PostgreSQL is unreachable, waits
#                         before retrying instead of giving up.
#
# All output is appended to logs\bot.log. The supervisor's own lines fall back to
# logs\supervisor.log while the bot holds bot.log open (cmd's `>>` is exclusive).
# ===========================================================================
[CmdletBinding()]
param(
  [switch]$NoBuild
)

$ErrorActionPreference = "Continue"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunDir     = Join-Path $ProjectDir ".run"
$LogDir     = Join-Path $ProjectDir "logs"
$LogFile    = Join-Path $LogDir "bot.log"
$LogFallback= Join-Path $LogDir "supervisor.log"
$PidFile    = Join-Path $RunDir "bot.pid"
$SupPidFile = Join-Path $RunDir "supervisor.pid"
$LockDir    = Join-Path $RunDir "lock"
$BuildMarker= Join-Path $RunDir ".built"
$StopRequest= Join-Path $RunDir "stop.request"
$RestartRequest = Join-Path $RunDir "restart.request"

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

# --- logging ---------------------------------------------------------------
function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line = "$stamp $Message"
  # run-bot.cmd appends node's output with `>>`, and cmd keeps that handle exclusive:
  # while the bot is alive a supervisor write to bot.log is refused. The lines that
  # matter most in that state - "Stopping leftover bot process", "Supervisor launched"
  # after replacing an orphan - go to logs\supervisor.log instead of disappearing.
  try {
    Add-Content -Path $LogFile -Value $line -ErrorAction Stop
  } catch {
    Add-Content -Path $LogFallback -Value $line -ErrorAction SilentlyContinue
  }
}

# --- node ------------------------------------------------------------------
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
  exit 1
}
$NodeDir = Split-Path $Node -Parent
$NpmCmd  = Join-Path $NodeDir "npm.cmd"

# --- single instance -------------------------------------------------------
function Test-PidAlive([string]$FilePath) {
  if (-not (Test-Path $FilePath)) { return $false }
  $raw = (Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $false }
  $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
  return [bool]$proc
}

function Get-PidValue([string]$FilePath) {
  if (-not (Test-Path $FilePath)) { return $null }
  $raw = (Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $null }
  return [int]$raw
}

function Release-Lock {
  Remove-Item -Recurse -Force $LockDir -ErrorAction SilentlyContinue
}

function Get-BotRunner {
  # The actual node process, whatever the pid files say: the recorded bot pid is the
  # `run-bot.cmd` wrapper, and when only the wrapper dies node keeps running, keeps its
  # gateway connection and keeps logs\bot.log open. Same rule as botctl.ps1. Both
  # separators are accepted because the command line is whatever run-bot.cmd passed on.
  return Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      ($_.CommandLine.ToLower().Contains("dist\index.js") -or
        $_.CommandLine.ToLower().Contains("dist/index.js"))
    } | Select-Object -First 1
}

function Stop-LeftoverBot {
  # One is the normal case; a relaunch that raced a kill can leave two, and each one
  # holds the gateway connection, so sweep until nothing matches.
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    $runner = Get-BotRunner
    if (-not $runner) { break }
    Write-Log "Stopping leftover bot process (pid $($runner.ProcessId))."
    # `/T` is the tree, `/F` skips a confirmation prompt a background script cannot answer.
    & taskkill.exe /PID $runner.ProcessId /T /F *> $null
    Start-Sleep -Milliseconds 300
  }
}

function Stop-Existing {
  $existing = Get-PidValue $SupPidFile
  if (-not $existing -or -not (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    $botPid = Get-PidValue $PidFile
    if ($botPid -and (Get-Process -Id $botPid -ErrorAction SilentlyContinue)) {
      Write-Log "Stopping orphaned bot process (pid $botPid)."
      Stop-Process -Id $botPid -Force -ErrorAction SilentlyContinue
    }
    Stop-LeftoverBot
    Release-Lock
    return
  }
  Write-Log "Another instance is running (supervisor pid $existing); replacing it."
  Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
  $waited = 0
  while ((Get-Process -Id $existing -ErrorAction SilentlyContinue) -and $waited -lt 30) {
    Start-Sleep -Milliseconds 500
    $waited++
  }
  if (Get-Process -Id $existing -ErrorAction SilentlyContinue) {
    Write-Log "Old instance did not exit in time; killing it."
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
  }
  $botPid = Get-PidValue $PidFile
  if ($botPid -and (Get-Process -Id $botPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $botPid -Force -ErrorAction SilentlyContinue
  }
  Stop-LeftoverBot
  Release-Lock
  Write-Log "Previous instance stopped."
}

function Acquire-Lock {
  try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
    Set-Content -Path (Join-Path $LockDir "owner") -Value $PID
    return $true
  } catch {
    # Lock exists. Reclaim it when its owner is gone, otherwise replace it.
    $owner = Get-PidValue (Join-Path $LockDir "owner")
    if (-not $owner -or -not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
      Write-Log "Reclaiming a stale instance lock (previous owner is gone)."
      Release-Lock
      try {
        New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
        Set-Content -Path (Join-Path $LockDir "owner") -Value $PID
        return $true
      } catch { }
    }
    Stop-Existing
    try {
      New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
      Set-Content -Path (Join-Path $LockDir "owner") -Value $PID
      return $true
    } catch {
      return $false
    }
  }
}

# --- build -----------------------------------------------------------------
function Needs-Build {
  if (-not (Test-Path $BuildMarker) -or -not (Test-Path (Join-Path $ProjectDir "dist\index.js"))) {
    return $true
  }
  $marker = (Get-Item $BuildMarker).LastWriteTimeUtc
  $inputs = Get-ChildItem -Path (Join-Path $ProjectDir "src") -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "\\generated\\" }
  $inputs += Get-Item (Join-Path $ProjectDir "prisma\schema.prisma") -ErrorAction SilentlyContinue
  $inputs += Get-Item (Join-Path $ProjectDir "package.json") -ErrorAction SilentlyContinue
  foreach ($f in $inputs) {
    if ($f -and $f.LastWriteTimeUtc -gt $marker) { return $true }
  }
  return $false
}

function Invoke-Build {
  Write-Log "Building the bot (npm run build)..."
  Push-Location $ProjectDir
  try {
    & $NpmCmd run build *>> $LogFile
    if ($LASTEXITCODE -eq 0) {
      Set-Content -Path $BuildMarker -Value (Get-Date).ToString("o")
      Write-Log "Build succeeded."
      return $true
    }
    Write-Log "Build FAILED - see the lines above. The bot will not start until it is fixed."
    return $false
  } finally {
    Pop-Location
  }
}

# --- connectivity ----------------------------------------------------------
function Test-DiscordReachable {
  try {
    Invoke-WebRequest -Uri "https://discord.com/api/v10/gateway" -TimeoutSec 5 -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-DatabaseUrl {
  $envFile = Join-Path $ProjectDir ".env"
  if (-not (Test-Path $envFile)) { return $null }
  $line = Get-Content $envFile | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^DATABASE_URL=", "").Trim()
}

function Test-DatabaseReachable {
  $ready = (Get-Command pg_isready.exe -ErrorAction SilentlyContinue).Source
  if (-not $ready) { return $true }  # client tools absent: skip rather than fail
  $url = Get-DatabaseUrl
  if (-not $url) { return $true }
  # Strip Prisma's ?schema=... that pg_isready rejects.
  $clean = ($url -split "\?")[0]
  & $ready -q -d $clean --timeout=5 *> $null
  return ($LASTEXITCODE -eq 0)
}

function Wait-ForNetwork {
  $announced = $false
  while (-not (Test-DiscordReachable)) {
    if (-not $announced) { Write-Log "Discord is unreachable (offline?). Waiting before retrying..."; $announced = $true }
    Start-Sleep -Seconds 10
  }
  if ($announced) { Write-Log "Discord is reachable again." }

  if (-not (Test-DatabaseReachable)) {
    Write-Log "PostgreSQL is not reachable yet; waiting for it."
    while (-not (Test-DatabaseReachable)) { Start-Sleep -Seconds 10 }
    Write-Log "PostgreSQL is reachable again."
  }
}

# --- main ------------------------------------------------------------------
# Logged before the lock is taken, so a start that hangs (or is refused) is
# distinguishable from one that never ran at all.
Write-Log "Supervisor launched (pid $PID)."
if (-not (Acquire-Lock)) {
  Write-Log "FATAL: could not acquire the instance lock at $LockDir."
  exit 1
}
Set-Content -Path $SupPidFile -Value $PID

Write-Log "=============================================================="
Write-Log "Supervisor starting (pid $PID, node $Node)."
Write-Log "Project: $ProjectDir"

# A marker left behind by an interrupted stop must not stop the run that is
# starting now. botctl.ps1 clears it before starting too; this covers the task
# scheduler, Start-Bot.cmd and a direct supervisor run.
Remove-Item $StopRequest -ErrorAction SilentlyContinue

if (-not $NoBuild) {
  if (Needs-Build) {
    if (-not (Invoke-Build)) {
      Write-Log "Supervisor exiting: the project does not build."
      Release-Lock
      exit 1
    }
  } else {
    Write-Log "Build is up to date."
  }
}

$Backoff = 5
$MaxBackoff = 60

while ($true) {
  Set-Content -Path $SupPidFile -Value $PID

  # An orderly stop was requested while the bot was down (or during the previous
  # backoff sleep): leave instead of starting a bot that is about to be stopped.
  # A restart marker — from `/restart`, or left behind by a relaunch that crashed
  # before starting — must not be mistaken for that: it means "come back", so it is
  # cleared and the loop continues.
  if (Test-Path $RestartRequest) {
    Write-Log "Restart marker present before launch; relaunching."
    Remove-Item $RestartRequest, $StopRequest -ErrorAction SilentlyContinue
  }
  if (Test-Path $StopRequest) {
    Write-Log "Stop requested; supervisor exiting without starting the bot."
    Remove-Item $StopRequest -ErrorAction SilentlyContinue
    Remove-Item $PidFile, $SupPidFile -ErrorAction SilentlyContinue
    Release-Lock
    exit 0
  }

  if (-not (Test-DiscordReachable)) {
    Wait-ForNetwork
  }

  # The wrapper can die while node survives (a killed parent, a crash mid-launch).
  # Such an orphan holds the gateway connection and logs\bot.log open, so the bot
  # started below would die at startup; sweep it up first.
  Stop-LeftoverBot

  Write-Log "Starting bot: $Node --env-file-if-exists=.env dist/index.js"
  # Launch through run-bot.cmd so node is started with a correctly-quoted command
  # line and its stdout+stderr are appended to the same bot.log the console's
  # "Journal" button opens (a merged log, like the python bots).
  $runBot = Join-Path $ProjectDir "run-bot.cmd"
  $bot = Start-Process -FilePath $runBot -ArgumentList "`"$Node`"" `
    -WorkingDirectory $ProjectDir -PassThru -NoNewWindow
  Set-Content -Path $PidFile -Value $bot.Id

  $bot.WaitForExit()
  $exitCode = $bot.ExitCode
  Remove-Item $PidFile -ErrorAction SilentlyContinue

  # The bot exits on its own when it sees the marker. If the marker is present,
  # this exit was intentional: do not restart, release the instance lock and let
  # the launcher's `stop` complete. Without this check, a graceful shutdown would
  # turn into an immediate restart.
  if (Test-Path $StopRequest) {
    # A restart marker wins over the stop marker: `/restart` writes it precisely so
    # that this deliberate exit brings the bot back instead of leaving it down.
    $restartRequested = Test-Path $RestartRequest
    Remove-Item $StopRequest -ErrorAction SilentlyContinue
    if ($restartRequested) {
      $why = $null
      try {
        $why = (Get-Content $RestartRequest -Raw -ErrorAction Stop | ConvertFrom-Json).requestedBy
      } catch {
        $why = $null
      }
      Remove-Item $RestartRequest -ErrorAction SilentlyContinue
      if ($why) {
        Write-Log "Restart requested by $why; relaunching."
      } else {
        Write-Log "Restart requested; relaunching."
      }
      # Falls through to the relaunch below rather than exiting: the supervisor is
      # already the process that knows how to start the bot properly, and starting a
      # second supervisor would fight this one over the instance lock.
      $Backoff = 1
    } else {
      Write-Log "Bot stopped on request; supervisor exiting."
      Remove-Item $PidFile, $SupPidFile -ErrorAction SilentlyContinue
      Release-Lock
      exit 0
    }
  }

  Write-Log "Bot exited with code $exitCode. Restarting in ${Backoff}s."
  Start-Sleep -Seconds $Backoff

  $Backoff = [Math]::Min($Backoff * 2, $MaxBackoff)
}