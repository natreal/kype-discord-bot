# Bot permissions and installation

This document explains how the bot is installed on a server, which permissions it
needs, and how the permission model works internally.

---

## TL;DR — generating your invite link

```bash
npm run invite              # recommended (granular) permissions
npm run invite:admin        # administrator profile, pre-selected guild
```

Both scripts read `DISCORD_CLIENT_ID` (and `DISCORD_DEV_GUILD_ID`) from `.env`,
so the link always matches the deployed configuration.

---

## Two installation profiles

The codebase supports both, because they are legitimate choices with different
trade-offs.

### `recommended` — least privilege

Granular permissions, no `Administrator`. This is what Dyno, Wick and the native
AutoMod use. Every planned feature works, including anti-nuke.

| Permission                                                                   | Needed for                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| View Channel, Send Messages, Embed Links, Attach Files, Read Message History | Basic operation                                                                    |
| Use External Emojis/Stickers, Add Reactions                                  | Basic operation                                                                    |
| Manage Server                                                                | Automatic setup, `/config`                                                         |
| Manage Roles                                                                 | Auto-roles, quarantine role, anti-nuke                                             |
| Manage Channels                                                              | Setup, lockdown, ticket creation                                                   |
| Manage Webhooks                                                              | Anti-spam via webhooks                                                             |
| Manage Nicknames                                                             | Moderation                                                                         |
| Moderate Members                                                             | Timeouts                                                                           |
| Kick/Ban Members                                                             | Moderation, anti-raid                                                              |
| Manage Messages, Manage Threads                                              | Anti-spam, purge                                                                   |
| **View Audit Log**                                                           | **Anti-nuke: mandatory.** Without it the bot cannot know _who_ performed an action |
| Create Instant Invite                                                        | Invite tracking (anti-raid)                                                        |
| Mention Everyone                                                             | Controlled mass notifications                                                      |
| Connect, Speak                                                               | Future voice module                                                                |

Permission value: `1255073639671`

### `administrator` — the operator's explicit choice

Single permission, simplest onboarding. Permission value: `8`.

**Choose it knowingly.** The trade-offs are real and are documented in
`guildCreate`, which logs a warning on every join:

- An Administrator bot cannot sanction another administrator. Discord forbids a
  bot from acting on a member whose highest role is at or above its own. This
  limits anti-nuke against rogue admins specifically.
- A leaked token becomes total control over every server the bot is in, rather
  than access limited to the granted permissions.
- Servers that vet invites will reject it.

---

## How the permission model works

Three independent layers, all in `PermissionService`:

1. **God Access** — a single operator-owned Discord _user_ ID that bypasses
   everything (see below).
2. **Discord permissions** — what Discord itself enforces. `Administrator` and the
   guild owner bypass these, matching Discord's semantics (the owner implicitly
   holds every permission).
3. **Named bot permissions** — application policy: `moderation.ban`,
   `security.lockdown`, `tickets.manage`, and so on (21 in total, see
   `BOT_PERMISSIONS`). These map onto Discord permissions through
   `BOT_PERMISSION_MAP`, so a module can be written against the catalog today and
   switch to custom role overrides later without touching its logic.
4. **Granular V3 permissions** — the identifiers in
   `src/services/authorization/permissions.ts` (`moderation.ban`,
   `moderation.unban`, ...), granted through a role → permission class binding
   (`role_permission_classes`). A command declares them with
   `permissions: { custom: [...] }`, and the interaction handler evaluates them
   through `AuthorizationService`, so a server can hand out moderation powers
   without granting Discord's own permissions.

**Administrators bypass layers 2 and 4 but not layer 3.** This is deliberate: an
Administrator install must not silently disable the policy that the moderation
and ticket modules rely on. It is covered by a test
(`administrators bypass Discord checks but not application policy`).

### Moderation permissions (V4)

Every moderation command requires a Discord permission _and_ a granular one, which
is what makes least-privilege moderation possible:

