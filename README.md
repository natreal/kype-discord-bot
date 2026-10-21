# Discord Bot Platform — Foundation v1 + Auto Setup v2 + Config/Auth/Diagnostics v3 + Moderation v4 + Automod/Security v5 + Automatic Deployment v6

The technical foundation of a modular, production-quality Discord bot platform.

This repository intentionally contains **only the foundation**: a clean
architecture with command discovery, an event system, services, a setup system, a
database layer, logging, error handling and tests. Feature modules (AI
moderation, anti-raid, tickets, leveling, dashboard, ...) are built on top of it
without architectural rewrites.

V3 adds the three layers every future module builds on:

- **guild configuration** — per-section storage with defaults, provenance and
  validation (`/settings`);
- **authorization** — one central pipeline for Discord permissions, custom
  permissions (role → class → permission) and the God Access bypass;
- **diagnostics** — an extensible registry of health checks (`/diagnostics`);
- a **setup engine** on top of V2: `plan`, `validate` and `repair`.

V4 adds **classic moderation**: `/warn`, `/mute`, `/timeout`, `/kick`, `/ban`,
`/purge`, `/history`, with granular permissions, an audit trail, real delivery to the
guild's log channel, and one service that every caller goes through.

V5 adds **automod and security**, on top of V4 rather than beside it:

- **automod** — nine rules, each independently configurable, escalating through the
  _existing_ moderation actions;
- **anti-raid** — join-rate burst detection that distinguishes a raid from a viral
  moment, quarantine through moderation, automatic lockdown and recovery;
- **anti-nuke** — destructive-action detection from the audit log that **strips the
  culprit's permissions instead of banning them**;
- **security logs** — a dedicated channel, separate from the moderation log;
- **backups** — snapshots that turn "we stopped it" into "we recovered".

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/MODERATION.md`](docs/MODERATION.md).

V6 makes the bot **deployable at scale**: slash commands are published
automatically, so every server that has the bot gets its commands — including
servers joined while it is running — and every server that is behind is repaired and
named, rather than left with a silently empty command list.

---

## Table of contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment configuration](#environment-configuration)
- [PostgreSQL setup](#postgresql-setup)
- [Prisma setup](#prisma-setup)
- [Development](#development)
- [Building](#building)
- [Testing](#testing)
- [Linting and formatting](#linting-and-formatting)
- [Command deployment](#command-deployment)
- [Automated deployment (GitHub to Windows PC)](#automated-deployment-github-to-windows-pc)

- [Available commands](#available-commands)
- [Project structure](#project-structure)
- [Adding a command](#adding-a-command)
- [Adding an event](#adding-an-event)
- [Adding a module](#adding-a-module)
- [Adding a service](#adding-a-service)
- [The setup system](#the-setup-system)
- [Auto Setup (V2)](#auto-setup-v2)
- [V3: configuration, authorization and diagnostics](#v3-configuration-authorization-and-diagnostics)
- [AI foundation](#ai-foundation)
- [Security model](#security-model)
- [Cross-platform notes](#cross-platform-notes)
- [Roadmap](#roadmap)
- [Module reference: moderation (V4)](docs/MODERATION.md)
- [Module reference: automod and security (V5)](docs/SECURITY.md)
- [Command deployment (V6)](docs/DEPLOYMENT.md)

---

## Architecture

```
Discord ─► events/ ─► InteractionHandler ─► commands/ (thin)
                          │                      │
                          │                      ▼
                          │                  modules/  (feature logic)
                          │                      │
                          ▼                      ▼
                       services/  (config, database, permissions, logger)
```

Principles enforced by the codebase:

| Principle                   | How it is enforced                                        |
| --------------------------- | --------------------------------------------------------- |
| Separation of concerns      | Commands describe intent and delegate to modules/services |
| No global state             | One service container, injected into commands and events  |
| No manual wiring            | Commands and events are discovered from the filesystem    |
| Validated configuration     | Zod schemas for environment and per-guild configuration   |
| Secrets stay secret         | Single config layer, logger redaction, `.env` git-ignored |
| Errors never leak internals | Centralized error taxonomy + safe user-facing messages    |
| Cross-platform              | `node:path`, no shell assumptions, no hardcoded paths     |
| Testability                 | Services are constructor-injected and covered by Vitest   |

---

## Requirements

| Requirement | Version                       | Notes                           |
| ----------- | ----------------------------- | ------------------------------- |
| Node.js     | **>= 24** (developed on 26.x) | `node --version`                |
| npm         | >= 10                         | bundled with Node.js            |
| PostgreSQL  | >= 14                         | required for the database layer |
| Git         | any recent version            | optional but recommended        |

> **Why Node 24+?** Prisma ORM 7 requires Node ≥ 20.19, and the project targets
> modern ESM (`NodeNext`) throughout.

---

---

## Environment configuration

All configuration is read once, validated with Zod and exposed through a typed
layer. Nothing else in the codebase reads `process.env`.

```dotenv
NODE_ENV=development
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_DEV_GUILD_ID=
COMMANDS_AUTO_DEPLOY=true
COMMANDS_DEPLOY_SCOPE=global
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/discord_bot?schema=public
LOG_LEVEL=info
```

| Variable                | Required                   | Description                                             |
| ----------------------- | -------------------------- | ------------------------------------------------------- |
| `NODE_ENV`              | no (default `development`) | `development`, `test` or `production`                   |
| `DISCORD_TOKEN`         | **yes**                    | Bot token (Developer Portal → Bot → Token)              |
| `DISCORD_CLIENT_ID`     | **yes**                    | Application ID (Developer Portal → General Information) |
| `DISCORD_DEV_GUILD_ID`  | no                         | Development guild, `dev-guild` scope, and setup scripts |
| `COMMANDS_AUTO_DEPLOY`  | no (default `false`)       | Register commands on every server, automatically        |
| `COMMANDS_DEPLOY_SCOPE` | no (default `global`)      | `global`, `global+guilds` or `dev-guild`                |
| `DATABASE_URL`          | **yes**                    | PostgreSQL connection string                            |
| `LOG_LEVEL`             | no (default `info`)        | `debug`, `info`, `warn` or `error`                      |

Startup fails immediately (with a redacted, field-by-field report) when a
required value is missing or malformed. Secret values are never printed.

Consumers read configuration through the typed layer:

```ts
config.environment; // "development" | "test" | "production"
config.isProduction;
config.discord.token;
config.discord.clientId;
config.discord.devGuildId;
config.database.url;
config.logging.level;
```

### Privileged intents

The `Guilds` and `GuildMembers` intents are requested by default. Enable
**Server Members Intent** in the Developer Portal under
**Bot → Privileged Gateway Intents** before the first run.

Additional intents are added by extending `INTENT_FEATURES` in
`src/client/intents.ts` — never by editing the bootstrap.

---

## PostgreSQL setup

Any PostgreSQL 14+ instance works (local, Docker, Neon, Supabase, RDS, ...).

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16
createdb discord_bot

# Debian/Ubuntu
sudo apt install postgresql
sudo systemctl start postgresql
sudo -u postgres createdb discord_bot
```

Windows: use the PostgreSQL installer, then create the database through pgAdmin
or `createdb.exe` from `C:\Program Files\PostgreSQL\<version>\bin`.

Docker alternative (identical on every OS):

```bash
docker run --name discord-bot-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=discord_bot -p 5432:5432 -d postgres:16
```

