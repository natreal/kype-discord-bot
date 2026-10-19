# Automated deployment (GitHub to Windows PC)

How a `git push` reaches the bot running on a Windows desktop, and what happens
when the new build is wrong.

The host pulls; GitHub never connects to it. This is deliberate: the alternative
(a self-hosted runner accepting inbound work from GitHub) exposes the desktop to
the internet and needs an always-on listener, while a scheduled `git fetch` needs
nothing but outbound HTTPS.

```
git push origin main
        │
        ▼
     GitHub  ◄──── git fetch (every 5 minutes, outbound HTTPS)
        │                    │
        │                    ▼
        │            scripts\deploy\deploy.ps1
        │                    │
        │      ┌─────────────┴─────────────┐
        │      │ preflight                 │ clean tree, main, .env present,
        │      │                           │ .env ignored, Node >= 24
        │      ├───────────────────────────┤
        │      │ no new commit?            │ stop, write "up-to-date" state
        │      ├───────────────────────────┤
        │      │ pause watchdog            │ watchdog.pause, so it cannot
        │      │ botctl stop               │ restart the bot mid-deploy
        │      ├───────────────────────────┤
        │      │ merge --ff-only           │ refuses divergence
        │      │ npm ci                    │ lockfile-exact
        │      │ npm run build             │ prisma generate + tsc
        │      │ npm test                  │ 600+ tests
        │      ├───────────────────────────┤
        │      │ pg_dump (best effort)     │ backups\
        │      │ prisma migrate deploy     │ forward-only
        │      │ npm run db:smoke          │ real database round-trip
        │      ├───────────────────────────┤
        │      │ botctl start              │ supervisor
        │      │ wait "Startup complete"   │ gateway + database + guilds
        │      └─────────────┬─────────────┘
        │                    │
        │        success ────┴──── failure
        │           │                 │
        │           ▼                 ▼
        │    state=succeeded    reset --hard previous
        │    prune snapshot     restore node_modules
        │                       rebuild + start + verify
        │                       state=rolled-back
```

---

## What is on the host

| Piece                                           | Purpose                                                      |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `scripts\deploy\deploy.ps1`                     | The deployment pipeline (also runnable by hand)              |
| `scripts\deploy\register-deploy-task.ps1`       | Creates/removes the `Kype-AutoDeploy` scheduled task         |
| `scripts\windows\supervisor.ps1`                | Keeps the bot alive after the deploy (crash recovery)        |
| `scripts\windows\botctl.ps1`                    | `start`, `stop`, `restart`, `status`, `logs`, `tail`         |
| `scripts\windows\register-autostart-task.ps1`   | Creates/removes the `kype-discord-bot` logon task            |
| `C:\Users\natte\OpenClawConsole\watchdog.pause` | Pauses the console watchdog; created and removed by a deploy |
| `logs\deploy.log`                               | Deployment transcript, redacted, rotated at 10 MB            |
| `logs\bot.log`                                  | Bot output (supervisor + run-bot.cmd)                        |
| `logs\supervisor.log`                           | Supervisor lines written while the bot held bot.log open     |
| `.run\deploy-state.json`                        | Last check time, result, commit, error                       |
| `.run\deploy-failed-target.json`                | Commit whose deploy failed; suspends auto-retries            |
| `.run\deploy.lock`                              | Prevents two scheduled runs from deploying at once           |
| `backups\pre-deploy-*.dump`                     | Ten newest pre-migration dumps (git-ignored)                 |

---

## One-time setup

1. **Create the GitHub repository** and push `main`:

   ```powershell
   git remote add origin https://github.com/<owner>/<repo>.git
   git push -u origin main
   ```

2. **Make sure the host can read it non-interactively.** The scheduled task has
   no console, so a credential prompt is a hung deployment. Either keep the
   repository public, use a fine-grained read-only token in the remote URL, or
   let Git Credential Manager store a credential once with a manual `git fetch`
   before registering the task.

3. **Register the bot's own task** (once, so a reboot restores it):

   ```powershell
   npm run bot:autostart
   npm run bot:autostart:status
   ```

   This is the `kype-discord-bot` task the OpenClaw console watchdog watches. If
   the console's `bots.json` lists `kype`, that watchdog restarts the task within
   a minute of any stop, so it would undo a deploy — which is why the pipeline
   pauses it while it has the bot stopped.

4. **Register the deployment task** (runs every five minutes):

   ```powershell
   npm run deploy:task:install
   npm run deploy:task:status
   ```

5. **Dry run** once:

   ```powershell
   npm run deploy:auto:check
   npm run deploy:auto:status
   ```

Nothing else is required. Deployments hand the bot back to the same supervisor,
through the same task, that a logon would start.

---

## What a deployment does, in order

