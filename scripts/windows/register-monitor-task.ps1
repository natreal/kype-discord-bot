# ===========================================================================
# Registers (or removes) the Windows task that opens the monitor window at logon.
#
#   register-monitor-task.ps1            # at logon, no time limit
#   register-monitor-task.ps1 -Status
#   register-monitor-task.ps1 -Remove
#
# The task runs scripts\windows\monitor-run.ps1 through Windows Terminal, so the
# window the reader sees after logging in is the same window `monitor:start` opens,
# and both are kept alive by the same restart loop. Unlike the bot's login item
# there is nothing to hide: a monitor that starts invisibly is a monitor nobody is
# watching, so this task exists to *show* a window.
#
# Settings that matter for a 24/7 window:
#   * no execution time limit - the schtasks default is three days, after which the
#     window would be closed under the reader;
#   * run on battery          - a laptop on battery must keep showing;
#   * IgnoreNew               - a second trigger (logon plus a manual start) must not
#     open a second window;
#   * no restart-on-failure   - monitor-run.ps1 already reopens a crashed monitor,
#     and a task that restarted its action would undo `npm run monitor:stop`.
# ===========================================================================
[CmdletBinding()]
param(
  [string]$TaskName = "kype-anyps5-monitor",
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Runner     = Join-Path $PSScriptRoot "monitor-run.ps1"

if ($Status) {
  & schtasks.exe /Query /TN $TaskName /V /FO LIST
  exit $LASTEXITCODE
}

if ($Remove) {
  & schtasks.exe /Delete /TN $TaskName /F
  if ($LASTEXITCODE -ne 0) { throw "Could not remove scheduled task '$TaskName'." }
  Write-Host "Removed scheduled task '$TaskName'."
  exit 0
}

if (-not (Test-Path $Runner)) { throw "Missing $Runner" }

$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$runnerArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
$wt = (Get-Command wt.exe -ErrorAction SilentlyContinue).Source

if ($wt) {
  # -w -1 asks for a window of its own: `new-tab` on its own attaches to whichever
  # Windows Terminal window is in front, and the monitor must not be a tab in
  # somebody else's working window. -d is the working directory, which is how
  # monitor.ts finds .env and the repository. --suppressApplicationTitle keeps this
  # title, which is how monitorctl.ps1 stop finds the window again.
  $execute = $wt
  $argument = "-w -1 new-tab -d `"$ProjectDir`" --title `"anyPS5 monitor`" --suppressApplicationTitle `"$psExe`" $runnerArgs"
} else {
  # A plain console window shows the same frame; it only lacks WT's resize handling.
  $execute = $psExe
  $argument = $runnerArgs
}

try {
  $action = New-ScheduledTaskAction -Execute $execute -Argument $argument -WorkingDirectory $ProjectDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  # Interactive, not "run whether the user is logged on": the window has to appear
  # on the desktop of the person who just logged in.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Scheduled task '$TaskName' registered: at logon, no time limit, one window."
} catch {
  Write-Warning "Register-ScheduledTask failed: $($_.Exception.Message)"
  Write-Warning "Falling back to schtasks.exe (72-hour limit, stops on battery)."

  # schtasks.exe strips the quotes around /TR, so an absolute path containing a
  # space would be split in two. 8.3 short paths have no spaces, which makes the
  # fallback work from any project directory without quoting tricks.
  $fso = New-Object -ComObject Scripting.FileSystemObject
  $shortDir = $fso.GetFolder($PSScriptRoot).ShortPath
  $shortProject = $fso.GetFolder($ProjectDir).ShortPath
  $shortRunner = Join-Path $shortDir "monitor-run.ps1"
  $shortPs = $fso.GetFile($psExe).ShortPath
  $direct = "$shortPs -NoProfile -ExecutionPolicy Bypass -File $shortRunner"

  if ($wt) {
    $shortWt = $fso.GetFile($wt).ShortPath
    $tr = "$shortWt new-tab -d $shortProject --title anyPS5-monitor $direct"
  } else {
    $tr = $direct
  }

  & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $tr /RL LIMITED /F
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create scheduled task '$TaskName' (schtasks exit $LASTEXITCODE)."
  }
  Write-Host "Scheduled task '$TaskName' created at logon (fallback settings)."
}

Write-Host "Open the window now:   npm run monitor:start"
Write-Host "Check its state:       npm run monitor:autostart:status"
Write-Host "Remove the task:       npm run monitor:autostart:remove"