Then set `DATABASE_URL` in `.env` to match your instance.

---

## Prisma setup

This project uses **Prisma ORM 7**, which requires:

- the `prisma-client` generator with an explicit `output` path
  (`src/generated/prisma`),
- a `prisma.config.ts` file declaring the schema and datasource,
- the PostgreSQL **driver adapter** (`@prisma/adapter-pg`) at runtime.

````bash
npm run db:generate          # generate the typed client
npm run db:migrate           # create + apply migrations (development)
npm run db:migrate:deploy    # apply existing migrations (production)

---

## Development

```bash
npm run dev
````

Runs `tsx watch` against `src/index.ts` with `.env` loaded, restarting on
changes. Expected output:

```
[INFO]  app Application starting
[INFO]  app Loaded 4 command(s)
[INFO]  app Loaded 4 event(s)
[INFO]  app:database Database connected
[INFO]  app Discord client ready
[INFO]  app Startup complete
```

Pressing `Ctrl+C` triggers a graceful shutdown that destroys the Discord client
and closes the database pool.

### npm scripts

| Script                            | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `npm run dev`                     | Development with watch mode                          |
| `npm run build`                   | `db:generate` + TypeScript build into `dist/`        |
| `npm run start`                   | Run the compiled output                              |
| `npm run typecheck`               | Type-check without emitting                          |
| `npm run lint` / `lint:fix`       | ESLint                                               |
| `npm run format` / `format:check` | Prettier                                             |
| `npm test` / `test:watch`         | Vitest                                               |
| `npm run db:generate`             | Generate the Prisma client                           |
| `npm run db:migrate`              | Create/apply migrations (development)                |
| `npm run db:migrate:deploy`       | Apply migrations (production)                        |
| `npm run db:smoke`                | Verify the database layer against a live server      |
| `npm run setup:resource-smoke`    | Verify setup resource identity against a live DB     |
| `npm run db:studio`               | Prisma Studio                                        |
| `npm run deploy:commands`         | Register slash commands with Discord                 |
| `npm run deploy:guilds`           | Deploy commands to every guild and repair drift      |
| `npm run deploy:missing`          | Deploy only to guilds that are behind                |
| `npm run deploy:clear-guilds`     | Clear every guild's guild-scope commands (migration) |
| `npm run whoami`                  | Confirm the token, bot identity and visible guilds   |
| `npm run setup:plan`              | Preview the automatic setup actions (dry run)        |
| `npm run setup:run`               | Apply the automatic setup to the dev guild           |
| `npm run invite`                  | Print the pre-configured invite link                 |

---

## Building

```bash
npm run build    # db:generate + tsc --build
npm run start    # run dist/
```

`tsconfig.generated.json` compiles the Prisma client into `dist/generated` first,
then `tsconfig.json` compiles the application into `dist/`. Module discovery
resolves `src/` or `dist/` automatically (`sourceRoot()`), so no configuration
switch is needed between development and production.

---

## Testing

```bash
npm test                      # single run
npm run test:watch            # watch mode
npx vitest run --coverage     # coverage report
```

Current coverage of the foundation:

- environment validation and secret redaction,
- guild configuration defaults, merging, validation and isolation,
- the permission service (Discord layer + bot permission catalog),
- command discovery (nested folders, filtering, malformed modules),
- the command registry,
- the setup service (idempotency, failure isolation, auditing),
- the automatic setup module (resource registry, bot preflight, God Access),
- setup resource identity (creation, reuse, adoption, stale-reference recovery,
  concurrent runs, unique constraints, write failures),
- setup permissions (authorization, mapped Discord permissions, overwrite planning),
- the end-to-end `/setup` flow (first run, re-run, manual deletion, adoption),
- the logger (levels, redaction, context, sink isolation, error resilience),
- utilities (path handling, retries, custom IDs, presenters),
- **V3 configuration** (defaults, provenance, guild isolation, validation
  failures, corrupt-section recovery, revisions and auditing),
- **V3 authorization** (Discord permissions, custom permissions via role bindings,
  the God Access bypass, guild isolation, structured outcomes),
- **V3 diagnostics** (registry, category selection, throwing checks, healthy and
  failing servers, missing permissions and resources, invalid configuration,
  simultaneous failures, guild scoping),
- **V3 setup engine** (`plan`/`validate` are non-mutating, `repair` recreates only
  what is broken, idempotency, adoption, dependency ordering).

Tests never touch the network, Discord or PostgreSQL. The one path that does need
a live server — the real Prisma repositories and the V3 migration — is covered by
`npm run db:smoke`.

---

## Linting and formatting

```bash
npm run lint          # ESLint
npm run lint:fix
npm run format        # Prettier
npm run format:check
```

TypeScript runs in `strict` mode with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride` and `noUnusedLocals` enabled.
ESLint uses type-aware rules for `src/`, and `console` usage is banned outside the
console log sink.

npm run db:studio # inspect data (optional)

````

An initial migration is committed in `prisma/migrations/20260916000000_init`.
Apply everything with:

```bash
npm run db:migrate:deploy
```

Verify the database layer end to end against a live server:

```bash
npm run db:smoke -- --cleanup
```

This exercises the real `DatabaseService`: connect, health check, guild upsert
idempotency, configuration read/write with partial-merge preservation, and
setup-run persistence. It is the one path the unit suite cannot cover, because it
needs an actual PostgreSQL server. The same check runs in CI against a
`postgres:16` service container.

> **Homebrew note (macOS):** `brew install postgresql@16` creates a role named
> after your macOS user, not `postgres`. Either create the role with
> `psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"`
> or point `DATABASE_URL` at your own username.

---

## Command deployment

Slash commands are **published automatically** so that every server that has the bot
receives them — including servers joined for the first time. This is the behaviour a
publicly distributed bot needs: nobody runs a script per installation, and a server
that installed the bot while it was running would otherwise show an empty command
list.

```bash
# Automatic (recommended for a distributed bot) — set in .env:
COMMANDS_AUTO_DEPLOY=true
COMMANDS_DEPLOY_SCOPE=global
```

Deployment then happens at startup, when the bot joins a server, and on demand:

| Command                        | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `/admin deploy`                | Register this server's commands now, and verify them       |
| `npm run deploy:commands`      | Register from a shell (the same service the runtime uses)  |
| `npm run deploy:guilds`        | Deploy to every guild, and repair whatever is behind       |
| `npm run deploy:missing`       | Deploy only to guilds whose commands are out of date       |
| `npm run deploy:clear-guilds`  | Clear every guild's guild scope — undoes `global+guilds`   |

```bash
npm run deploy:commands -- --dry-run          # show what would be sent
npm run deploy:commands -- --verbose          # include the raw payload
npm run deploy:commands -- --global-only      # application-wide scope only
npm run deploy:commands -- --clear-guild <id> # clear one guild's command scope

npm run deploy:clear-guilds                   # clear every guild's guild scope
npm run deploy:clear-guilds -- --dry-run      # report the duplicates first
```

If a server already lists every command twice, `COMMANDS_DEPLOY_SCOPE=global` is not
enough on its own: it stops new guild copies from being written but leaves the existing
ones, which are separate objects from the global ones. `npm run deploy:clear-guilds`
removes them and verifies the result.