| Command                  | Granular permission  | Discord permission              |
| ------------------------ | -------------------- | ------------------------------- |
| `/warn`, `/unwarn`       | `moderation.warn`    | Moderate Members                |
| `/warnings`, `/history`  | `moderation.view`    | Moderate Members                |
| `/mute`, `/unmute`       | `moderation.mute`    | Moderate Members + Manage Roles |
| `/timeout`, `/untimeout` | `moderation.timeout` | Moderate Members                |
| `/kick`                  | `moderation.kick`    | Kick Members                    |
| `/ban`, `/softban`       | `moderation.ban`     | Ban Members                     |
| `/unban`                 | `moderation.unban`   | Ban Members                     |
| `/purge`                 | `moderation.purge`   | Manage Messages                 |

The built-in classes distribute them the way a server usually wants: `helper`
gets warnings and purge, `moderator` adds mute/timeout/kick, and
`senior-moderator` adds ban/unban/softban. `bot-manager` and `support` get none
of them.

### Ticket permissions (V6)

Tickets have two audiences, and the bot enforces the difference rather than relying on
the panel being hard to find:

| Action                                     | Who may do it                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Open a ticket                              | Every member                                                                                                          |
| See the guild queue (`/ticket list`)       | `tickets.view` / `tickets.manage` holders, the configured ticket staff role, and the roles named on a ticket category |
| Claim, read a transcript, delete a channel | The ticket's staff; delete additionally requires `tickets.manage`                                                     |
| Close a ticket                             | The ticket's staff                                                                                                    |
| Post the panel, edit categories            | `tickets.manage`                                                                                                      |

A role named on **one** category only sees that category's tickets; a holder of
`tickets.view` sees every category. A member who runs `/ticket list` is shown only the
tickets they opened, never the queue. `/settings set area:tickets
setting:tickets-member-limit value:<1-25>` caps how many open tickets one member may
hold (default `3`).

Every staff class (`support`, `helper`, `moderator`, `senior-moderator`,
`bot-manager`) also grants `ai.use`, the permission that gates the assistant's
tools, so binding a staff role keeps `/ai` and AI tool calls working for the
people who need them. Only `bot-manager` grants `ai.configure`; no class below
`administrator` can change the AI's settings.

### God Access

God Access is the top level of authority: the operator who deploys the bot keeps
full control even in a server where they hold no Discord permissions.

| Property    | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Subject     | One Discord **user** ID (never a role, token or environment variable)    |
| Effect      | Every command, every module, every layer bypassed                        |
| Defined in  | `GOD_ACCESS_USER_ID` (`src/modules/setup/setup-module.ts`)               |
| Enforced in | `PermissionService.check()` / `bypassesDiscordChecks()`                  |
| Audited     | Every command and setup run that uses it is logged as a privileged event |

Design notes:

- It is a _user_ ID, so no guild administrator can grant it to themselves.
- It cannot be changed at runtime (no configuration file, no database row), so a
  compromised database cannot escalate privileges.
- The value is validated as a Discord snowflake at import time; a typo fails the
  process start rather than silently disabling the authority.
- It is not a substitute for the _bot's_ permissions: God Access grants a human
  authority over the bot, not Discord powers to the bot. Setup still requires the
  bot to hold `Manage Channels` and `Manage Roles`.
- It also overrides the AI tool gate: the operator can make the assistant run any
  registered tool regardless of the Discord roles or permissions the operator
  holds — even with zero roles. `AiToolRegistry.authorize` short-circuits for the
  God Access ID before evaluating `ai.use` and the tool's granular permissions.

### Role bindings and the admin power level

A power level is granted by binding a Discord role to a class (`/roles bind`), which
grants the bot's own granular permissions **without** editing the role's Discord
permissions. Two classes deserve a note:

| Class           | Bindable | Notes                                                                                |
| --------------- | -------- | ------------------------------------------------------------------------------------ |
| `owner`         | No       | Implied by Discord (the guild owner); cannot be delegated to a role.                 |
| `administrator` | Yes      | Implied for members holding Discord's `Administrator`, **and** bindable to any role. |

Binding a role that does **not** hold Discord's `Administrator` bit to the
`administrator` power level gives every member holding that role the full set of bot
permissions — the intended way to hand out the top bot authority through a role rather
than through Discord's own `Administrator` permission.

#### Nobody can grant what they do not hold

Because a binding _is_ a grant, `/roles` enforces the subset rule: a caller may only
bind or create a role for a class whose permissions they already hold in full
(`AuthorizationService.canGrantClass()`). Concretely:

