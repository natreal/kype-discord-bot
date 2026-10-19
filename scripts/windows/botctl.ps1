# ===========================================================================
# Discord bot control script (Windows).
#
# Windows port of scripts/desktop/botctl.sh.
#
#   botctl.ps1 status    # is the bot running, and since when
#   botctl.ps1 stop      # stop the bot and its supervisor
#   botctl.ps1 start     # same as double-clicking Start-Bot.cmd
#   botctl.ps1 logs      # follow logs\bot.log (see logs\supervisor.log too)
#   botctl.ps1 tail      # show the last 50 log lines (+ supervisor.log)
#
# Every process it touches is identified by its command line — the pid files in .run
# are hints, and Windows recycles pids — so it cannot stop something unrelated, and an
# operator never has to hunt for a process by name. Stopping kills whole process trees
# and sweeps up an orphaned node whose wrapper died, releases the instance lock and
# removes both pid files, so the next start is a clean one rather than an "another
# instance is running" run.
# ===========================================================================
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("status", "start", "stop", "restart", "logs", "tail")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Continue"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunDir     = Join-Path $ProjectDir ".run"
$LogFile    = Join-Path $ProjectDir "logs\bot.log"
$LogFallback= Join-Path $ProjectDir "logs\supervisor.log"
$PidFile    = Join-Path $RunDir "bot.pid"
$SupPidFile = Join-Path $RunDir "supervisor.pid"
$LockDir    = Join-Path $RunDir "lock"
$StopRequest= Join-Path $RunDir "stop.request"
$Supervisor = Join-Path $PSScriptRoot "supervisor.ps1"

function Get-PidValue([string]$FilePath) {
  if (-not (Test-Path $FilePath)) { return $null }
  $raw = (Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $null }
  return [int]$raw
}

function Test-Alive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# --- process identity ------------------------------------------------------
# A pid file is a hint, not proof. Windows recycles pids, so a stop that trusted the
# recorded number could take down whatever now owns it. The command line is what
# identifies a process, and it is what these two helpers check.
function Test-Ours([int]$ProcessId, [string]$Needle) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  return $proc.CommandLine.ToLower().Contains($Needle.ToLower())
}

function Test-BotProcess([int]$ProcessId) {
  return (Test-Ours $ProcessId "run-bot.cmd") -or (Test-Ours $ProcessId "dist\index.js")
}

function Get-BotRunner {
  # The actual node process, whatever the pid files say. Needed because the recorded
  # pid is the `run-bot.cmd` wrapper: when only the wrapper dies, node keeps running,
  # keeps its gateway connection and keeps logs\bot.log open — a state a pid file
  # cannot express and the next start cannot open its log in.
  return Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains("dist\index.js") } |
    Select-Object -First 1
}

function Stop-Tree([int]$ProcessId) {
  # `/T` is the tree, because the recorded bot pid is the wrapper that launched node:
  # killing only it is what leaves an orphaned bot behind. `/F` skips a confirmation
  # prompt a background script could never answer.
  & taskkill.exe /PID $ProcessId /T /F *> $null
}