1. **Preflight** — `.env` exists and defines `DISCORD_TOKEN`,
   `DISCORD_CLIENT_ID` and `DATABASE_URL`; `.env` is git-ignored; the lockfile is
   present; Node.js is 24 or newer; git is on `PATH`.
2. **Guard rails** — a remote must exist, the checkout must be on the deploy
   branch, the working tree must be clean, and `HEAD` must be an ancestor of
   `origin/main` (so only fast-forwards are deployed).
3. **No-op if current** — equal commit hashes end the run after writing state.
4. **Pause the watchdog** — the OpenClaw console watchdog
   (`C:\Users\natte\OpenClawConsole\Watchdog-24-7.ps1`) starts
   `kype-discord-bot` whenever the task is not running, which is about a minute
   after a stop — long enough to restart the bot in the middle of `npm ci`, but
   too soon to be noticed. The deploy creates its supported pause file
   (`C:\Users\natte\OpenClawConsole\watchdog.pause`) before stopping anything, and
   removes it again in a `finally` — and only if this run created it.
5. **Graceful stop** — writes `.run\stop.request`; the bot's stop watcher runs
   the same shutdown path as `SIGTERM` (close gateway, drain database pool). The
   supervisor sees the marker and exits instead of restarting the bot. If the bot
   does not exit within 20 seconds, `botctl stop` falls back to a process-tree
   kill.
6. **Fast-forward** — `git merge --ff-only origin/main`; `.env`, `logs`, `.run`
   and `backups` are untracked/ignored, so they are untouched.
7. **Dependencies and build** — the current `node_modules` is renamed to
   `node_modules.__previous` (a rollback snapshot), then `npm ci` and
   `npm run build` run from the lockfile.
8. **Tests** — `npm test` must pass. A failing test prevents the deploy from
   reaching the database or the bot.
9. **Backup and migrations** — `pg_dump` (when the PostgreSQL client tools are
   installed), then `prisma migrate deploy`, then `npm run db:smoke -- --cleanup`
   against the real database.
10. **Start and verify** — `botctl start`, which starts the `kype-discord-bot`
    task when it exists (the same path a logon takes, so the watchdog agrees with
    it), then waits up to 180 seconds for a new `Startup complete` line in
    `logs\bot.log` (logged after the gateway is ready, the database connected and
    guilds reconciled). A missing module or missing environment variable fails
    immediately instead of waiting out the timeout.
11. **Finish** — on success the rollback snapshot is deleted; on failure the
    rollback path runs. The watchdog is resumed either way, in a `finally`, so a
    failed or interrupted deployment never leaves the bot unsupervised.

---

## Failure handling and rollback

| Failure                        | What happens                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Fetch fails (offline, auth)    | Deployment exits; the bot keeps running the current build                              |
| Dirty tree / wrong branch      | Refused before any change; commit or stash first                                       |
| History diverged               | Refused; no force-push is ever performed by the script                                 |
| `npm ci`, build or tests fail  | The bot is down; rollback restores code + previous `node_modules`, rebuilds and starts |
| Migration fails                | Same rollback; the database may need manual attention (see below)                      |
| Bot does not become ready      | Rollback restarts the previous commit; both attempts are logged                        |
| Rollback cannot restore health | `state=rollback-failed`, exit code 1; `logs\bot.log` has the reason                    |

Migrations are **not** reverted. Prisma migrations are forward-only, and an
automated down-migration that drops data during an incident is worse than a
leftover additive column. Write migrations that are backward compatible for one
release (add columns/tables first, remove later).

**A failed commit is not retried automatically.** The commit that failed is
recorded in `.run\deploy-failed-target.json` (with the time and the reason). Until
a new commit arrives on the branch, each scheduled check logs
`state=blocked` and exits without touching the bot, so one bad push cannot turn
into a bot that restarts every five minutes. After fixing forward with a new
commit, the guard clears itself; to retry the same commit deliberately:

```powershell
npm run deploy:auto:force
```

If the database itself is broken, the pre-migration dump restores it:

```powershell
# Stop the bot first so nothing writes during the restore
npm run bot:stop

# Restore into a clean database (drop/recreate it first if necessary)
$env:PGPASSWORD = "<password>"
& "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" `
  --host localhost --port 5432 --username postgres --dbname discord_bot `
  --clean --if-exists --no-owner "backups\pre-deploy-YYYYMMDD-HHMMSS.dump"
Remove-Item Env:\PGPASSWORD

npm run bot:start
```

---

## Manual operations