- `bot-manager` can manage `bot-manager` roles, but cannot bind a role to
  `moderator`, `senior-moderator`, `administrator` or `owner` — those classes carry
  moderation permissions `bot-manager` does not have;
- `helper` can bind `helper` only — `moderator` and up carry mute/kick, and `support`
  carries ticket management, none of which `helper` holds;
- Discord `Administrator`, the guild owner and God Access bypass the check (for every
  bindable class), and the implied `owner` class is never bindable at all;
  an unknown class denies.

This closes the escalation path where a member bound their own role — or one they
could hand out — to `administrator` and then used commands like `/ai enable`: the
class list a member holds comes from bindings only, so a class they could not grant
is a class they never hold.

Bound classes are additive, so the rule is evaluated against the caller's **effective**
permissions (the union of every class their roles are bound to), not against a single
class.

If servers ran an older build, bindings created before this check may still exist.
Audit them with:

```sql
SELECT guild_id, role_id, class_key, created_at
FROM role_permission_classes
WHERE class_key IN ('administrator', 'bot-manager')
ORDER BY guild_id, class_key;
```

Any row for a role that should not carry the bot's top authority must be removed
(`/roles unbind`) — the check only prevents new bindings; it does not retroactively
revoke a role from the members already holding it.

### Maintenance mode and the bypass set

`/maintenance on` pauses a server's commands, ticket buttons and AI keyword reply. It is
a **configuration** switch (stored in `guild_config_sections`, audited as
`config.update`), not a process kill, and it is evaluated per guild.

Four kinds of member keep working while a server is paused:

- God Access;
- the guild owner;
- members holding Discord's `Administrator`;
- holders of the granular `server.settings` permission (`bot-manager`, or a custom class
  that grants it).

The last item is deliberate: `/maintenance` itself requires `server.settings`, so the set
of people who can turn a pause **on** is exactly the set that can turn it **off**. Staff
classes (`helper`, `support`, `moderator`, `senior-moderator`) are paused like everyone
else — maintenance is about the bot's availability, not about rank.

Automod, anti-raid/anti-nuke, logging and the moderation sweeper keep running: the pause
silences conversation, not protection. An automatic window (`minutes:`) is evaluated on
read, so a restart during a window resumes the remaining time instead of losing it.

- Future anti-raid and anti-nuke modules must run member lists through
  `filterGodAccounts()` so the owner can never be caught by their own automation.

### Setup permission requirements

`/setup` requires `Manage Server`, `Manage Channels`, `Manage Roles`,
`View Channels` and `Send Messages` — derived from the `setup.run` bot permission,
so the command contains no permission logic of its own. The bot itself must hold
`Manage Channels` and `Manage Roles` (plus `View Channel` and `Send Messages`);
the preflight reports anything missing _before_ the first write.

### Missing permission diagnostics

Instead of failing silently when Discord rejects an action, the bot reports what
is missing:

- **`/admin permissions`** — lists the critical permissions the bot lacks in the
  current server, plus a corrected invite link.
- **`/admin invite`** — shows the invite link for either profile.
- **On join** (`guildCreate`) — the permission check runs before setup, so the
  operator immediately learns that, for example, `ViewAuditLog` is missing and
  anti-nuke will not work.

---

## Required gateway intents

Independent of permissions, and configured in the Developer Portal under
**Bot → Privileged Gateway Intents**:

| Intent          | Status       | Needed for                                          |
| --------------- | ------------ | --------------------------------------------------- |
| Server Members  | **Required** | Member counts, join/leave events, anti-raid         |
| Message Content | Optional     | Message-based AI moderation, anti-spam, automations |
| Presence        | Optional     | Presence-driven notifications                       |

The bot requests `Guilds` + `GuildMembers` by default. Add features by editing
`INTENT_FEATURES` in `src/client/intents.ts`.

---

## Multiple servers

The bot is designed for any number of guilds:

- Configuration is guild-scoped (`ConfigService.get(guildId)`), so servers never
  affect each other.
- The setup system runs per guild and is idempotent.
- Guild data is never deleted when the bot leaves — retention is an explicit
  future operation.
- The recommended install covers every server: one link, no per-server setup.