switch ($Command) {
  "status" {
    $sup = Get-PidValue $SupPidFile
    $bot = Get-PidValue $PidFile

    if ($sup -and (Test-Alive $sup) -and (Test-Ours $sup "supervisor.ps1")) {
      Write-Host "supervisor: running (pid $sup)"
    } else {
      Write-Host "supervisor: not running"
    }

    if ($bot -and (Test-Alive $bot) -and (Test-BotProcess $bot)) {
      $proc = Get-Process -Id $bot -ErrorAction SilentlyContinue
      Write-Host "bot:        running (pid $bot)"
      if ($proc) { Write-Host ("started:    " + $proc.StartTime.ToString("yyyy-MM-dd HH:mm:ss")) }
    } else {
      Write-Host "bot:        not running"
    }

    # Asked of the process table rather than of the pid file, so a bot whose wrapper
    # died is still reported — and so a recycled pid cannot be mistaken for one.
    $runner = Get-BotRunner
    if ($runner) {
      Write-Host ("node:       running (pid " + $runner.ProcessId + ")")
    } else {
      Write-Host "node:       not running"
    }

    Write-Host "log:        $LogFile"
    if (Test-Path $LogFile) {
      # Size, not a line count: reading five megabytes line by line just to print a
      # number makes a status command the slowest thing an operator runs.
      $mb = [Math]::Round((Get-Item $LogFile).Length / 1MB, 2)
      Write-Host "log size:   $mb MB"
    }
  }

  "stop" {
    $sup = Get-PidValue $SupPidFile
    $bot = Get-PidValue $PidFile

    # Graceful first. Windows cannot deliver SIGTERM to a detached console
    # process, so the bot watches this marker and the supervisor treats the
    # resulting exit as intentional instead of restarting it. A hard kill is the
    # fallback, not the default: a deployment should not tear the gateway
    # connection or the database pool down while a write is in flight.
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    Set-Content -Path $StopRequest -Value (Get-Date).ToString("o")
    Write-Host "Requesting a graceful shutdown..."

    for ($i = 0; $i -lt 40; $i++) {
      $supAlive = $sup -and (Test-Alive $sup) -and (Test-Ours $sup "supervisor.ps1")
      if (-not (Get-BotRunner) -and -not $supAlive) { break }
      Start-Sleep -Milliseconds 500
    }

    $supAlive = $sup -and (Test-Alive $sup) -and (Test-Ours $sup "supervisor.ps1")
    if (-not (Get-BotRunner) -and -not $supAlive) {
      Write-Host "Stopped gracefully."
      Remove-Item $PidFile, $SupPidFile, $StopRequest -ErrorAction SilentlyContinue
      Remove-Item -Recurse -Force $LockDir -ErrorAction SilentlyContinue
      return
    }

    Write-Host "Graceful shutdown timed out; forcing..."
    if ($supAlive) {
      # The supervisor first: it would otherwise relaunch the bot the moment the
      # child exits, which turns "stop" into a restart.
      Write-Host "Stopping supervisor (pid $sup)..."
      Stop-Tree $sup
    }
    if ($bot -and (Test-Alive $bot) -and (Test-BotProcess $bot)) {
      Write-Host "Stopping bot (pid $bot)..."
      Stop-Tree $bot
    }

    # Anything the pid files did not know about — an orphaned node whose wrapper is
    # already gone, which is the state that keeps logs\bot.log locked.
    $orphans = @(Get-BotRunner)
    foreach ($orphan in $orphans) {
      Write-Host ("Stopping orphaned bot process (pid " + $orphan.ProcessId + ")...")
      Stop-Tree $orphan.ProcessId
    }
    if (-not $sup -and -not $bot -and $orphans.Count -eq 0) {
      Write-Host "The bot is not running."
    }

    for ($i = 0; $i -lt 30; $i++) {
      $su = $sup -and (Test-Alive $sup)
      $bo = $bot -and (Test-Alive $bot)
      if (-not $su -and -not $bo -and -not (Get-BotRunner)) { break }
      Start-Sleep -Milliseconds 500
    }

    if ($sup -and (Test-Alive $sup)) { Stop-Tree $sup }
    if ($bot -and (Test-Alive $bot)) { Stop-Tree $bot }
    foreach ($orphan in @(Get-BotRunner)) { Stop-Tree $orphan.ProcessId }

    # The lock is released and both pid files removed, so the next start is a clean
    # one instead of an "another instance is running" run.
    Remove-Item $PidFile, $SupPidFile, $StopRequest -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $LockDir -ErrorAction SilentlyContinue
    Write-Host "Stopped."
  }

  "start" {
    # A marker from an earlier stop would make the freshly started bot shut down
    # immediately, so clear it before launching the supervisor.
    Remove-Item $StopRequest -ErrorAction SilentlyContinue

    # Start through the scheduled task when there is one. The OpenClaw watchdog
    # starts that task whenever its state is not Running, so a supervisor launched
    # directly here would be replaced by the watchdog within a minute. Going through
    # the task keeps the two in agreement and is the same path a reboot takes.
    $taskName = "kype-discord-bot"
    & schtasks.exe /Query /TN $taskName *> $null
    if ($LASTEXITCODE -eq 0) {
      & schtasks.exe /Run /TN $taskName *> $null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Start requested through scheduled task '$taskName'; see logs\bot.log."
        return
      }
      Write-Host "Could not start scheduled task '$taskName'; launching the supervisor directly."
    }

    Start-Process -FilePath "powershell.exe" `
      -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Supervisor `
      -WorkingDirectory $ProjectDir -WindowStyle Hidden
    Write-Host "Start requested; see logs\bot.log."
  }

  "restart" {
    & $PSCommandPath stop
    Start-Sleep -Seconds 1
    & $PSCommandPath start
    Write-Host "Restart requested; see logs\bot.log."
  }

  "logs" {
    if (-not (Test-Path $LogFile)) { Write-Host "No log file yet at $LogFile"; exit 0 }
    if (Test-Path $LogFallback) {
      Write-Host "Supervisor lines that bot.log refused are in $LogFallback."
    }
    Write-Host "Following $LogFile - press Ctrl-C to stop following (the bot keeps running)."
    Get-Content $LogFile -Wait -Tail 20
  }

  "tail" {
    if (-not (Test-Path $LogFile) -and -not (Test-Path $LogFallback)) {
      Write-Host "No log file yet at $LogFile"; exit 0
    }
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 50 }
    if (Test-Path $LogFallback) {
      Write-Host "--- logs\supervisor.log (last 20) ---"
      Get-Content $LogFallback -Tail 20
    }
  }
}
