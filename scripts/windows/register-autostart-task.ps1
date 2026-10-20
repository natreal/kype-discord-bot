# ===========================================================================
# Registers (or removes) the Windows task that keeps the bot supervisor running.
#
#   register-autostart-task.ps1            # at logon, no time limit
#   register-autostart-task.ps1 -Status
#   register-autostart-task.ps1 -Remove
#
# This is the task the OpenClaw console lists in bots.json ("kype" ->
# "kype-discord-bot"). Its watchdog (Watchdog-24-7.ps1, task "Bot 24-7") starts
# the task again whenever its state is not Running, so the TASK - not a process -
# is what "the bot is up" means on this PC. botctl.ps1 start launches the same
# task, and deploy.ps1 pauses the watchdog while it has the bot stopped.
#
# Settings that matter for a 24/7 bot:
#   * no execution time limit - the schtasks default is three days, after which
#     the supervisor would be killed in the middle of a run;
#   * run on battery          - a laptop on battery must not lose the bot;
#   * IgnoreNew               - a second trigger must not replace a running bot;
#   * restart on failure      - covers a crash while the watchdog is paused.
#
# New-ScheduledTaskPrincipal -RunLevel Highest needs an elevated PowerShell on a
# machine with UAC. Without it the script falls back to schtasks.exe, which works
# but cannot express the settings above; the watchdog hides that difference by
# restarting the task within a minute of a stop.
# ===========================================================================
[CmdletBinding()]
param(
  [string]$TaskName = "kype-discord-bot",
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Supervisor = Join-Path $PSScriptRoot "supervisor.ps1"

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

if (-not (Test-Path $Supervisor)) { throw "Missing $Supervisor" }

# wscript launches the supervisor with no console window at all (Run-Hidden.vbs);
# powershell.exe would flash one for a fraction of a second on every start.
$Launcher = (Resolve-Path (Join-Path $PSScriptRoot "Run-Hidden.vbs")).Path
$argument = "//B //NoLogo `"$Launcher`" supervisor.ps1"

try {
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $argument -WorkingDirectory $ProjectDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Scheduled task '$TaskName' registered: at logon, no time limit, restarts on failure."
} catch {
  Write-Warning "Register-ScheduledTask failed: $($_.Exception.Message)"
  Write-Warning "Falling back to schtasks.exe (72-hour limit, stops on battery). Run this script from an elevated PowerShell to get the full settings."
  & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR "wscript.exe $argument" /RL HIGHEST /F
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create scheduled task '$TaskName' (schtasks exit $LASTEXITCODE)."
  }
  Write-Host "Scheduled task '$TaskName' created at logon (fallback settings)."
}

Write-Host "Start it now with:   schtasks /Run /TN $TaskName"
Write-Host "Check its state:     npm run bot:autostart:status"
Write-Host "Remove it with:      npm run bot:autostart:remove"
