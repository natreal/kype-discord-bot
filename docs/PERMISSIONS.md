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

Two independent layers, both in `PermissionService`:

1. **Discord permissions** — what Discord itself enforces. `Administrator` and
   the guild owner bypass these, matching Discord's semantics (the owner
   implicitly holds every permission).
2. **Named bot permissions** — application policy: `moderation.ban`,
   `security.lockdown`, `tickets.manage`, and so on (19 in total, see
   `BOT_PERMISSIONS`). These map onto Discord permissions through
   `BOT_PERMISSION_MAP`, so a module can be written against the catalog today and
   switch to custom role overrides later without touching its logic.

**Administrators bypass layer 1 but not layer 2.** This is deliberate: an
Administrator install must not silently disable the policy that future moderation
and ticket modules rely on. It is covered by a test
(`administrators bypass Discord checks but not application policy`).

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
