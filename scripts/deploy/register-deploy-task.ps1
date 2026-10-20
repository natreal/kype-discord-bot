# ===========================================================================
# Registers (or removes) the Windows scheduled task that drives deploy.ps1.
#
#   register-deploy-task.ps1                 # every 5 minutes
#   register-deploy-task.ps1 -IntervalMinutes 15
#   register-deploy-task.ps1 -Status
#   register-deploy-task.ps1 -Remove
#
# The task runs as the current user with the highest available privileges and
# only while that user is logged on, which matches how the bot itself runs
# (a Discord bot in a desktop session is started by Start-Bot.cmd / Task
# Scheduler at logon). A 24/7 host should therefore have automatic logon
# enabled; otherwise neither the bot nor this task survives a reboot.
#
# /RL HIGHEST means the deploy runs at the same integrity level as the bot task;
# a lower-privilege process cannot kill an elevated bot. Creating such a task
# usually requires an elevated PowerShell, so run the installer from one.
#
# The task is intentionally NOT configured to run on battery/idle changes:
# deployments should not start while the machine is about to sleep.
# ===========================================================================
[CmdletBinding()]
param(
  [int]$IntervalMinutes = 5,
  [string]$TaskName = "Kype-AutoDeploy",
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$DeployScript = Join-Path $PSScriptRoot "deploy.ps1"

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

if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be at least 1." }
if (-not (Test-Path $DeployScript)) { throw "Missing $DeployScript" }

# -WindowStyle Hidden keeps the console flash out of the way; every line still
# lands in logs\deploy.log. schtasks has no "start in" switch, so the job starts
# in C:\Windows\System32. deploy.ps1 therefore moves into the repository itself
# before running any npm step. Do not wrap this in "cmd.exe /c cd /d ... && ...":
# schtasks accepts it but every run then fails with 0xFFFD0000.
$action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DeployScript`""

& schtasks.exe /Create /TN $TaskName /SC MINUTE /MO $IntervalMinutes /TR $action /RL HIGHEST /F
if ($LASTEXITCODE -ne 0) {
  throw "Could not create scheduled task '$TaskName' (schtasks exit $LASTEXITCODE)."
}

Write-Host "Scheduled task '$TaskName' created: every $IntervalMinutes minute(s)."
Write-Host "Run it once now with: schtasks /Run /TN $TaskName"
Write-Host "Check its state with:  schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "Remove it with:        $($MyInvocation.MyCommand.Path) -Remove"
