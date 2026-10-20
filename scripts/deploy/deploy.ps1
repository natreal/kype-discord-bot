# ===========================================================================
# Pull-based automated deployment for the Kype Discord bot (Windows).
#
# The PC hosts the bot, so GitHub cannot push to it. Instead this script runs on
# a schedule, fetches the deploy branch and only acts when the remote moved:
#
#   fetch -> preflight -> stop bot -> fast-forward -> npm ci -> build -> test
#         -> pg_dump -> prisma migrate deploy -> db smoke -> start -> readiness
#
# Any failure after the pull triggers a rollback to the previously deployed
# commit (and the previous node_modules snapshot) and restarts the bot, so a bad
# push costs a minute of downtime instead of leaving the bot broken.
#
# Usage:
#   deploy.ps1                 # deploy if origin/<branch> moved
#   deploy.ps1 -CheckOnly      # report what would be deployed, change nothing
#   deploy.ps1 -Status         # show the last recorded deployment result
#   deploy.ps1 -Branch main    # override the branch (default: main)
#   deploy.ps1 -Force          # retry a commit whose deployment already failed
#
# Everything is logged to logs\deploy.log. Secrets are never written to it: the
# .env file is read for preflight checks and pg_dump only, and log lines are
# redacted for URLs with embedded credentials and GitHub tokens.
# ===========================================================================
[CmdletBinding()]
param(
  [string]$Branch = "main",
  [switch]$CheckOnly,
  [switch]$Status,
  [switch]$Force,
  [int]$HealthTimeoutSeconds = 180,
  # The OpenClaw console watchdog starts the kype-discord-bot task whenever it is
  # not running, which would undo the stop below after about a minute. The deploy
  # pauses it through its supported pause file and removes it again afterwards.
  # Pass an empty string to disable this on a host without that watchdog.
  [string]$WatchdogPauseFile = "C:\Users\natte\OpenClawConsole\watchdog.pause"
)

$ErrorActionPreference = "Stop"

$ProjectDir  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$RunDir      = Join-Path $ProjectDir ".run"
$LogDir      = Join-Path $ProjectDir "logs"
$BackupDir   = Join-Path $ProjectDir "backups"
$DeployLog   = Join-Path $LogDir "deploy.log"
$BotLog      = Join-Path $LogDir "bot.log"
$StateFile   = Join-Path $RunDir "deploy-state.json"
$FailureFile = Join-Path $RunDir "deploy-failed-target.json"
$LockFile    = Join-Path $RunDir "deploy.lock"
$BuildMarker = Join-Path $RunDir ".built"
$Botctl      = Join-Path $ProjectDir "scripts\windows\botctl.ps1"
$EnvFile     = Join-Path $ProjectDir ".env"

$script:NpmCmd = "npm.cmd"
$foundNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($foundNpm) { $script:NpmCmd = $foundNpm.Source }

# Task Scheduler starts a job with an empty "Start in", so the working directory
# is C:\Windows\System32. git is told where the repository is (-C), but npm and
# the npm scripts resolve everything relative to the current directory -- a
# deploy started by the task failed with "npm ci can only install with an
# existing package-lock.json" because of exactly that. Move into the project
# before any step runs, and fail loudly if that is impossible.
Set-Location -LiteralPath $ProjectDir
if (-not (Test-Path (Join-Path (Get-Location).Path "package-lock.json"))) {
  throw "Not in the project root ($((Get-Location).Path)); package-lock.json is missing."
}

$script:LockStream = $null

New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

# --- logging ---------------------------------------------------------------
# Redaction runs before anything is written: git can print a remote URL that
# embeds a token, and npm can echo proxy settings.
function Redact {
  param([string]$Text)
  if (-not $Text) { return $Text }
  $Text = $Text -replace '(?i)(https?://)[^/@\s]+@', '$1***@'
  $Text = $Text -replace '\bgh[pousr]_[A-Za-z0-9]{20,}\b', '***'
  $Text = $Text -replace '\bgithub_pat_[A-Za-z0-9_]{20,}\b', '***'
  return $Text
}

