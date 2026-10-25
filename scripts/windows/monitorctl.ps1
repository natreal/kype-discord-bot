# ===========================================================================
# anyPS5 monitor window control script (Windows).
#
#   monitorctl.ps1 status    # is the window open, and since when
#   monitorctl.ps1 start     # open it (same path the logon task takes)
#   monitorctl.ps1 stop      # close it and the monitor inside it
#   monitorctl.ps1 restart
#   monitorctl.ps1 logs      # follow logs\monitor.log - restarts, not frames
#
# The window is a terminal, so unlike the bot it cannot run hidden: `start` has to
# create something the reader can look at. It prefers Windows Terminal (`wt.exe`)
# because the frame repaints itself and WT handles resizing and the alternate
# screen properly, and falls back to a plain PowerShell console when WT is not
# installed. Either way the window runs scripts\windows\monitor-run.ps1, which owns
# the restart loop - one start path, exactly like botctl.ps1.
#
# Identity comes from the command line, never from a pid file alone: `stop` acts
# only on a process whose command line says monitor-run.ps1 or scripts\monitor.ts,
# so a recycled pid cannot take something else down with it.
#
# The task is started with `schtasks /Run` when it exists, so `monitor:start` and a
# logon produce the same window; when it does not, the window is opened directly.
# ===========================================================================
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("status", "start", "stop", "restart", "logs")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Continue"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunDir     = Join-Path $ProjectDir ".run"
$LogDir     = Join-Path $ProjectDir "logs"
$LogFile    = Join-Path $LogDir "monitor.log"
$PidFile    = Join-Path $RunDir "monitor.pid"
$Runner     = Join-Path $PSScriptRoot "monitor-run.ps1"
$TaskName   = "kype-anyps5-monitor"

function Get-PidValue([string]$FilePath) {
  if (-not (Test-Path $FilePath)) { return $null }
  $raw = (Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $raw) { return $null }
  return [int]$raw
}

function Test-Ours([int]$ProcessId, [string]$Needle) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.CommandLine) { return $false }
  return $proc.CommandLine.ToLower().Contains($Needle.ToLower())
}

function Test-Runner([int]$ProcessId) {
  return Test-Ours $ProcessId "monitor-run.ps1"
}

# The window's shell, as a pid (or $null). `Start-Process wt.exe` hands the window to
# WindowsTerminal.exe before the runner has started, so this can be $null for a
# second after `start` - callers wait rather than report a failure.
function Get-MonitorRunnerPid {
  $recorded = Get-PidValue $PidFile
  if ($recorded -and (Test-Runner $recorded)) { return $recorded }
  $found = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains("monitor-run.ps1") } |
    Select-Object -First 1
  if ($found) { return [int]$found.ProcessId }
  return $null
}

function Wait-ForRunner([int]$Seconds) {
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    $runner = Get-MonitorRunnerPid
    if ($runner) { return $runner }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Get-StartedAt([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  return $proc.StartTime
}

# The monitor itself: node running tsx over scripts\monitor.ts. It is found by its
# command line rather than by a pid file because a killed window can leave it
# behind, still polling, with nothing on screen to say so.
function Get-MonitorNode {
  return Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine.ToLower().Contains("scripts\monitor.ts") -or
        $_.CommandLine.ToLower().Contains("scripts/monitor.ts"))
    }
}

function Stop-Tree([int]$ProcessId) {
  & taskkill.exe /PID $ProcessId /T /F *> $null
}

function Test-Task {
  & schtasks.exe /Query /TN $TaskName *> $null
  return ($LASTEXITCODE -eq 0)
}

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