**Scope.** `global` (the default) registers each command once, application-wide.
`global+guilds` also publishes per guild: the global registration is the baseline
every server eventually shares, and the per-guild registration is what makes a server
that just installed the bot usable immediately instead of after up to an hour of
propagation.

That immediacy has a cost, which is why it is no longer the default. Discord scopes
commands globally *or* per guild and treats a name as unique **within** a scope, not
across them — the [docs](https://discord.com/developers/docs/interactions/application-commands)
state plainly that an app "can have a global and guild CHAT_INPUT command with the
same name". The two scopes are not merged and neither shadows the other, so a server
receiving both shows **every command twice**. Use `global+guilds` while iterating, and
`npm run deploy:clear-guilds` to remove the guild copies when you switch back.

| Scope           | Per command        | Propagation  |
| --------------- | ------------------ | ------------ |
| `global`        | one entry          | up to 1 hour |
| `global+guilds` | **two entries**    | immediate    |
| `dev-guild`     | one entry, one guild | immediate  |

**Idempotent.** Each guild's last published payload is hashed and stored in
`command_deployments`, so a restart in a thousand servers does not produce a
thousand pointless API calls — only servers that are genuinely behind are
redeployed. A `PUT` returning 200 is then verified by reading the guild's live
command scope back, so a command deleted by hand in server settings is repaired and
reported rather than silently missing.

**Without automatic deployment.** Leave `COMMANDS_AUTO_DEPLOY=false` and run
`npm run deploy:commands` when you want commands published. Setting
`DISCORD_DEV_GUILD_ID` registers in that single guild, where updates appear
instantly.

### "The commands are registered, but Discord shows none"

Almost always propagation, not deployment. Under `global` — the default — Discord
caches the application's commands for **up to an hour** and fans them out slowly, so a
brand-new command can be registered successfully and still be invisible in a client
that has not received it yet. The scope table above is the tradeoff; the point here is
that a missing command is not by itself evidence of a failed deployment.

Confirm what Discord actually holds before changing anything:

```bash
# What Discord has, for the whole application:
curl -s -H "Authorization: Bot $DISCORD_TOKEN" \
  "https://discord.com/api/v10/applications/$DISCORD_CLIENT_ID/commands" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d), [c["name"] for c in d])'
```

If the command is in that list, the deployment worked. Then, in order:

1. Reload the client (`Ctrl+R` / `⌘R`) — the client caches the list independently
   of the server-side fan-out.
2. Check **Server Settings → Integrations → your bot** — the commands must be
   listed and enabled for *that* server.
3. Only then suspect the bot. Startup logs the truth in one line:
   `app:command-deploy Command deployment finished`, carrying `global`, `commands`,
   `deployed`, `skipped`, `failed` and `repaired` counts.

To skip the wait while iterating, set `COMMANDS_DEPLOY_SCOPE=dev-guild` and restart:
guild-scoped commands appear immediately. Reach for `global+guilds` only when *every*
server must be immediate, and clear it afterwards.

Full details, failure modes and health checks: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## Inviting the bot

```bash
npm run invite          # recommended (granular) permissions
npm run invite:admin    # administrator profile, pre-selected guild
```

Both read the IDs from `.env` and print a pre-configured OAuth2 link with the
`bot` and `applications.commands` scopes. See **[docs/PERMISSIONS.md](docs/PERMISSIONS.md)**
for the two installation profiles, the reasoning behind each permission, and how
the two-layer permission model works.

Useful in-Discord tooling:

| Command              | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `/admin invite`      | Show the invite link for either profile                     |
| `/admin permissions` | List critical permissions the bot is missing in this server |
| `/admin deploy`      | Register this server's commands now, and verify the result  |

---

## Available commands

| Command              | Category | Purpose                                                   |
| -------------------- | -------- | --------------------------------------------------------- |
| `/setup plan`        | utility  | Preview what setup would do (**no Discord mutation**)     |
| `/setup run`         | utility  | Configure the server automatically (idempotent)           |
| `/setup status`      | utility  | Show managed resources and detect drift                   |
| `/setup validate`    | utility  | Check the server against the expected setup state         |
| `/setup repair`      | utility  | Recreate **only** the resources that are missing/broken   |
| `/settings view`     | utility  | Show this server's configuration, marking defaults        |
| `/settings set`      | utility  | Change one setting (validated before it is persisted)     |
| `/settings reset`    | utility  | Return an area (or everything) to defaults (owner-only)   |
| `/maintenance`       | utility  | Pause or resume commands, tickets and AI replies          |
| `/reminder`          | utility  | Personal timers; bump-again reminders after a Disboard bump |
| `/ticket`            | tickets  | Open tickets; staff queue, panel and categories           |
| `/diagnostics`       | utility  | Health report: core, permissions, resources, config, perf |
| `/ping`              | core     | Liveness, gateway latency and database latency            |
| `/about`             | core     | Version, environment, uptime, library versions            |
| `/help`              | utility  | Command reference generated from the registry             |
| `/serverinfo`        | utility  | Guild statistics plus stored bot configuration            |
| `/admin invite`      | utility  | Pre-configured invite link for either permission profile  |
| `/admin permissions` | utility  | Critical permissions missing in this server               |
| `/admin deploy`      | utility  | Register this server's commands on demand, then verify    |

### Maintenance mode

`/maintenance on [reason] [minutes]` pauses the bot for **one server**: slash commands,
ticket buttons and the AI keyword reply are refused, while automod, anti-raid/anti-nuke,
logging and the moderation sweeper keep running. Members with God Access, the guild
owner, Administrators and `server.settings` holders (for example a role bound to
`bot-manager`) keep working, so a pause is always reversible with `/maintenance off`.

`action` is a required `on`/`off`/`status` choice on the one command; `reason` and
`minutes` belong to `on`. Omitting `minutes` keeps maintenance on until it is turned
off; a window survives restarts and expires on read. The state is stored per guild in
the guild configuration, so one server's maintenance never affects another. See
**[docs/MAINTENANCE.md](docs/MAINTENANCE.md)**.

### Tickets

`/ticket open category:<key> [subject]` is available to every member. It creates a
private channel visible to the opener and to the ticket's staff roles.

- `/ticket list` is the support queue. Holders of `tickets.view` / `tickets.manage`, the
  role configured with `setting:tickets-staff-role`, and roles named on a category see
  it; a role named on one category sees only that category's tickets. A member who runs
  the command sees only their own tickets, never the queue.
- `/ticket panel` and `/ticket category` require `tickets.manage`.
- In a ticket channel **Claim**, **Close**, **Transcript** and **Delete channel** are
  reserved for the ticket's staff; delete additionally needs `tickets.manage`. A member
  who opened a ticket by mistake asks the support team to close it.
- `/settings set area:tickets setting:tickets-member-limit value:<1-25>` caps how many
  tickets one member may keep open at once (default `3`). The separate one-open-ticket
  per category rule still applies.

See **[docs/PERMISSIONS.md](docs/PERMISSIONS.md)** for the full audience table.

### Reminders

`/reminder set duration:<duration> text:<what>` pings the member **in the channel where
they ran the command**, once, when the timer ends. `duration` accepts compound and
worded forms (`30m`, `1h30m`, `2 hours 15 min`, `2 days`); a bare number is refused
because `30` cannot be told apart from half an hour. Reminders last between 1 minute
and 30 days.

- `/reminder list` shows the caller's pending timers; `/reminder cancel id:<id>`
  cancels one and `/reminder clear` cancels all of them. Both are scoped to the
  caller, so an id cannot be used to read or cancel somebody else's timer.
- Setting the same reminder text again replaces the previous one instead of stacking a
  duplicate, so re-running the command is harmless.
- Reminders are rows in `scheduled_tasks` (kind `reminder.fire`). Nothing lives in
  memory, so a restart resumes them, they appear in `/scheduler list` and they are
  cancellable from there too.

**Bump reminder.** When Disboard confirms a `/bump`, the bot can post a "bump again"
reminder once the cooldown has passed (2 hours by default):

```
/settings set area:automation setting:automation-bump-channel value:#bumps
/settings set area:automation setting:automation-bump-reminder-enabled value:true
/settings set area:automation setting:automation-bump-reminder-delay value:7200
/settings set area:automation setting:automation-bump-ping-role value:@Bumpers
```

The reminder pings the member who bumped; if they have left, it pings the configured
role instead (or posts without a mention when no role is set). `automation-bump-channel`
defaults to the channel the bump was posted in, so nothing has to be configured before
switching the feature on. Only one bump reminder is pending per server, so two bumps in
a row replace the earlier timer rather than stacking two pings. The trigger is
structural — the configured bot (Disboard by default) plus the `bump` interaction name
— not text matching, so ordinary messages from that bot never start a timer.

---

## Project structure

```
src/
├── index.ts                  # process entry point (calls main())
├── app.ts                    # bootstrap + lifecycle (SIGINT/SIGTERM)
├── client/                   # intents and Discord client factory
├── commands/                 # discovery, registry, definitions
│   ├── core/                 # /ping, /about
│   └── utility/              # /help, /serverinfo, /setup, /settings, /diagnostics
├── config/                   # env loading, Zod validation, typed config
├── diagnostics/              # V3 health checks (registry + report)
│   ├── diagnostic.registry.ts   # register / runAll / runCategory
│   ├── diagnostic.report.ts     # grouped report + verdict
│   └── checks/                  # core, permissions, resources, configuration, performance
├── events/                   # event discovery + handlers
├── interactions/             # centralized interaction handler
├── modules/                  # feature modules + setup orchestration
│   ├── ai/ core/ logging/ moderation/ security/ tickets/
│   ├── setup/                # V2 automatic setup module + V3 engine
│   │   ├── setup-resources.ts          # resource registry (what setup owns)
│   │   ├── setup-resource.service.ts   # identity, reuse and recovery
│   │   ├── setup-engine.ts             # V3 plan/validate (read-only)
│   │   ├── setup-permission.service.ts # declarative overwrites + preflight
│   │   ├── setup-module.ts             # the BotModule (includes God Access)
│   │   ├── tracked-setuper.ts          # tracked Setuper implementation
│   │   └── prisma-setup-resource.repository.ts
│   ├── module.types.ts       # BotModule contract
│   ├── setuper.ts            # idempotent Discord resource helpers
│   └── setup.service.ts      # setup orchestration + run/repair/auditing
├── services/
│   ├── audit/                # V3 structured audit trail
│   ├── authorization/        # V3 central authorization + permission classes
│   ├── config/               # guild configuration (repository, validator, service)
│   ├── database/             # Prisma lifecycle + helpers
│   ├── logger/               # structured logger with pluggable sinks
│   ├── permissions/          # V1/V2 Discord + bot permission primitives
│   ├── deployment/           # V6 slash-command deployment (auto, verified)
│   └── container.ts          # dependency injection
├── ai/                       # public AI surface (controlled tools only)
└── utils/                    # errors, filesystem, async, serialization

prisma/                       # schema + migrations
scripts/deploy-commands.ts    # slash-command deployment CLI (uses the same service as the runtime)
tests/                        # Vitest suite
```

```bash
npm run db:migrate:deploy
```

---

## Adding a command

Create a file under `src/commands/<category>/`. The folder determines the
category and the file is discovered automatically.

```ts
// src/commands/moderation/ban.ts
import { SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";

export default defineSlashCommand({
  meta: {
    name: "ban",
    description: "Ban a member from the server.",
    category: "moderation",
  },
  botPermissions: ["moderation.ban"],
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member to ban").setRequired(true),
    ),
  execute: async (interaction, context) => {
    // Commands stay thin: delegate to the module/service layer.
    const { services } = context;
    await services.logger.info("Ban requested", { guildId: interaction.guildId });
    await interaction.reply({ content: "Handled by ModerationService.", ephemeral: true });
  },
});
```

Rules:

1. **One command per file**, default export.
2. `meta.category` **must** match the folder name (enforced at load time).
3. Business logic belongs in `src/modules/*`, not in the command.
4. It is deployed automatically on the next boot. Set `deploy: false` on the
   definition to keep it out of deployments while it is still being built.

Context menus use `defineContextMenuCommand` from the same module. Autocomplete
is supported through an `autocomplete` handler on the definition.

---

## Adding an event

Create a file under `src/events/`:

```ts
// src/events/guild-member-add.ts
import { defineEvent } from "./event.types.js";

export default defineEvent({
  name: "guildMemberAdd",
  execute: async (member, { services }) => {
    services.logger.info("Member joined", {
      guildId: member.guild.id,
      userId: member.id,
    });
  },
});
```

Set `once: true` for events that must fire once (`ready`). The loader appends the
`EventContext` as the last argument, so handlers receive the service container
without importing singletons. Errors thrown inside a handler are logged and can
never crash the process.

> `guildMemberAdd` requires the `guildMembers` feature (already enabled).
> Message-based events additionally require `messageContent`; enable the feature
> in `INTENT_FEATURES` (`src/client/intents.ts`) and in the Developer Portal.

---

## Adding a module

A module owns feature logic and optionally participates in server setup.

```ts
// src/modules/leveling/leveling.module.ts
import type { BotModule } from "../module.types.js";

export const levelingModule: BotModule = {
  name: "leveling",
  description: "Experience, levels and rank cards.",

  enabled: (context) => context.config.automation.enabled,

  plan: () => [
    {
      key: "leaderboard-channel",
      description: "Create the #leaderboard channel.",
      run: async (context) => {
        const { resource, created } = await context.setuper.ensureTextChannel({
          name: "leaderboard",
          topic: "Server rankings",
        });
        return { status: created ? "created" : "reused", resourceId: resource.id };
      },
    },
  ],
};
```

Register it once in `src/modules/registry.ts`:

```ts
export const botModules: readonly BotModule[] = [
  coreModule,
  loggingModule,
  moderationModule,
  securityModule,
  ticketModule,
  aiModule,
  levelingModule, // <- added
];
```

Order matters: modules that create shared resources (`core`) must come first,
because setup actions run in registration order and reuse existing resources.

---

## Adding a service

1. Create `src/services/<name>/<name>.service.ts` with a class that receives its
   dependencies (database, logger, other services) through the constructor.
2. Export the public surface from `src/services/<name>/index.ts`.
3. Add it to `AppServices` in `src/services/container.ts` if commands or events
   need it.
4. Instantiate it once in `createApplication()` (`src/app.ts`).

Never create a Prisma client, a Discord client or a module-level singleton inside
a service.

---

## The setup system

`SetupService` orchestrates modules to configure a guild **idempotently**:

```
SetupService
  ├─► coreModule.plan()        → "Bot" category
  ├─► loggingModule.plan()     → #bot-logs
  ├─► moderationModule.plan()  → Muted role, #bot-moderation
  ├─► securityModule.plan()    → #bot-security, Quarantined role
  ├─► ticketModule.plan()      → Tickets category, Support Team role
  └─► aiModule.plan()          → validates the configured assistant channel
```

Guarantees:

- **Idempotent** — resources are looked up by stored ID and then by name before
  creation, so running setup repeatedly reuses them instead of creating
  `#logs`, `#logs-2`, `#logs-3`, ...
- **Permission-aware** — `run()` accepts the invoking member and enforces
  `setup.run` through the permission service.
- **Recoverable** — one failing action is recorded and never aborts the rest; the
  run reports `completed`, `partial` or `failed`.
- **Auditable** — every run is persisted in the `setup_runs` table, and created
  resource IDs are stored in guild configuration under `setup.resources`.

The `guildCreate` event runs `setup.run(guild, "all")` automatically when the bot
joins a server. Guild data is **never** deleted when the bot leaves; retention is
an explicit, future operation.

`sections()` returns `core`, `logging`, `moderation`, `security`, `tickets` and
`ai`, so the future command tree can be wired as:

```
/setup                  → run("all")
/setup logging          → run("logging")
/setup security         → run("security")
/setup ai               → run("ai")
```

`plan(guild, scope)` already provides a dry run for a confirmation prompt.

---

## Auto Setup (V2)

`/setup` configures a server automatically: it creates the channels the platform
actually uses, **reuses** anything that already fits, and repairs resources an
administrator deleted. Re-running it is always safe.

```
/setup run [scope]     # scope: all (default) | information | logs
/setup status          # read-only: what setup manages, and what has drifted
```

### What it does

```
permission checks (user + bot)
  ↓
resolve each resource: stored Discord ID → verify → adopt by name → create
  ↓
apply the declared permission overwrites
  ↓
persist the Discord IDs and record the run
  ↓
reply with a summary
```

The command is thin; the work lives in services:

| Component                                   | Responsibility                                             |
| ------------------------------------------- | ---------------------------------------------------------- |
| `commands/utility/setup.ts`                 | Scope resolution and the Discord summary                   |
| `modules/setup/setup-module.ts`             | Declares the resources and their permission rules          |
| `modules/setup/setup-resources.ts`          | The resource registry (keys, names, permissions, ordering) |
| `modules/setup/setup-resource.service.ts`   | Identity, reuse and recovery (the idempotency contract)    |
| `modules/setup/setup-permission.service.ts` | Declarative permission overwrites + bot preflight          |
| `modules/setup/tracked-setuper.ts`          | `Setuper` implementation that resolves and writes          |
| `modules/setup.service.ts`                  | Orchestrates modules and persists the run report           |

### Permissions required

**By the user.** Running setup requires Discord `Manage Server`, `Manage Channels`,
`Manage Roles`, `View Channels` and `Send Messages`. These are derived from the
`setup.run` bot permission through the central permission service — setup never
hardcodes a permission check inside the command.

**By the bot.** Setup happens with the bot's own rights, so the installer must grant
`Manage Channels` and `Manage Roles` (`View Channel` and `Send Messages` are needed
to configure the channels it creates). `npm run invite` requests them. If anything
is missing, the run **stops before creating anything** and says exactly which
permission is missing — it never leaves a half-configured server behind.

**God Access.** One Discord user ID (the deployment owner) bypasses every check and
may use every command regardless of the Discord permissions they hold. It is a
compiled-in _user_ ID — never a role, token or environment variable — so a guild
administrator cannot grant it to themselves. It is validated at startup, and every
use is logged as a privileged event.

---

### What it creates

V2 provisions only what the platform can actually use:

| Section     | Resources                              | Access                                                |
| ----------- | -------------------------------------- | ----------------------------------------------------- |
| INFORMATION | `📁 INFORMATION`, `#welcome`, `#rules` | Readable by members; only the bot can post            |
| LOGS        | `📁 LOGS`                              | Visible but read-only; `#server-logs` is tracked only |

`#server-logs` is **tracked but not created**: logging is disabled by default and no
log delivery exists yet, so creating the channel would be noise. Enabling logging
creates it. No moderation, ticket, security or AI channels exist for the same
reason — the registry makes adding them a one-entry change once their module ships.

### Idempotency

Resources are never identified by name, because administrators rename things and a
renamed `#logs` must not become a second `#logs-2`. Instead:

1. the Discord ID is looked up for `(guildId, key)` in the `setup_resources` table;
2. that ID is verified against Discord;
3. **it exists** → reused;
4. **it no longer exists** → an existing resource with the expected name in the
   expected category is adopted, otherwise one is created;
5. the resulting ID is written back, so the next run is a single lookup.

The `(guildId, key)` unique constraint is the race-condition safety net: two
concurrent runs cannot register the same logical resource twice, and the loser
adopts the winner's channel instead of creating a duplicate.

### Recovery

Deleting a resource by hand is expected and handled:

- the stored ID becomes stale, which is logged and repaired on the next run;
- the replacement is created **once** and the database is updated;
- the run reports the resource as `repaired` rather than as a failure;
- nothing else in the server is touched.

`/setup status` shows the same drift _before_ a run, including the dangling ID.

### Re-running setup

Administrators may run `/setup run` at any time. Nothing is destroyed: setup only
creates what is missing and reuses what exists (`setup` is not a server reset tool).
To re-apply permissions after a manual change, run `/setup run` again.

### Environment and database requirements

V2 adds one migration and no new environment variables:

```bash
npm run db:migrate:deploy      # applies 20260916120000_setup_resources
npm run db:generate            # regenerate the Prisma client (also runs on build)
npm run setup:resource-smoke   # verify the identity table against a live database
```

The `setup_resources` table stores, per guild: the logical `key`, the resource
`type`, the Discord `discordId`, the last known `name`, free-form `config` and
timestamps. Discord IDs are plain text rather than foreign keys, because a deleted
channel must be recorded as _stale_ rather than cascade-deleted.

### Extending it

Future modules join the same pipeline by declaring their resources and permission
rules in the registry:

```ts
// src/modules/setup/setup-resources.ts
{
  key: "moderation.category",
  type: "CATEGORY",
  name: "MODERATION",
  label: "📁 MODERATION",
  permissions: [{ target: { kind: "everyone" }, deny: [PermissionFlagsBits.SendMessages] }],
}
```

No change to the command, the resource service or the orchestration is needed. Each
module also owns its `BotModule.plan()` actions, which `SetupService` runs in the
same pass, so `/setup logging`, `/setup moderation`, ... keep working through the
existing scope resolution.

### Testing

`tests/setup-resources.test.ts`, `tests/setup-flow.test.ts`,
`tests/setup-permissions.test.ts` and `tests/setup-module.test.ts` cover the
business logic with an in-memory Discord and database: creation, reuse, adoption,
recovery of stale references, concurrent runs, unique constraints, permission
allow/deny, bot preflight failures and God Access.

---

## V3: configuration, authorization and diagnostics

V3 keeps V1 and V2 intact and adds the three layers every future module depends
on. Nothing in V3 replaced a working mechanism: the setup registry, resource
identity/adoption, the God Access ID and the logging architecture are all reused.

### Guild configuration

```
Command (/settings) ─► ConfigService ─► GuildConfigRepository ─► Prisma
                              │
                              ├─► ConfigValidator   (validate, merge, provenance)
                              └─► AuditEventService (who changed what, and when)
```

- Storage is **per guild, per section**: `guild_config_sections` holds one row per
  `(guildId, section)` with an `updatedBy`. The V1/V2 `guild_settings.modules`
  blob is written through at the same time, so existing readers keep working and a
  V2-era installation keeps its configuration on first read.
- Reads are **tolerant**: an invalid stored section falls back to its default and
  the problem is _reported_ (`/diagnostics`, the service logs) rather than hidden.
- Writes are **strict**: `/settings set` validates before persisting, so a bad
  value never reaches the database.
- The service distinguishes **default** from **explicitly configured** values
  (`read()` returns `configuredSections` and `overriddenPaths`), which is what
  `/settings view` and `/diagnostics` display.
- Every write appends a `guild_config_revisions` row and an `audit_events` entry.

### Authorization

```
Command ─► AuthorizationService.authorize()
              ├─ God Access bypass            → ALLOW (privileged, audited)
              ├─ Discord permission check     → DENY_DISCORD_PERMISSION
              └─ Custom permission check      → DENY_CUSTOM_PERMISSION
```

- `AuthorizationService` is the only place that evaluates authorization. Commands
  declare a requirement; they never compare user IDs or call `permissions.has()`.
- `AuthorizationContext` exposes exactly what a decision needs: `userId`,
  `guildId`, `discordPermissions`, `botPermissions`, `customPermissions`, `isGod`,
  `isAdministrator` and the matched classes.
- Outcomes are structured (`ALLOW`, `DENY_DISCORD_PERMISSION`,
  `DENY_CUSTOM_PERMISSION`, `DENY_UNKNOWN_PERMISSION`, `DENY_OWNER_ONLY`), so a
  test can assert _why_ something was denied.
- Permissions are **structured identifiers** (`server.setup`, `moderation.ban`,
  `analytics.view`, ...) from a closed registry in
  `src/services/authorization/permissions.ts`. The V2 catalog is bridged rather
  than replaced, so `setup.run` and friends keep working.
- Role → permission mapping is guild-scoped: `permission_classes` +
  `role_permission_classes`, with built-in classes (Owner, Administrator, Bot
  Manager, Senior Moderator, Moderator, Helper, Support). Owner is _implied_ by
  Discord (the guild owner) and is never bound to a role. Administrator is
  implied for members holding Discord's `Administrator` **and** bindable: a role
  that does not hold the bit can be bound to the `administrator` power level from
  `/roles bind` and then grants the full set of bot permissions.
- The God Access account is still the single compiled-in ID, validated at import
  and centralized in the permission service. V3 does not add a second mechanism;
  it routes the bypass through the authorization service so it is logged and
  audited in one place.

### Diagnostics

```
DiagnosticRegistry ─► runAll() / runCategory()
        │
        ├─ core          (Discord, commands, database, Prisma schema)
        ├─ permissions   (bot permissions, setup permissions)
        ├─ resources     (registry consistency, tracked-resource drift)
        ├─ configuration (defaults valid, stored config valid)
        └─ performance   (gateway latency, database latency, process)
```

- A check is an independent object with an `id`, a `category` and a `run`. A future
  module registers its own check (`Tickets → ticket diagnostic`) and
  `/diagnostics` reports it without being modified.
- A check that throws is converted into a `fail` result, so one broken check
  cannot hide the others.
- Metrics are **measured or absent**: a database outage is reported as a failure
  rather than as a plausible-looking latency.
- Every result carries a remediation hint where one exists.
- Diagnostics are strictly guild-scoped through `DiagnosticContext`.

### Setup engine

`/setup` gained three subcommands on top of the V2 pipeline (no second resource
system was created):

| Subcommand | Mutates Discord | Purpose                                                 |
| ---------- | --------------- | ------------------------------------------------------- |
| `plan`     | never           | Deterministic CREATE/ADOPT/REUSE/REPAIR/SKIP/ERROR list |
| `validate` | never           | Per-resource `ok`/`missing`/`drifted`/`orphaned`        |
| `repair`   | yes             | Recreate only what is broken, reusing V2 adoption       |

`repair()` derives its targets from the V2 identity table, so it can never
disagree with a run about what exists, and it leaves healthy resources completely
untouched. Idempotency holds for `run`, `repair` and adoption after a manual
rename/recreate.

### Prisma

| Model                 | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `GuildConfigSection`  | validated configuration, one row per section        |
| `GuildConfigRevision` | append-only configuration history                   |
| `PermissionClass`     | permission classes (built-in and custom)            |
| `RolePermissionClass` | role → class bindings                               |
| `AuditEvent`          | structured audit trail (who/what/when/before/after) |

Migration: `prisma/migrations/20260921000000_v3_config_authorization_audit`. It is
purely additive: no existing table, column or constraint is modified.

### Adding a diagnostic (the extension point)

```ts
// src/diagnostics/checks/ticket.checks.ts
export const ticketDiagnostic: Diagnostic = {
  id: "resources.tickets",
  category: "resources",
  label: "Ticket system",
  run: (context) =>
    Promise.resolve({
      id: "resources.tickets",
      category: "resources",
      label: "Ticket system",
      status: "pass",
      detail: `ticket category resolved for ${context.guild?.id ?? "no guild"}`,
    }),
};
```

Register it in `src/diagnostics/checks/index.ts` (`BUILT_IN_DIAGNOSTICS`) or, from
a module, through `registry.register(...)`. `/diagnostics` needs no change.

### Verifying V3 locally

```bash
npm run db:generate      # regenerate the Prisma client
npm run db:migrate       # apply the V3 migration (or db:migrate:deploy)
npm run db:smoke         # live database: config sections, revisions, audit, classes
npm run typecheck        # TypeScript
npm run lint             # ESLint
npm run format:check     # Prettier
npm test                 # V1 + V2 + V3 suites
```

### Running the bot as a desktop app (macOS)

The bot is designed to run unattended. `scripts/desktop/` provides a double-clickable
launcher and an optional login item:

```bash
npm run desktop:app          # (re)build "Discord Bot.app" in the project root
npm run bot:start            # start it (same as double-clicking the icon)
npm run bot:status           # is it running, and since when
npm run bot:stop             # stop it gracefully
npm run bot:logs             # follow logs/bot.log
npm run bot:autostart        # start automatically at login
npm run bot:autostart:remove # stop starting at login
```

What the launcher guarantees, and how:

| Behaviour                           | Mechanism                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-click starts it              | `Discord Bot.app` (a real bundle, so it is a LaunchServices process, not a Terminal child)                                                              |
| Double-click again runs the new one | An atomic `mkdir` lock in `.run/lock`; a live owner is replaced via SIGTERM, a dead one is reclaimed                                                    |
| Closing windows does not stop it    | Nothing to close: the supervisor is reparented to `launchd` and logs to `logs/bot.log`                                                                  |
| Reconnects after being offline      | discord.js reconnects its own gateway; the supervisor additionally waits for Discord and PostgreSQL before retrying                                     |
| Recovers from a crash               | The supervisor relaunches the bot with a 5s→60s backoff                                                                                                 |
| Starts at login                     | `~/Library/LaunchAgents/local.discord-bot-foundation.bot.plist` runs `login-item.sh`, which waits for PostgreSQL then hands over to the same supervisor |

Notes:

- The supervisor and the login item share **one** start path (`supervisor.sh`), one
  lock and one log, so the behaviour is identical however the bot was started.
  When the login item is installed, the Desktop icon restarts the bot _through_
  launchd (`launchctl kickstart`) instead of spawning a competing supervisor.
- A login item start exports a Homebrew-inclusive `PATH`, because `launchd` gives
  agents none — without that, `node`, `npm` and `pg_isready` would all be missing.
- `pg_isready` is passed a connection string with Prisma's `?schema=...` query
  parameter stripped, since it rejects unknown parameters.

### Running the bot as a desktop app (Windows)

The same guarantees, with `Start-Bot.cmd` as the double-clickable launcher and
`scripts/windows/supervisor.ps1` as the one supervisor:

```powershell
npm run bot:start            # start it (what Start-Bot.cmd does)
npm run bot:status           # is it running, and since when
npm run bot:stop             # stop the bot and its supervisor
npm run bot:logs             # follow logs\bot.log
npm run bot:tail             # print the last lines without following
npm run bot:autostart        # start automatically at login (Task Scheduler)
npm run bot:autostart:status # show that task's state and settings
npm run bot:autostart:remove # stop starting at login
```

What the launcher guarantees, and how:

| Behaviour                   | Mechanism                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Double-click starts it      | `Start-Bot.cmd` asks `botctl.ps1` to start the task (or the supervisor); the launcher window can be closed |
| Only one bot runs           | An atomic `mkdir` lock in `.run\lock`; a live owner is replaced, a dead one is reclaimed        |
| The console output survives | `run-bot.cmd` appends node's stdout and stderr to `logs\bot.log`                                |
| Reconnects after being down | The supervisor waits for `discord.com` and for PostgreSQL before retrying                       |
| Recovers from a crash       | The supervisor relaunches the bot with a 5s→60s backoff                                         |
| Rebuilds when it must       | `npm run build` runs once at start when `src`, `prisma` or `package.json` changed               |
| Starts at login             | A Task Scheduler entry (`schtasks /SC ONLOGON`) running the same supervisor through `wscript.exe` + `Run-Hidden.vbs`, so no console flashes, with no execution time limit and restart-on-failure |

`bot:stop`, `bot:status` and `bot:logs` are `scripts/windows/botctl.ps1`, which acts
only on the pids the supervisor wrote to `.run` and releases the lock when it stops
the bot — so "stop, then start" is a clean start rather than an "another instance is
running" one. `botctl.ps1 tail` prints the last 50 log lines without following.

There is one start path, and it goes through Task Scheduler. `bot:start`,
`Start-Bot.cmd` and a logon all end up running the `kype-discord-bot` task, whose
action is the same supervisor. This matters on hosts where an external watchdog
(the OpenClaw console on this PC, `C:\Users\natte\OpenClawConsole`) restarts that
task whenever it is not running: a supervisor spawned outside the task would be
replaced by a second one within a minute. The task is registered by
`scripts/windows/register-autostart-task.ps1`, which also removes a 3-day default
execution limit, runs on battery, and restarts once a minute up to three times if
the supervisor dies. A supervisor started by hand (from a shell) is still safe —
it holds the `.run\lock` — but the task is what survives a reboot.

Log output is split by necessity. `run-bot.cmd` appends node's output with `>>`,
which cmd opens exclusively, so while the bot is running nothing else can write
`logs\bot.log`. Supervisor lines that would be refused there go to
`logs\supervisor.log` instead — that is where "Stopping leftover bot process" and
a start that reclaimed a stale lock end up. `npm run bot:tail` prints both; the
deploy's readiness check reads `logs\bot.log`, where the bot itself writes.

#### Leaving it running 24/7

Nothing in the bot polls on a timer: the scheduler sleeps until the next task is
actually due (it wakes immediately for work it schedules itself), so an idle bot does
no database work and writes nothing to the log between deadlines. The machine it runs
on can be left to idle, and Windows should be told not to sleep while plugged in:

```powershell
powercfg /change standby-timeout-ac 0   # never sleep on AC power
powercfg /change monitor-timeout-ac 15  # (optional) blank the screen, keep running
```

The one thing no bot can do is stay online on a suspended machine: a sleeping Windows
cannot hold a gateway connection. `npm run bot:autostart` removes the manual step at
the next login, and the supervisor plus the scheduler's stale-claim recovery return any
task that was mid-flight when the machine went down — so a reboot costs uptime, never
correctness.

On a host with the OpenClaw console watchdog, `npm run bot:stop` is a pause, not an
off switch: the watchdog starts the `kype-discord-bot` task again within a minute.
To keep the bot down, either stop the task (`Stop-ScheduledTask -TaskName
kype-discord-bot`, and `npm run bot:autostart:remove` so it does not return at
logon), or create the watchdog's pause file
(`New-Item C:\Users\natte\OpenClawConsole\watchdog.pause`) and delete it when you
want the bot back. Deployments use that pause file for exactly this reason.

---

## AI foundation

`src/ai/` deliberately contains **no AI implementation yet** — only the safety
boundary every future AI feature must use:

```
AI  →  controlled tool  →  permission system  →  validation  →  Discord action  →  logging
```

`AiToolRegistry` is the single choke point. Tools declare a name, a description,
required permissions, a validator and an executor. The AI never receives a
Discord client, a database client, the bot token, or the ability to execute
arbitrary code.

---

## Security model

- `.env` is git-ignored; only `.env.example` is committed.
- Secrets are validated once, never logged, and scrubbed by the logger's
  metadata redactor (`token`, `password`, `apiKey`, `authorization`, ...).
- The Discord client requests **only** the intents it needs.
- Every command declares its permissions; checks run in one place
  (`InteractionHandler` → `PermissionService`).
- Failed authorization is logged with the missing permissions, while the user
  sees a generic denial.
- Internal errors never reach users: stack traces, SQL errors and API details are
  logged server-side only.
- Input from Discord is validated with Zod before it is persisted.
- Rate-limit and Discord API failures are distinguished from programming errors.

---
## Automated deployment (GitHub to Windows PC)

The host PC **pulls**; GitHub never pushes to it. A Windows scheduled task runs
`scripts/deploy/deploy.ps1` every minute. When `origin/main` has moved, the
script stops the bot gracefully, fast-forwards, installs from the lockfile,
builds, tests, backs up PostgreSQL, applies migrations, starts the bot and waits
for its own `Startup complete` line. Any failure rolls the checkout and the
dependency tree back to the previous commit and restarts the bot.

```
git push origin main ──► GitHub ──► scheduled task (every minute)
                                       │
                                       ├─ fetch, verify clean + fast-forwardable
                                       ├─ botctl stop (graceful, file-based)
                                       ├─ npm ci → build → test
                                       ├─ pg_dump → migrate deploy → db:smoke
                                       ├─ botctl start → wait "Startup complete"
                                       └─ failure: reset --hard previous + restart
```

One-time setup (after the repository exists on GitHub):

```powershell
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
npm run deploy:task:install      # registers the Kype-AutoDeploy task
npm run deploy:auto:check        # shows what would be deployed, changes nothing
```

Day-to-day: push to `main`. Nothing else.

| Command                     | What it does                                                |
| --------------------------- | ----------------------------------------------------------- |
| `npm run deploy:auto`       | Run one deployment check now                                |
| `npm run deploy:auto:force` | Retry a commit whose deployment already failed              |
| `npm run deploy:auto:check` | Fetch and list pending commits; touch nothing               |
| `npm run deploy:auto:status`| Last recorded result, commit and error message              |
| `npm run deploy:task:install` | Register/refresh the one-minute scheduled task            |
| `npm run deploy:task:remove`  | Remove the scheduled task                                 |
| `npm run bot:restart`       | Graceful stop + start through the supervisor                |

Operational notes:

- Logs: `logs\deploy.log` (rotated at 10 MB) and `logs\bot.log`.
- Backups: `backups\pre-deploy-*.dump` (ten newest kept), ignored by git.
- Secrets: `.env` is never committed, read for preflight only, and deploy log
  lines are redacted for credentials in URLs and GitHub tokens.
- A dirty working tree, a non-`main` checkout or a diverged history stops the
  deployment instead of overwriting local work.
- Migrations are forward-only: a rollback restores code, not schema. Keep
  migrations additive.
- The scheduled task runs while the user is logged on, which matches the bot's
  own logon task. For unattended reboots, enable automatic logon on the host.
- Neither task shows a window. Both start `scripts\windows\Run-Hidden.vbs` through
  `wscript.exe`, which launches PowerShell with its console hidden from the first
  frame, so a one-minute check never flashes a console over a game.

Full details, failure handling and manual recovery: [`docs/AUTO-DEPLOY.md`](docs/AUTO-DEPLOY.md).

---



## Cross-platform notes

- No OS-specific paths: everything uses `node:path`, `process.cwd()` or the
  module's own URL (`sourceRoot()`).
- No shell assumptions: scripts run through Node.js/npm only.
- Environment files are loaded with `dotenv` for `npm run dev`; `npm run start`
  uses Node's native `--env-file-if-exists` (Node ≥ 20.6), so both behave
  identically on macOS, Linux and Windows.
- Channel-name matching normalizes case, spaces and dashes, so setup behaves
  identically regardless of Discord's name normalization.
- Verified on macOS (arm64); the codebase contains no platform conditionals, so
  Windows and Linux need no changes.

---

## Roadmap

V3 is complete: configuration, authorization, diagnostics and the extended setup
engine are in place, and every future module builds on them.

Delivered in V3:

- guild configuration (per-section rows, defaults, provenance, validation,
  revisions, `/settings view|set|reset`);
- central authorization (Discord permissions, custom permission identifiers,
  role → permission classes, centralized God Access bypass with audit events);
- diagnostics (`/diagnostics`, extensible registry, core/permissions/resources/
  configuration/performance checks);
- setup engine (`/setup plan`, `/setup validate`, `/setup repair`, idempotency and
  adoption preserved);
- structured audit trail (`audit_events`).

Delivered in V4 — **classic moderation**:

- `/warn`, `/warnings`, `/unwarn`, `/mute`, `/unmute`, `/timeout`, `/untimeout`,
  `/kick`, `/ban`, `/unban`, `/softban`, `/purge`, `/history`;
- one pipeline per action: guards → Discord call → case + audit event + log line, so
  nothing is recorded unless it actually happened;
- per-guild case numbering that cannot be handed out twice under concurrency;
- real delivery to the guild's log channel, and `moderation.*` diagnostics.

Delivered in V5 — **automod and security**, on top of V4 and never beside it:

- nine automod rules, independently configurable, with a data-driven escalation
  ladder that runs through the **existing** moderation actions;
- anti-raid with burst detection that distinguishes a raid from a viral moment,
  quarantine through moderation, automatic lockdown and automatic recovery;
- anti-nuke driven by the audit log, which **removes the culprit's permissions
  instead of banning them** and escalates to a human;
- a dedicated `#bot-security` log channel with the who/what/when/object/before-after/
  action format;
- per-guild backups with `create`/`list`/`restore`/`delete`, checksummed and
  additive, which is what repairs what anti-nuke can only stop;
- `automod.*` and `security.*` diagnostics, including the one that catches an
  enabled-but-inert automod (a missing privileged intent).

Delivered in V6 — **automatic command deployment**, which is what makes the bot
distributable rather than merely runnable:

- slash commands are published at startup and again the moment the bot joins a
  server, so a new installation works immediately instead of waiting for a global
  scope to propagate;
- deployment is **idempotent**: each guild's payload is fingerprinted in
  `command_deployments`, so a restart only touches servers that are genuinely behind
  (an edited option changes the hash; a command count would not);
- a `200` is verified by reading each guild's live command scope back, so a command
  deleted by hand in server settings is repaired — and a server that is *still*
  incomplete is named in the log rather than assumed healthy;
- `/admin deploy` fixes one server from inside Discord, and
  `npm run deploy:guilds` / `deploy:missing` do it from a shell — all through the
  same service the runtime uses, so the automatic and manual paths cannot disagree;
- `deployment.*` diagnostics report the mode, this server's coverage, and which
  servers are behind;
- failures are bounded and honest: retries only on `429`/`5xx`, never on a `4xx`, no
  throw path, and startup is never blocked by Discord being unreachable.

Suggested next phases, in dependency order. Each one is now mostly _module_ work,
because the configuration, authorization, audit and diagnostics plumbing exists:

1. **AI module** — assistant and moderation assist, exclusively through
   `AiToolRegistry`, gated by `ai.use` / `ai.configure`. The moderation service is
   callable without an interaction, so an assistant can propose an action through the
   same guards, audit trail and case history as a human.
2. **Punishment sweeper** — a background job that lifts expired mutes and timeouts.
   `expiresAt` is already written on every temporary case, and
   `SecurityService.recoverExpired()` is the pattern to follow: a persisted deadline
   swept by the process, not a timer held in memory.
3. **Scheduled backups** — the periodic snapshot worker behind
   `BackupService.capture(..., { kind: "scheduled" })`. The service, the retention
   policy and the storage are in place; only the schedule is a deployment decision.
4. **Verification sweep** — expire `verification_pending` rows for members who never
   confirmed, and surface a `/verify` flow instead of requiring staff to release
   each newcomer by hand.
5. **Role editing UI** — binding Discord roles to permission classes from inside
   Discord. The storage (`permission_classes`, `role_permission_classes`) and the
   resolution logic already exist; only the command surface is missing.
6. **Scheduled command verification** — `CommandDeploymentService.verifyAndRepair()`
   already repairs drift; what is missing is something to call it on a timer, so a
   command deleted months after a deploy is caught without waiting for a restart.
   It shares the scheduler the punishment sweeper needs.
7. **Reports, welcome/leave, automation, temporary channels and role menus** — the
   V6 data model for each already exists (`reports`, `welcome_settings`,
   `automation_rules`, `temporary_channels`, `role_menus`); the ticket module is the
   template to follow, because it establishes the shape they all repeat: a typed
   domain port, a Prisma repository with guarded transitions, a guild-bound Discord
   adapter, a service that holds the rules, and its own test suite.
8. **Leveling / economy**, then the web dashboard and public API.
   `/setup status` and the `audit_events` table already expose the
   machine-readable state a dashboard needs.

---

## License

UNLICENSED — private project. Replace with your organization's license before
publishing.

The generated client lives in `src/generated/` and is **not** committed: it is
recreated by `npm run db:generate` (also run automatically by `npm run build`).

## Installation

```bash
git clone <your-repository-url> discord-bot-platform
cd discord-bot-platform
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Then fill in `.env` (see below).
````
