# Discord Bot Platform — Foundation v1

The technical foundation of a modular, production-quality Discord bot platform.

This repository intentionally contains **only the foundation**: a clean
architecture with command discovery, an event system, services, a setup system, a
database layer, logging, error handling and tests. Feature modules (AI
moderation, anti-raid, tickets, leveling, dashboard, ...) are built on top of it
without architectural rewrites.

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
- [Available commands](#available-commands)
- [Project structure](#project-structure)
- [Adding a command](#adding-a-command)
- [Adding an event](#adding-an-event)
- [Adding a module](#adding-a-module)
- [Adding a service](#adding-a-service)
- [The setup system](#the-setup-system)
- [AI foundation](#ai-foundation)
- [Security model](#security-model)
- [Cross-platform notes](#cross-platform-notes)
- [Roadmap](#roadmap)

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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/discord_bot?schema=public
LOG_LEVEL=info
```

| Variable               | Required                   | Description                                                   |
| ---------------------- | -------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`             | no (default `development`) | `development`, `test` or `production`                         |
| `DISCORD_TOKEN`        | **yes**                    | Bot token (Developer Portal → Bot → Token)                    |
| `DISCORD_CLIENT_ID`    | **yes**                    | Application ID (Developer Portal → General Information)       |
| `DISCORD_DEV_GUILD_ID` | no                         | When set, commands register in that guild for instant updates |
| `DATABASE_URL`         | **yes**                    | PostgreSQL connection string                                  |
| `LOG_LEVEL`            | no (default `info`)        | `debug`, `info`, `warn` or `error`                            |

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

| Script                            | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `npm run dev`                     | Development with watch mode                        |
| `npm run build`                   | `db:generate` + TypeScript build into `dist/`      |
| `npm run start`                   | Run the compiled output                            |
| `npm run typecheck`               | Type-check without emitting                        |
| `npm run lint` / `lint:fix`       | ESLint                                             |
| `npm run format` / `format:check` | Prettier                                           |
| `npm test` / `test:watch`         | Vitest                                             |
| `npm run db:generate`             | Generate the Prisma client                         |
| `npm run db:migrate`              | Create/apply migrations (development)              |
| `npm run db:migrate:deploy`       | Apply migrations (production)                      |
| `npm run db:smoke`                | Verify the database layer against a live server    |
| `npm run db:studio`               | Prisma Studio                                      |
| `npm run deploy:commands`         | Register slash commands with Discord               |
| `npm run whoami`                  | Confirm the token, bot identity and visible guilds |
| `npm run setup:plan`              | Preview the automatic setup actions (dry run)      |
| `npm run setup:run`               | Apply the automatic setup to the dev guild         |
| `npm run invite`                  | Print the pre-configured invite link               |

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
- the logger (levels, redaction, context, sink isolation, error resilience),
- utilities (path handling, retries, custom IDs, presenters).

Tests never touch the network, Discord or PostgreSQL.

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

Slash commands are registered by a dedicated script — **never on bot startup**.
This avoids rate limits and keeps the runtime free of deployment side effects.

```bash
npm run deploy:commands                       # register with Discord
npm run deploy:commands -- --dry-run          # show what would be sent
npm run deploy:commands -- --verbose          # include the raw payload
npm run deploy:commands -- --clear-guild <id> # clear guild-scoped commands
````

**Development**: set `DISCORD_DEV_GUILD_ID` in `.env`. Commands register in that
guild and appear instantly.

**Production**: leave `DISCORD_DEV_GUILD_ID` empty. Commands register globally,
which can take up to an hour to propagate.

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

---

## Available commands

| Command              | Category | Purpose                                                  |
| -------------------- | -------- | -------------------------------------------------------- |
| `/ping`              | core     | Liveness, gateway latency and database latency           |
| `/about`             | core     | Version, environment, uptime, library versions           |
| `/help`              | utility  | Command reference generated from the registry            |
| `/serverinfo`        | utility  | Guild statistics plus stored bot configuration           |
| `/admin invite`      | utility  | Pre-configured invite link for either permission profile |
| `/admin permissions` | utility  | Critical permissions missing in this server              |

---

## Project structure

```
src/
├── index.ts                  # process entry point (calls main())
├── app.ts                    # bootstrap + lifecycle (SIGINT/SIGTERM)
├── client/                   # intents and Discord client factory
├── commands/                 # discovery, registry, definitions
│   ├── core/                 # /ping, /about
│   └── utility/              # /help, /serverinfo
├── config/                   # env loading, Zod validation, typed config
├── events/                   # event discovery + handlers
├── interactions/             # centralized interaction handler
├── modules/                  # feature modules + setup orchestration
│   ├── ai/ core/ logging/ moderation/ security/ tickets/
│   ├── module.types.ts       # BotModule contract
│   ├── setuper.ts            # idempotent Discord resource helpers
│   └── setup.service.ts      # setup orchestration + auditing
├── services/
│   ├── config/               # guild configuration (validated, per guild)
│   ├── database/             # Prisma lifecycle + helpers
│   ├── logger/               # structured logger with pluggable sinks
│   ├── permissions/          # Discord + bot permission authorization
│   └── container.ts          # dependency injection
├── ai/                       # public AI surface (controlled tools only)
└── utils/                    # errors, filesystem, async, serialization

prisma/                       # schema + migrations
scripts/deploy-commands.ts    # slash-command registration
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
4. Run `npm run deploy:commands` to publish it.

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

The foundation is complete. Suggested next phases, in dependency order:

1. **Setup command surface** — `/setup` with subcommands and autocomplete, built
   on `SetupService.plan()` / `run()`.
2. **Logging module delivery** — a logger sink that writes to the configured
   Discord channel, fanning out by category.
3. **Moderation module** — cases, warnings, timeouts, kicks, bans, case history.
4. **Security module** — anti-raid (join-rate and account-age heuristics),
   anti-nuke (audit-log thresholds), lockdown.
5. **Ticket module** — private channels, staff assignment, transcripts.
6. **AI module** — assistant and moderation assist, exclusively through
   `AiToolRegistry`.
7. **Leveling / economy / automation**, then the web dashboard and public API.

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
