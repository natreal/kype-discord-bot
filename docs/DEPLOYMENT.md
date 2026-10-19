# Command deployment

How servers receive this bot's slash commands, and what makes it automatic.

**The problem this solves.** The foundation registered commands out of band:
somebody ran `npm run deploy:commands`, which targeted the development guild when
`DISCORD_DEV_GUILD_ID` was set and the global scope otherwise. That is correct for
one server and untenable for a bot distributed widely — nobody runs a script per
installation, a server the bot is added to on a Tuesday has no commands until
somebody notices, and the failure is invisible from the outside: the bot is online,
it answers nothing.

**The rule this follows.** A deployment must be safe to repeat. Every boot
re-publishes the payload only where it actually differs, asks Discord what each
server genuinely holds, and repairs what is missing. Nothing here is a one-shot
script that a human has to remember.

```
clientReady   ─► deployCommands()  ─┬─► PUT /applications/{id}/commands            (global)
                                    ├─► PUT …/guilds/{id}/commands  (per guild, only if behind)
                                    └─► GET … + repair any guild still missing them
guildCreate   ─► deployToGuild()   ───► the new server, immediately
/admin deploy ─► deployToGuild()   ───► one server, on demand, and verified
npm run deploy:commands ─────────────► the same service, from the shell
```

---

## What ships

| Surface                       | What it does                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| Automatic deployment on boot  | Publishes the payload on the configured scope, then verifies it           |
| Automatic deployment on join  | Registers commands in a server the moment the bot is added to it          |
| `/admin deploy [force]`       | Registers this server's commands now, and reports what Discord has        |
| `npm run deploy:commands`     | The same deployment from a shell, with a dry-run mode                     |
| `npm run deploy:guilds`       | Deploys to every guild the bot is in, and repairs whatever is behind      |
| `npm run deploy:missing`      | Deploys only to the guilds whose commands are out of date                 |
| `--clear-guild <id>`          | Clears one guild's command scope (for switching to global-only)           |
| `npm run deploy:clear-guilds` | Clears every guild's guild scope through the API, then verifies           |
| `/diagnostics` (`core`)       | `Command deployment`, `This server's commands`, `Server command coverage` |
| `command_deployments`         | Per-guild record of the last payload each server received                 |

---

## Configuration

| Variable                | Default  | Meaning                                                                         |
| ----------------------- | -------- | ------------------------------------------------------------------------------- |
| `COMMANDS_AUTO_DEPLOY`  | `false`  | Register commands without being asked. **Set to `true`** for a distributed bot. |
| `COMMANDS_DEPLOY_SCOPE` | `global` | Where a deployment writes (see below). Authoritative — always honoured.         |
| `DISCORD_DEV_GUILD_ID`  | unset    | Only used when no scope is configured; implies `dev-guild`.                     |

`COMMANDS_AUTO_DEPLOY` defaults to **off** deliberately: an existing installation
must not start registering commands just because it upgraded. Turning it on is a
conscious decision, taken once, in the environment:

```bash
COMMANDS_AUTO_DEPLOY=true
COMMANDS_DEPLOY_SCOPE=global
```

> **If commands do not appear, check these two lines first.** A missing
> `COMMANDS_AUTO_DEPLOY` means the bot publishes nothing at startup — it is the
> single most common cause, and the reason the log line
> `Automatic command deployment is disabled` exists. `/diagnostics` reports the
> effective mode under `deployment.mode`.

`COMMANDS_AUTO_DEPLOY` is read as a real boolean — `false`, `no`, `off` and `0` all
mean off. (`z.coerce.boolean()` reads `"false"` as truthy and would silently enable a
feature an operator explicitly disabled, which is why it is not used.)

### Precedence of scope settings

`COMMANDS_DEPLOY_SCOPE` **always wins**. `DISCORD_DEV_GUILD_ID` is only consulted when
no scope is configured at all, so a development guild left in `.env` can never
override an explicit scope:

| `COMMANDS_DEPLOY_SCOPE` | `DISCORD_DEV_GUILD_ID` | Effective scope |
| ----------------------- | ---------------------- | --------------- |
| `global+guilds`         | set                    | `global+guilds` |
| `global`                | set                    | `global`        |
| unset (default)         | set                    | `dev-guild`     |
| unset (default)         | unset                  | `global`        |