function Write-DeployLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), (Redact $Message)
  Add-Content -Path $DeployLog -Value $line -Encoding UTF8
  if ($CheckOnly -or $Status) { Write-Host $line }
}

function Initialize-DeployLog {
  if (Test-Path $DeployLog) {
    if ((Get-Item $DeployLog).Length -gt 10MB) {
      Move-Item -Force $DeployLog "$DeployLog.1"
    }
  }
}

# --- state -----------------------------------------------------------------
function Read-DeployState {
  if (-not (Test-Path $StateFile)) { return $null }
  try {
    return Get-Content -Raw $StateFile | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-DeployState {
  param(
    [string]$Result,
    [string]$Message,
    [string]$DeployedSha = "",
    [string]$PreviousSha = "",
    [string]$TargetSha = ""
  )
  $state = [ordered]@{
    checkedAt   = (Get-Date).ToString("o")
    result      = $Result
    message     = (Redact $Message)
    branch      = $Branch
    deployedSha = $DeployedSha
    previousSha = $PreviousSha
    targetSha   = $TargetSha
  }
  $state | ConvertTo-Json -Depth 3 | Set-Content -Path $StateFile -Encoding UTF8
}

# --- failed-target guard ---------------------------------------------------
# A commit whose deployment failed stays on origin/main until somebody acts.
# Without this guard the five-minute task would stop the bot, fail, roll back and
# repeat forever, turning one bad push into a flapping bot. The target is
# remembered until a new commit arrives (or -Force is given), so every retry the
# operator gets one clean failure instead of a restart loop.
function Read-FailedTarget {
  if (-not (Test-Path $FailureFile)) { return $null }
  try {
    return Get-Content -Raw $FailureFile | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Set-FailedTarget {
  param([string]$Sha, [string]$Message)
  if (-not $Sha) { return }
  $record = [ordered]@{
    sha    = $Sha
    at     = (Get-Date).ToString("o")
    reason = (Redact $Message)
  }
  $record | ConvertTo-Json -Depth 3 | Set-Content -Path $FailureFile -Encoding UTF8
}

function Clear-FailedTarget {
  Remove-Item $FailureFile -Force -ErrorAction SilentlyContinue
}

# --- single instance -------------------------------------------------------
# A scheduled task can fire again while a slow deploy (npm ci, tests) is still
# running. An exclusive handle on the lock file makes the second run a no-op.
function Enter-DeployLock {
  try {
    $script:LockStream = [System.IO.File]::Open(
      $LockFile,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    return $true
  } catch [System.IO.IOException] {
    return $false
  }
}

function Exit-DeployLock {
  if ($script:LockStream) {
    $script:LockStream.Dispose()
    $script:LockStream = $null
  }
}

# --- config / process helpers ---------------------------------------------
# Reads one key from .env without ever logging the value. Supports the simple
# KEY=value forms used by this project, including quoted values.
function Get-EnvValue {
  param([string]$Key)
  if (-not (Test-Path $EnvFile)) { return $null }
  $pattern = "^\s*" + [regex]::Escape($Key) + "\s*=\s*(.*)$"
  foreach ($line in Get-Content -Path $EnvFile -Encoding UTF8) {
    if ($line -match $pattern) {
      $value = $Matches[1].Trim()
      if ($value.Length -ge 2) {
        $quoted = ($value.StartsWith('"') -and $value.EndsWith('"')) -or `
                  ($value.StartsWith("'") -and $value.EndsWith("'"))
        if ($quoted) { $value = $value.Substring(1, $value.Length - 2) }
      }
      return $value
    }
  }
  return $null
}

# `$ErrorActionPreference = "Stop"` turns the first line a native tool writes to
# stderr into a terminating NativeCommandError -- and git, npm, pg_dump and
# powershell all write ordinary progress there ("From https://...", "Switched to
# branch", "dumping contents of table"). Capture with the preference relaxed so
# the exit code stays the only thing that decides whether a step failed.
function Invoke-Native {
  # The scriptblock runs in this scope, so a parameter named $Command or
  # $Arguments here would shadow the caller's variable of that name. Keep the
  # parameter names specific.
  param([scriptblock]$Body)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $result = & $Body
  } finally {
    $ErrorActionPreference = $previous
  }
  return ,@($result)
}

function Invoke-Git {
  param([string[]]$Arguments, [switch]$AllowFailure)
  $output = Invoke-Native { & git -C $ProjectDir @Arguments 2>&1 }
  $code = $LASTEXITCODE
  foreach ($line in @($output)) {
    if ($null -ne $line) {
      Add-Content -Path $DeployLog -Value (Redact ([string]$line)) -Encoding UTF8
    }
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw ("git {0} failed with exit code {1}" -f ($Arguments -join " "), $code)
  }
  return [pscustomobject]@{ Code = $code; Output = (@($output) -join "`n") }
}

function Invoke-Npm {
  param([string[]]$Arguments)
  Write-DeployLog ("==> npm " + ($Arguments -join " "))
  Invoke-Native { & $script:NpmCmd @Arguments 2>&1 } | ForEach-Object {
    Add-Content -Path $DeployLog -Value (Redact ([string]$_)) -Encoding UTF8
  }
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    throw ("npm {0} failed with exit code {1}" -f ($Arguments -join " "), $code)
  }
}

function Invoke-Botctl {
  param([string]$Action)
  Write-DeployLog "==> botctl $Action"
  if (-not (Test-Path $Botctl)) { throw "Missing $Botctl" }
  $botctlArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Botctl, $Action)
  $output = Invoke-Native { & powershell.exe @botctlArgs 2>&1 }
  $code = $LASTEXITCODE
  foreach ($line in @($output)) {
    Add-Content -Path $DeployLog -Value (Redact ([string]$line)) -Encoding UTF8
  }
  if ($code -ne 0) { throw "botctl $Action failed with exit code $code" }
}

function Get-BotProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains("dist\index.js") })
}

# The bot writes through cmd's append redirection, so the file must be opened
# with read/write sharing or the read fails while the bot is logging.
function Get-NewBotLog {
  param([long]$Offset)
  if (-not (Test-Path $BotLog)) { return "" }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $BotLog,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    if ($Offset -gt $stream.Length) { $Offset = 0 }
    $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } catch {
    return ""
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

# Readiness is the bot's own "Startup complete" line: it is logged only after the
# gateway is up, the database connected and guilds reconciled, which is exactly
# the state a deployment must verify before declaring success.
function Wait-BotHealthy {
  param([long]$LogOffset, [int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $text = Get-NewBotLog -Offset $LogOffset
    if ($text -match "Startup complete") { return $true }
    if ($text -match "Missing required environment|Cannot find module|ERR_MODULE_NOT_FOUND") {
      return $false
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Set-BuildMarker {
  Set-Content -Path $BuildMarker -Value (Get-Date).ToString("o")
}


# --- database backup -------------------------------------------------------
# Best effort: pg_dump is optional on the host. A missing backup is logged, but
# does not block a deploy whose migrations are additive; losing the dump only
# makes a manual recovery harder, it does not cause the outage.
function Backup-Database {
  $pgDump = $null
  $command = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
  if ($command) { $pgDump = $command.Source }
  if (-not $pgDump) {
    foreach ($candidate in @(
      (Join-Path $env:USERPROFILE "pgsql\bin\pg_dump.exe"),
      "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe",
      "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe",
      "C:\Program Files\PostgreSQL\15\bin\pg_dump.exe"
    )) {
      if (Test-Path $candidate) { $pgDump = $candidate; break }
    }
  }
  if (-not $pgDump) {
    Write-DeployLog "pg_dump was not found; skipping the pre-migration backup."
    return
  }

  $url = Get-EnvValue "DATABASE_URL"
  if (-not $url) {
    Write-DeployLog "DATABASE_URL is missing; skipping the pre-migration backup."
    return
  }

  # Credentials are passed through PGPASSWORD, never on the command line, so they
  # cannot appear in a process listing. The URL itself is never logged.
  $clean = ($url -split '\?')[0]
  try {
    $uri = [System.Uri]$clean
    $userInfo = $uri.UserInfo
    $user = ""
    $password = ""
    if ($userInfo) {
      $parts = $userInfo -split ':', 2
      $user = [System.Uri]::UnescapeDataString($parts[0])
      if ($parts.Count -gt 1) { $password = [System.Uri]::UnescapeDataString($parts[1]) }
    }
    $port = $uri.Port
    if ($port -le 0) { $port = 5432 }
    $dbName = $uri.AbsolutePath.TrimStart('/')
    if (-not $uri.Host -or -not $dbName) { throw "the URL is not a host/database pair" }
  } catch {
    Write-DeployLog "Could not parse DATABASE_URL for pg_dump ($($_.Exception.Message)); skipping the backup."
    return
  }

  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $file = Join-Path $BackupDir ("pre-deploy-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".dump")
  Write-DeployLog "==> pg_dump to $file"

  $previousPassword = $env:PGPASSWORD
  if ($password) { $env:PGPASSWORD = $password }
  try {
    $dumpArgs = @(
      "--host", $uri.Host,
      "--port", "$port",
      "--username", $user,
      "--dbname", $dbName,
      "--format=custom",
      "--no-password",
      "--file=$file"
    )
    Invoke-Native { & $pgDump @dumpArgs 2>&1 } | ForEach-Object {
      Add-Content -Path $DeployLog -Value (Redact ([string]$_)) -Encoding UTF8
    }
    $code = $LASTEXITCODE
  } finally {
    if ($previousPassword) { $env:PGPASSWORD = $previousPassword }
    else { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
  }

  if ($code -ne 0) {
    Write-DeployLog "WARNING: pg_dump failed (exit $code); continuing without a backup."
    return
  }
  Write-DeployLog "Backup written ($([Math]::Round((Get-Item $file).Length / 1KB)) KB)."

  # Keep the ten newest dumps so the folder cannot grow without bound.
  $stale = Get-ChildItem -Path $BackupDir -Filter "pre-deploy-*.dump" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 10
  foreach ($old in $stale) { Remove-Item -Force $old.FullName -ErrorAction SilentlyContinue }
}

# --- rollback --------------------------------------------------------------
# Restores the previous commit and dependency snapshot, rebuilds, starts the bot
# and verifies readiness. Database migrations are intentionally NOT reverted:
# Prisma migrations are forward-only, and a down-migration that drops data during
# an automated rollback is worse than a leftover additive column.
function Invoke-Rollback {
  param([string]$Sha)
  Write-DeployLog "Rolling back to $Sha..."
  try { Invoke-Botctl "stop" } catch { Write-DeployLog "Stop during rollback failed: $($_.Exception.Message)" }

  try {
    Invoke-Git @("reset", "--hard", $Sha) | Out-Null
  } catch {
    Write-DeployLog "git reset failed: $($_.Exception.Message)"
    return $false
  }

  $currentModules = Join-Path $ProjectDir "node_modules"
  $previousModules = Join-Path $ProjectDir "node_modules.__previous"
  if (Test-Path $previousModules) {
    if (Test-Path $currentModules) {
      Remove-Item -Recurse -Force $currentModules -ErrorAction SilentlyContinue
    }
    Rename-Item -Path $previousModules -NewName "node_modules"
    Write-DeployLog "Restored the previous node_modules snapshot."
  } else {
    Write-DeployLog "No dependency snapshot to restore; reinstalling from the previous lockfile."
    try { Invoke-Npm @("ci", "--no-audit", "--no-fund") } catch {
      Write-DeployLog "Dependency reinstall failed: $($_.Exception.Message)"
      return $false
    }
  }

  try {
    Invoke-Npm @("run", "build")
    Set-BuildMarker
  } catch {
    Write-DeployLog "Rebuild failed during rollback: $($_.Exception.Message)"
    return $false
  }

  try {
    $startOffset = 0L
    if (Test-Path $BotLog) { $startOffset = (Get-Item $BotLog).Length }
    Invoke-Botctl "start"
    if (Wait-BotHealthy -LogOffset $startOffset -TimeoutSeconds $HealthTimeoutSeconds) {
      Write-DeployLog "Rollback complete; the previous version is healthy."
      return $true
    }
    Write-DeployLog "Rollback started the bot but it did not report readiness in time."
  } catch {
    Write-DeployLog "Starting the bot during rollback failed: $($_.Exception.Message)"
  }
  return $false
}


# --- preflight -------------------------------------------------------------
function Invoke-Preflight {
  if (-not (Test-Path $EnvFile)) {
    throw ".env is missing; the bot needs DISCORD_TOKEN, DISCORD_CLIENT_ID and DATABASE_URL."
  }
  foreach ($key in @("DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DATABASE_URL")) {
    if (-not (Get-EnvValue $key)) { throw ".env does not define $key." }
  }
  if (-not (Test-Path (Join-Path $ProjectDir "package-lock.json"))) {
    throw "package-lock.json is missing; npm ci requires a lockfile."
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is not on PATH." }

  $nodeVersion = (Invoke-Native { & node -v 2>&1 }) -join " "
  if ($nodeVersion -notmatch '^v(\d+)\.') {
    throw "Could not determine the Node.js version (node -v returned '$nodeVersion')."
  }
  if ([int]$Matches[1] -lt 24) {
    throw "Node.js 24 or newer is required; found $nodeVersion."
  }

  # A .env that is not ignored could be committed by the next git add -A, which
  # would publish the bot token. Refuse to run rather than rely on discipline.
  $ignored = Invoke-Git @("check-ignore", "-q", ".env") -AllowFailure
  if ($ignored.Code -ne 0) { throw ".env is not ignored by git; refusing to deploy." }
}

# --- watchdog --------------------------------------------------------------
# The watchdog only restarts tasks it knows from bots.json, and it never touches a
# running one. Pausing it is therefore enough to keep the bot down for the length
# of the deployment; the deploy starts the bot itself and the watchdog finds it
# running again when it resumes.
function Suspend-Watchdog {
  if (-not $WatchdogPauseFile) { return $false }
  if (-not (Test-Path (Split-Path $WatchdogPauseFile -Parent))) { return $false }
  if (Test-Path $WatchdogPauseFile) {
    # The deploy lock guarantees no other deployment is running, so a pause file
    # this script wrote can only be stale: the run that created it was killed
    # before its finally block (Ctrl-C, a reboot, a timed-out task). Adopting it
    # makes this run remove it, so the watchdog cannot stay paused for ever.
    # Anything else in the file is an operator's pause and is left untouched.
    $existing = ""
    try {
      $existing = [string](Get-Content -Path $WatchdogPauseFile -TotalCount 1 -ErrorAction Stop)
    } catch {
      $existing = ""
    }
    if ($existing -like "paused by deploy.ps1*") {
      Write-DeployLog "Found a stale pause file from an interrupted deployment; it is removed when this run ends."
      return $true
    }
    Write-DeployLog "The workstation watchdog is paused by someone else; leaving that as it is."
    return $false
  }
  try {
    Set-Content -Path $WatchdogPauseFile -Encoding ASCII `
      -Value "paused by deploy.ps1 at $((Get-Date).ToString('o'))"
    Write-DeployLog "Paused the workstation watchdog so it cannot restart the bot mid-deploy."
    return $true
  } catch {
    Write-DeployLog "Could not pause the workstation watchdog ($($_.Exception.Message)); it may restart the bot mid-deploy."
    return $false
  }
}

function Resume-Watchdog {
  param([bool]$Owned)
  if (-not $Owned) { return }
  Remove-Item $WatchdogPauseFile -ErrorAction SilentlyContinue
  Write-DeployLog "Resumed the workstation watchdog."
}

# --- main ------------------------------------------------------------------
if ($Status) {
  $state = Read-DeployState
  if (-not $state) {
    Write-Host "No deployment has run yet."
    exit 0
  }
  Write-Host ("last check:  " + $state.checkedAt)
  Write-Host ("result:      " + $state.result)
  Write-Host ("message:     " + $state.message)
  Write-Host ("branch:      " + $state.branch)
  if ($state.deployedSha) { Write-Host ("deployed:    " + $state.deployedSha) }
  if ($state.targetSha) { Write-Host ("target:      " + $state.targetSha) }
  $failed = Read-FailedTarget
  if ($failed) {
    Write-Host ("failed:      " + $failed.sha + " (at " + $failed.at + ")")
    Write-Host ("reason:      " + $failed.reason)
    Write-Host "Automatic retries of this commit are suspended; push a new commit or run deploy.ps1 -Force."
  }
  exit 0
}

Initialize-DeployLog

if (-not (Enter-DeployLock)) {
  Write-DeployLog "Another deployment is already running; skipping this check."
  exit 0
}

$previousSha = ""
$targetSha = ""
$watchdogPaused = $false

try {
  Write-DeployLog "Deployment check started (branch: $Branch)."
  Invoke-Preflight

  $remotes = Invoke-Git @("remote")
  if (-not $remotes.Output.Trim()) {
    throw ("No git remote is configured. Add one with: " +
      "git remote add origin https://github.com/<owner>/<repo>.git")
  }

  $currentBranch = (Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD")).Output.Trim()
  if ($currentBranch -ne $Branch) {
    throw "The checkout is on '$currentBranch', not '$Branch'. Deployments run from a clean '$Branch' checkout."
  }

  $dirty = (Invoke-Git @("status", "--porcelain")).Output.Trim()
  if ($dirty) {
    throw "The working tree has uncommitted changes; commit, stash or discard them before deploying."
  }

  # Never let git wait for a credential prompt: a scheduled task has no console,
  # and a hung fetch would hold the deployment lock forever.
  $env:GIT_TERMINAL_PROMPT = "0"
  $env:GCM_INTERACTIVE = "Never"

  $fetch = Invoke-Git @("fetch", "--prune", "origin", $Branch) -AllowFailure
  if ($fetch.Code -ne 0) {
    throw "git fetch failed (exit $($fetch.Code)). The bot keeps running the current build."
  }

  $localSha = (Invoke-Git @("rev-parse", "HEAD")).Output.Trim()
  $remoteSha = (Invoke-Git @("rev-parse", "origin/$Branch")).Output.Trim()

  if ($localSha -eq $remoteSha) {
    Write-DeployLog "Already at $($localSha.Substring(0, 7)); nothing to deploy."
    $failedHere = Read-FailedTarget
    if ($failedHere -and $failedHere.sha -eq $localSha) { Clear-FailedTarget }
    Write-DeployState -Result "up-to-date" -Message "Already at $localSha." -DeployedSha $localSha
    exit 0
  }

  $ancestor = Invoke-Git @("merge-base", "--is-ancestor", "HEAD", "origin/$Branch") -AllowFailure
  if ($ancestor.Code -ne 0) {
    throw "Local HEAD is not an ancestor of origin/$Branch. A force-push or local commits would be overwritten; refusing."
  }

  $pending = (Invoke-Git @("log", "--oneline", "--no-decorate", "HEAD..origin/$Branch")).Output.Trim()
  Write-DeployLog ("Commits to deploy:`n" + $pending)

  if ($CheckOnly) {
    Write-DeployState -Result "pending" `
      -Message "origin/$Branch is ahead; run deploy.ps1 to apply it." `
      -DeployedSha $localSha -TargetSha $remoteSha
    Write-DeployLog "Check-only mode: the working tree and the bot were not touched."
    exit 0
  }

  $failedTarget = Read-FailedTarget
  if (-not $Force -and $failedTarget -and $failedTarget.sha -eq $remoteSha) {
    $at = if ($failedTarget.at) { ([datetime]$failedTarget.at).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") } else { "an earlier run" }
    $summary = "origin/$Branch at $($remoteSha.Substring(0, 7)) already failed deployment at $at. " +
      "Automatic retries are suspended; push a new commit or run deploy.ps1 -Force."
    Write-DeployLog $summary
    Write-DeployState -Result "blocked" -Message $summary -DeployedSha $localSha -TargetSha $remoteSha
    exit 1
  }
  if ($Force -and $failedTarget -and $failedTarget.sha -eq $remoteSha) {
    Write-DeployLog "Retrying $($remoteSha.Substring(0, 7)) because -Force was given."
  }

  $targetSha = $remoteSha
  $previousSha = $localSha


  # Pause the watchdog before the stop, not after: its tick is once a minute and a
  # restart in the middle of `npm ci` would fail the deploy for no code reason.
  $watchdogPaused = Suspend-Watchdog

  # Stop before touching node_modules: Prisma's query engine stays loaded by the
  # running bot, and Windows refuses to delete a directory that contains it.
  Invoke-Botctl "stop"
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-BotProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if ((Get-BotProcesses).Count -gt 0) {
    throw "The bot is still running; node_modules cannot be replaced safely."
  }

  # Keep the previous dependency tree for the rollback. `npm ci` deletes
  # node_modules, so a plain reinstall on failure would download the old tree
  # again while the bot is down.
  $liveModules = Join-Path $ProjectDir "node_modules"
  $previousModules = Join-Path $ProjectDir "node_modules.__previous"
  if (Test-Path $previousModules) {
    Remove-Item -Recurse -Force $previousModules -ErrorAction SilentlyContinue
  }
  if (Test-Path $liveModules) {
    Rename-Item -Path $liveModules -NewName "node_modules.__previous"
  }

  Invoke-Git @("merge", "--ff-only", "origin/$Branch") | Out-Null
  Invoke-Npm @("ci", "--no-audit", "--no-fund")
  Invoke-Npm @("run", "build")
  Set-BuildMarker
  Invoke-Npm @("test")

  # The backup precedes the only step that changes the database.
  Backup-Database
  Invoke-Npm @("run", "db:migrate:deploy")
  Invoke-Npm @("run", "db:smoke", "--", "--cleanup")

  $startOffset = 0L
  if (Test-Path $BotLog) { $startOffset = (Get-Item $BotLog).Length }
  Invoke-Botctl "start"
  if (-not (Wait-BotHealthy -LogOffset $startOffset -TimeoutSeconds $HealthTimeoutSeconds)) {
    throw "The bot started but did not report 'Startup complete' within $HealthTimeoutSeconds seconds."
  }

  $deployedSha = (Invoke-Git @("rev-parse", "HEAD")).Output.Trim()
  if ($deployedSha -ne $targetSha) {
    throw "HEAD moved during deployment (expected $targetSha, found $deployedSha)."
  }

  Remove-Item -Recurse -Force $previousModules -ErrorAction SilentlyContinue
  Clear-FailedTarget
  Write-DeployLog "Deployment succeeded: $deployedSha is healthy."
  Write-DeployState -Result "success" -Message "Deployed and verified healthy." `
    -DeployedSha $deployedSha -PreviousSha $previousSha -TargetSha $targetSha
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-DeployLog "DEPLOY FAILED: $message"

  if ($previousSha -and $targetSha) {
    if (Invoke-Rollback -Sha $previousSha) {
      Write-DeployState -Result "rolled-back" `
        -Message "Deployment to $targetSha failed: $message Rolled back to $previousSha." `
        -DeployedSha $previousSha -PreviousSha $previousSha -TargetSha $targetSha
    } else {
      Write-DeployState -Result "rollback-failed" `
        -Message "Deployment to $targetSha failed: $message Automatic rollback did not restore a healthy bot; check logs\bot.log." `
        -PreviousSha $previousSha -TargetSha $targetSha
    }
    # Remember the commit that failed so the next scheduled check does not stop the
    # bot and roll back again for the same push.
    Set-FailedTarget -Sha $targetSha -Message $message
  } else {
    Write-DeployState -Result "failed" -Message $message
  }
  exit 1
} finally {
  Resume-Watchdog -Owned $watchdogPaused
  Exit-DeployLock
}