| Goal                         | Command                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Deploy now                   | `npm run deploy:auto`                                                           |
| Retry a failed commit        | `npm run deploy:auto:force`                                                     |
| See pending commits only     | `npm run deploy:auto:check`                                                     |
| Last result                  | `npm run deploy:auto:status`                                                    |
| Watch deployment log         | `Get-Content logs\deploy.log -Wait`                                             |
| Watch bot log                | `npm run bot:logs`                                                              |
| Restart by hand              | `npm run bot:restart`                                                           |
| Temporarily stop deployments | `npm run deploy:task:remove`                                                    |
| Re-enable                    | `npm run deploy:task:install`                                                   |
| Roll back by hand            | `git reset --hard <sha>`, then `npm ci`, `npm run build`, `npm run bot:restart` |

A manual `git pull` is safe while the task is registered only if the tree stays
clean and fast-forwardable; otherwise the next task run reports the tree as
dirty and does nothing.

`deploy.ps1` takes a few switches when run by hand:

| Switch               | Effect                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| `-CheckOnly`         | Preflight and fetch only; never stops the bot, never installs, never migrates          |
| `-Status`            | Print the last state file and exit                                                     |
| `-Force`             | Ignore the failed-target guard and retry the same commit (`deploy:auto:force`)         |
| `-WatchdogPauseFile` | Path of the console watchdog's pause file; `""` disables pausing for hosts without one |

`pg_dump` is looked up on `PATH`, then in `%USERPROFILE%\pgsql\bin`, then in
`C:\Program Files\PostgreSQL\{17,16,15}\bin` — the portable install used on this
PC is the second one, so backups work without adding anything to `PATH`.

---

## Security

- `.env` is git-ignored, never read into the deploy log, and preflight refuses to
  run if `git check-ignore .env` fails (so a mis-edited `.gitignore` cannot lead
  to a token commit).
- Log lines are redacted for `https://user:token@host` URLs and for
  `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_` tokens before they are written.
- Database credentials are passed to `pg_dump` through `PGPASSWORD`, not on the
  command line, so they do not appear in a process listing.
- The script runs with the logged-on user's privileges. It does not need
  administrator rights unless the task itself was registered with them.
- Only outbound HTTPS to GitHub is required. No inbound port is opened and no
  self-hosted runner is installed.

---

## Troubleshooting

| Symptom                                       | Likely cause / fix                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `state=failed`, "No git remote is configured" | Add `origin` and push `main`                                                                                 |
| "git fetch failed" every five minutes         | Host offline, or stored credentials expired — run `git fetch` manually                                       |
| "working tree has uncommitted changes"        | Commit/stash local edits; the script will not overwrite them                                                 |
| `state=blocked` after a failed deploy         | That commit is suspended; fix forward, or `npm run deploy:auto:force`                                        |
| "not an ancestor of origin/main"              | Local commits or a force-push on GitHub; reconcile manually                                                  |
| Loops on "did not report Startup complete"    | Read `logs\bot.log`; the previous commit is restored automatically                                           |
| Task shows "Last Run Result 0x1"              | A check failed; `.run\deploy-state.json` and `logs\deploy.log` say which                                     |
| Nothing happens after a push                  | Confirm the task is enabled and the user is logged on                                                        |
| Rollback also fails                           | Start the bot manually, fix the commit on `main`, then re-run the task                                       |
| "pg_dump was not found" in the log            | Install the PostgreSQL client tools or add their `bin` to `PATH`; the deploy continues without a backup      |
| Bot restarts in the middle of a deploy        | The watchdog was not paused: check that it uses `watchdog.pause` in its folder, or pass `-WatchdogPauseFile` |
| Watchdog log says the task is absent          | Re-create the bot task with `npm run bot:autostart` (the console watches that exact name)                    |
| A pause file is left behind after a crash     | Delete `C:\Users\natte\OpenClawConsole\watchdog.pause`; a deploy only removes one it created                 |

Useful checks:

```powershell
schtasks /Query /TN Kype-AutoDeploy /V /FO LIST
Get-Content .run\deploy-state.json
Get-Content logs\deploy.log -Tail 100
npm run bot:status
```

---

## Limits worth knowing

- The task runs only while the deployment user is logged on. Enable automatic
  logon on a 24/7 host; otherwise a reboot leaves both the bot and deployments
  stopped until someone signs in.
- One deployment at a time; an overlapping run exits immediately.
- No blue/green or rolling deployment: a single-process bot is stopped for the
  install/build/test window (typically under two minutes).
- While a deployment holds the pause file, the console watchdog monitors nothing
  — if the bot's supervisor dies before the deploy restarts it, the deploy's own
  readiness wait is what notices.
- A push that only changes documentation still pays the full pipeline. That is
  intentional: the pipeline is the verification.
- Rollback restores code and dependencies, not schema and not external state
  (Discord commands, uploaded assets).
- The readiness signal is the bot's own log line, not an HTTP health endpoint;
  the bot has no HTTP server.