This precedence is not cosmetic. `DISCORD_DEV_GUILD_ID` is routinely set for local
convenience and then left set in production; when it won outright it silently confined
every deployment to that single server and left every real server with no commands at
all — a failure that looks identical to "the bot is offline".

### Deployment scopes

Discord keeps commands in two independent scopes, and **command names must be unique
within a scope, not across them**. From the [official
documentation](https://discord.com/developers/docs/interactions/application-commands):

> Command names are unique per application, per type, **within each scope (global and
> guild)**. […] **Your app can have a global and guild CHAT_INPUT command with the same
> name**

That last line is the whole subtlety: publishing the same command to both scopes is
permitted, and the client then shows **the command twice**. The scopes are not merged
into one entry and the guild copy does not replace the global one — they sit side by
side in the picker.

| Scope           | Global PUT | Per-guild PUT | Result                                            |
| --------------- | ---------- | ------------- | ------------------------------------------------- |
| `global`        | yes        | no            | One entry per command; up to an hour to propagate |
| `global+guilds` | yes        | yes           | **Two entries per command** in every server       |
| `dev-guild`     | no         | dev guild     | One entry, but only in the development guild      |

**Which to choose:**

- **`global` is the default for a distributed bot.** One entry per command, no
  duplicates, and new servers get the commands as the global scope propagates. The
  cost is propagation delay, which is Discord's, not a bug.
- **`global+guilds` is a development convenience, not a production setting.** It makes
  a server work within seconds of being added, which is genuinely useful while
  iterating — and it is why it was the default in this project's first draft. But it
  doubles every entry in every server, so it now defaults to off.
- **`dev-guild`** confines everything to one server and is only for local work.

> **Why this changed.** `global+guilds` was originally the recommended default on the
> assumption that Discord merges the two scopes into a single list. It does not. The
> symptom is a command menu where everything appears twice, which is what prompted the
> correction. The scope that produces duplicates is still available — it is the right
> tool for short-lived iteration — but it is no longer what an operator gets by
> default.

Because the two scopes are independent, switching _away_ from `global+guilds` leaves
the guild copies behind, where they would keep doubling the global ones indefinitely.
`COMMANDS_DEPLOY_SCOPE=global` only stops **new** guild copies from being written; it
cannot remove existing ones, and server settings can only delete commands one at a
time by hand. `npm run deploy:clear-guilds` does it through the API instead: `--dry-run`
reports first, `--guild <id>` narrows it to one server, and it verifies afterwards
rather than trusting the `PUT`. The global copies are never touched, so the bot keeps
working throughout.

---

## How a deployment decides to do nothing

Every guild has one row in `command_deployments` holding the SHA-256 of the payload
it last received. Before deploying, the service compares that hash against the
payload it is running, and skips the guild when they match.

The hash covers names, descriptions **and options**, so an edited option is
detected — a command _count_ would miss it, and the symptom would be a server whose
command list is subtly wrong with nothing in the log to show it.

Two consequences worth knowing:

- The payload is sorted by command name before hashing. Without that, a discovery
  order that varies between boots would look like a change and redeploy every guild
  for nothing.
- A guild with **no** row is treated as never deployed. That is exactly right for a
  server that just installed the bot, and for one that left and came back: the row
  cascades away with the guild.

---

## Why there is a verification step

A `PUT` returning 200 does **not** mean the server has the commands:

- a command can be deleted by hand in server settings;
- a deployment can be rolled back on Discord's side;
- a re-invited guild starts from nothing, even though our record still says it was
  deployed.

So after deploying, the service reads each guild's live command scope back and
repairs what is missing — and if a guild is still incomplete afterwards, the log
names it:

```
WARN  Some servers are still missing commands after deployment
      incomplete: ["Example Server (123456789012345678): missing ban, kick"]
```

That line is the point of the whole feature. A silently half-deployed bot is worse
than one that never claimed to deploy, because nobody goes looking.

---

## Health checks

`/diagnostics` reports three checks in the `core` category:

| Check                     | Reports                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `Command deployment`      | How many commands are loaded and deployable, and the scope         |
| `This server's commands`  | Whether **this** server holds all of them — a live read, per guild |
| `Server command coverage` | How many servers are behind the current payload, by name           |

`This server's commands` failing is the check to run when a member reports "the bot
doesn't respond": it separates "the commands are not registered here" from every
other reason a command can fail, and it points at `/admin deploy`.

---

## Operations

**A server is missing commands.** Run `/admin deploy` there — it registers them
immediately and reports what Discord then holds. If it also fails, the reply names
the cause; the usual one is an invite that was missing the `applications.commands`
scope.

**I changed the command interface.** Nothing to do: the fingerprint changes, so the
next boot redeploys everywhere. To do it without waiting for a restart, run
`npm run deploy:missing` (or `npm run deploy:guilds`).

**I want to check without changing anything.** `npm run deploy:commands -- --dry-run`
discovers and reports the payload; `/diagnostics` reports what each server holds.

**Every command appears twice.** Either the scope is `global+guilds`, or it was at
some point. Discord does not merge the global and guild scopes and does not deduplicate
across them, so a server that has both shows two entries for every command. Check
`deployment.scope` in `/diagnostics`; if it still reads `global+guilds`, set
`COMMANDS_DEPLOY_SCOPE=global`. Changing the setting alone does **not** remove what is
already registered — the guild copies have to be deleted:

```bash
npm run deploy:clear-guilds                    # every guild the bot is in
npm run deploy:clear-guilds -- --dry-run       # report first, change nothing
npm run deploy:clear-guilds -- --guild <id>    # just one server
npm run deploy:commands -- --clear-guild <id>  # the same for one server, via the bot
```

The global copies remain and are unaffected, so there is no window where the bot has no
commands at all.

**I am switching to global-only.** Clear the per-guild scope first, or the leftover
guild commands double every entry in the picker (see above):

```bash
npm run deploy:commands -- --clear-guild <guildId>
```

**I am developing locally.** Set `DISCORD_DEV_GUILD_ID`; commands register in that
guild and appear instantly instead of waiting for a global propagation.

**A guild keeps failing.** The service retries only what is worth retrying — `429`
and `5xx` — with a bounded backoff. A `401` or `403` fails immediately and is
reported with its HTTP status, because retrying a permission problem only delays the
message an operator needs to read.

### Flags

```
--dry-run             discover and report, register nothing
--verbose             include the raw payload in the log
--global-only         application-wide scope only
--clear-guild <id>    clear one guild's command scope
```

On `scripts/setup.ts deploy`:

```
--missing             only guilds whose recorded payload is out of date
```

---

## Testing

`tests/v6-deployment.test.ts` covers the four ways this feature can betray an
operator, against a fake REST client — no Discord connection, no network:

| Area             | What is asserted                                                      |
| ---------------- | --------------------------------------------------------------------- |
| Payload          | Sorted payload, `deploy: false` withheld, context menus excluded      |
| Fingerprint      | Stable under key reordering, changes on any real edit                 |
| Idempotency      | A second deploy is skipped, a changed payload is not                  |
| Failure handling | A failed guild is not recorded, other guilds continue, nothing throws |
| Verification     | A vanished command is repaired even though the record looks current   |
| Scopes           | Global, per-guild and dev-guild targets, and `--clear-guild`          |
| Retry policy     | `429`/`5xx` retried, `4xx` not, bounded attempts                      |

`tests/bootstrap.test.ts` additionally asserts the wiring invariants that are easy to
break silently: deployment is started but never awaited at boot, `guildCreate`
deploys _before_ running setup, and the shell script and the runtime share one
service rather than each registering commands their own way.

---

## What this module does not do

- It does **not** register commands from the runtime on every request. Deployment
  happens at startup, on join, and when asked — never inside a command handler.
- It does **not** stop the bot when Discord is unreachable. Deployment is started,
  never awaited; a failed deployment is logged, and the next boot retries it.
- It does **not** hide a failure. `failed` and `incomplete` are always logged with
  the guild name and ID.
- It does **not** manage the `applications.commands` scope of your invite link. A bot
  invited without it can never register commands in that server; `/admin invite`
  prints a correct one.
- It does **not** prune scopes the bot is no longer deployed to. A `PUT` replaces the
  whole guild scope — which is what makes a _removed_ command actually disappear —
  but a server that stopped being deployed to keeps whatever it last received.
- It does **not** re-register commands for a guild on a schedule. If you need a
  periodic sweep, that is a scheduler, not a deployment (see the roadmap).