switch ($Command) {
  "status" {
    if (Test-Task) {
      # The service module reports a state word the OS language cannot change;
      # schtasks' "Status:" line is localised ("Statut:" here), so it is only the
      # fallback.
      $taskState = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
      if (-not $taskState) {
        $taskState = (& schtasks.exe /Query /TN $TaskName /FO LIST 2>$null |
          Select-String -Pattern "^\S+\s*:" | Select-Object -First 1).Line -replace "^\S+\s*:\s*", ""
      }
      Write-Host "Logon task '$TaskName': $taskState"
    } else {
      Write-Host "Logon task '$TaskName': not registered (npm run monitor:autostart)."
    }

    $runner = Get-MonitorRunnerPid
    if ($runner) {
      $since = Get-StartedAt $runner
      Write-Host ("Window:            open (pid {0}, since {1:HH:mm:ss})" -f $runner, $since)
    } else {
      Write-Host "Window:            closed"
    }

    $nodes = @(Get-MonitorNode)
    if ($nodes.Count -gt 0) {
      $youngest = $nodes | Sort-Object ProcessId | Select-Object -Last 1
      $since = Get-StartedAt ([int]$youngest.ProcessId)
      # tsx runs the script in a child node process, so a healthy monitor is two
      # processes; reporting both would read like two monitors.
      $extra = if ($nodes.Count -gt 1) { " (plus its tsx loader)" } else { "" }
      Write-Host ("Monitor:           running (pid {0}, since {1:HH:mm:ss}){2}" -f $youngest.ProcessId, $since, $extra)
    } else {
      Write-Host "Monitor:           not running"
    }

    if (Test-Path $LogFile) {
      Write-Host "Restarts:          see $LogFile (npm run monitor:logs)"
    }
  }

  "start" {
    if (Get-MonitorRunnerPid) {
      Write-Host "The monitor window is already open."
      return
    }

    # Through the task when there is one: that is the same window a logon opens, and
    # it keeps the two paths from drifting apart (botctl.ps1 start does the same).
    if (Test-Task) {
      & schtasks.exe /Run /TN $TaskName *> $null
      if ($LASTEXITCODE -eq 0) {
        $runner = Wait-ForRunner 20
        if ($runner) {
          Write-Host "Opened the monitor window through task '$TaskName' (pid $runner)."
          return
        }
        Write-Host "Task '$TaskName' was started but no window appeared; opening it directly."
      } else {
        Write-Host "Could not start task '$TaskName'; opening the window directly."
      }
    }

    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $runnerArgs = "-NoProfile -ExecutionPolicy Bypass -File ""$Runner"""
    $wt = (Get-Command wt.exe -ErrorAction SilentlyContinue).Source

    if ($wt) {
      # `new-tab` with no window to attach to opens one, and -d sets the working
      # directory so monitor.ts finds .env and package.json without being told.
      $wtArgs = "new-tab -d ""$ProjectDir"" --title ""anyPS5 monitor"" ""$psExe"" $runnerArgs"
      $process = Start-Process -FilePath $wt -ArgumentList $wtArgs -PassThru -ErrorAction SilentlyContinue
      $runner = if ($process) { Wait-ForRunner 20 } else { $null }
      if ($runner) {
        Write-Host "Opened the monitor window in Windows Terminal (pid $runner)."
        return
      }
      Write-Host "Windows Terminal did not open a window; falling back to a plain console."
    }

    $process = Start-Process -FilePath $psExe -ArgumentList $runnerArgs `
      -WorkingDirectory $ProjectDir -PassThru -ErrorAction SilentlyContinue
    $runner = if ($process) { Wait-ForRunner 20 } else { $null }
    if ($runner) {
      Write-Host "Opened the monitor window (pid $runner)."
      return
    }

    Write-Warning "No monitor window appeared. Run this to see why:"
    Write-Warning "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
    exit 1
  }

  "stop" {
    $runner = Get-MonitorRunnerPid
    $nodes = @(Get-MonitorNode)

    if (-not $runner -and $nodes.Count -eq 0) {
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      Write-Host "The monitor is not running."
      return
    }

    if ($runner) {
      Write-Host "Closing the monitor window (pid $runner)..."
      Stop-Tree $runner
    }
    foreach ($node in $nodes) {
      Write-Host ("Stopping the monitor (pid {0})..." -f $node.ProcessId)
      Stop-Tree ([int]$node.ProcessId)
    }

    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-MonitorRunnerPid) -and @(Get-MonitorNode).Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    }
    # A window that outlived the kill would still be painting frames, so say so
    # rather than claim a stop that did not happen.
    if (Get-MonitorRunnerPid -or @(Get-MonitorNode).Count -gt 0) {
      Write-Warning "Something is still running; run 'monitor:status' and check the pids above."
      exit 1
    }

    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Stopped."
  }

  "restart" {
    & $PSCommandPath stop
    Start-Sleep -Seconds 1
    & $PSCommandPath start
  }

  "logs" {
    if (-not (Test-Path $LogFile)) {
      Write-Host "No log file yet at $LogFile"
      return
    }
    Write-Host "Following $LogFile - press Ctrl-C to stop following (the monitor keeps running)."
    Get-Content $LogFile -Wait -Tail 20
  }
}
