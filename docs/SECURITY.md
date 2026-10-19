# Automod and Security module (V5)

Automatic moderation, anti-raid, anti-nuke, the security log and backups.

**The one rule that shapes everything here:** automod and security _decide_; the V4
moderation module is the only thing that _punishes_. Neither module owns a Discord
call that can sanction a member, so neither can widen what a sanction means, skip a
hierarchy guard, or leave a case out of `/history`. That is enforced structurally —
automod and security are constructed with `ModerationService` and never with a guild
— not by convention.

```
messageCreate ──┐
reactionAdd   ──┼─► AutomodService.evaluate() ─► ModerationService.execute() ─┐
                │      (pure)                        (the only sanction path)│
guildMemberAdd ─► SecurityService.observeJoin() ──────────────────────────────┼─► case
auditLogCreate ─► SecurityService.observeNuke() ─► strip Discord permissions  │   audit
                                               └─► SecurityLogSink            │   log
```

---

## What ships

| Surface                | What it does                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `/automod status`      | Whether the module is on, and the escalation ladder            |
| `/automod rules`       | Every rule, its state and its threshold                        |
| `/automod history`     | What automod recorded against a member                         |
| `/automod reset`       | Clears a member's sliding window (cases are kept)              |
| `/security status`     | Anti-raid and anti-nuke configuration, plus any incident       |
| `/security lockdown`   | Locks every text channel now, for a `security.lockdown` holder |
| `/security unlock`     | Restores the channels and closes the active incidents          |
| `/security quarantine` | Contains a member through moderation, as a real case           |
| `/security recover`    | Ends every incident and restores the server                    |
| `/backup create`       | Snapshots roles, channels, overwrites and configuration        |
| `/backup list`         | The guild's snapshots, newest first                            |
| `/backup restore`      | Recreates what is missing, repairs what drifted                |
| `/backup delete`       | Removes one of this guild's snapshots                          |
| `/settings automod`    | Every rule and threshold                                       |
| `/settings security`   | Anti-raid, anti-nuke and lockdown                              |

`/diagnostics category:automod` and `category:security` report the live state.

---

## Automod

Nine rules, each independently toggleable from `/settings automod`, each with its own
threshold:

| Rule                     | Fires on                                                    |
| ------------------------ | ----------------------------------------------------------- |
| `anti-spam`              | Too many messages in the sliding window                     |
| `anti-flood`             | One account posting across many channels at once            |
| `anti-mention-spam`      | Too many mentions in one message                            |
| `anti-link`              | Too many links in one message                               |
| `anti-invite`            | A Discord invite link (how raids are recruited)             |
| `anti-caps`              | Shouting: a mostly-uppercase message above a minimum length |
| `anti-repeated-messages` | The same message posted over and over                       |
| `anti-emoji-spam`        | Too many emojis in one message                              |
| `anti-mass-reactions`    | Reacting faster than a human can read                       |

### Why some of the details matter

**`anti-invite` is judged before `anti-link`.** An invite _is_ a link, so a server
with `anti-link` off and `anti-invite` on would otherwise be told "too many links" by
a rule it never enabled. The specific rule always wins.

**Bots, the owner and administrators are never judged**, and `security.lockdown`
holders are exempt too — punishing the moderator explaining a rule in `#general` is
the fastest way to get automod switched off. The verdict reports _why_ nothing was
judged rather than silently returning "clean".

**The trigger count comes from the case history**, not from a counter in memory, so it
survives a restart and can never disagree with what `/history` tells a moderator.

### Escalation is data

```jsonc
// automod.escalation — ordered rungs, highest match at or below the count wins
[
  { "triggers": 1, "action": "warn", "durationMs": 0 },
  { "triggers": 3, "action": "mute", "durationMs": 600000 },
  { "triggers": 5, "action": "timeout", "durationMs": 3600000 },
]
```

An empty ladder is valid and means **"record the trigger, punish nobody"** — which is
exactly what a server still calibrating its thresholds wants. `warnOnFirstTrigger`
records a `note` case so the trigger is visible in `/history` without a punishment.
`action: "none"` and an empty ladder both fall through to a `note`, never to silence.

---

## Anti-raid

A burst is **not** automatically a raid. `detectRaid()` requires a raid _signature_:

- a **new account** (younger than `minAccountAgeDays`), or
- a **suspicious username** (`free_nitro_claim`, `discord_gift_bot`, ...).

Two hundred established accounts joining a giveaway is a viral moment; locking the
server down for it is the single most damaging thing this module could do. An elevated
rate with no signature is therefore **reported as `security.raid-watch` and nothing
else**.

When a raid _is_ detected:

1. only the accounts carrying a signature are quarantined (an established account in
   the same burst is left alone);
2. quarantine runs through `ModerationService`, so it is a real case, undoable with
   `/unquarantine`;
3. the guild is locked down when `lockdownOnRaid` is on — **once per episode**, not
   once per join;
4. the episode is closed automatically when `raidModeSeconds` has passed.

`verifyNewMembers` is a _standing_ policy, not a reaction: a newcomer who is a new
account is contained even when the burst threshold was not crossed.

A join during a raid while moderation is **disabled** is reported as
`security.quarantine-skipped`. Silently containing the account would contradict the
switch, and silently not reporting it would hide the gap.

---

## Anti-nuke

Detection watches Discord's **audit log**, because that is the only source that
attributes a deletion to an account — `channelDelete` alone tells you a channel
vanished but not who removed it. Nine watched action kinds, each with a weight:

| Action              | Weight | Action           | Weight |
| ------------------- | ------ | ---------------- | ------ |
| `channel-delete`    | 2      | `member-ban`     | 3      |
| `channel-create`    | 1      | `member-kick`    | 2      |
| `role-delete`       | 2      | `webhook-create` | 2      |
| `role-create`       | 1      | `bot-add`        | 3      |
| `permission-update` | 1      |                  |        |

The threshold is compared against the **weight**, not the count, so a ban wave trips
it three times faster than a channel-creation wave.

**The response stops the nuke in flight.** Roles come off _before_ the log line is
written, in one `roles.remove` call: logging first would hand the account one more
destructive action for free, and a per-role loop would leave a window in which the
next permission is still held.

**The author is never banned automatically.** They are de-permissioned, given the
`Quarantined` role when the guild has one, and escalated to a human. An automated ban
of a possibly-compromised administrator account is irreversible in the wrong
direction, which is why the brief forbids it and the log line says so explicitly.

Whitelist: the guild owner, the bot itself, and `antiNuke.whitelistUserIds`.
**Administrators are deliberately _not_ whitelisted**: a compromised administrator
account is the most common nuke in practice, and it is exactly what this must stop.

---

## Security log

A **separate channel** (`#bot-security`) and a separate sink from the V4 moderation
log: a raid alert mixed into the moderation stream is a raid nobody reads.

Every line carries the six fields the brief asks for, in order, and renders an
explicit `—` rather than omitting an unknown field:

```
qui / quoi / quand / sur quel objet / avant → après / action prise
```

The channel is staff-only by default (setup denies `@everyone` `ViewChannel`), and
`securityChannelId` is stored in the guild's `logging` configuration.

---

## Backups

The module exists because of one sentence in the brief: **anti-nuke detects, it does
not repair.** A deleted channel is gone; stripping the culprit's roles does not bring
it back. A snapshot is what turns "we stopped it" into "we recovered".

| Property          | How it is guaranteed                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Read-only capture | `capture()` performs no Discord write, so a snapshot during a raid cannot make it worse             |
| Integrity         | SHA-256 over a canonical (key-sorted) JSON form, verified _before_ Discord is touched               |
| Guild isolation   | Storage queries always require `guildId`; `restore` re-checks the payload's embedded guild          |
| Additive restore  | Creates what is missing, repairs what drifted, **deletes nothing** the snapshot does not know about |
| Honest reporting  | The report names the channels it could _not_ restore instead of claiming success                    |

Order matters in a restore: **roles first, then channels**, because channel
overwrites reference role IDs. Roles are matched by ID, then by **name** — a role
that survived a nuke under a new ID is reused rather than duplicated, which is what
prevents `Admin` existing twice. Channels are created parents-first, so a restored
child is reparented in the same pass.

The restore also works on a **copy** of the payload: a storage layer that hands back a
live object (an in-memory repository, a cache) must not be able to have its stored
snapshot mutated by a restore. The checksum is what makes that difference observable;
the copy is what makes it impossible.

Retention is 20 snapshots per guild, pruned _after_ each write so a failed prune can
never lose the snapshot just taken.

---

## Database schema

Three new tables, all guild-scoped and cascade-deleted with the guild.

| Table                  | Holds                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `backup_snapshots`     | One snapshot: payload, checksum, role/channel counts          |
| `security_incidents`   | One raid/nuke episode: status, `expiresAt`, targeted accounts |
| `verification_pending` | The automatic-verification workflow state                     |

`ModerationCase` gained no table: automod and security containment both write
**ordinary cases** through the existing repository, which is the point.

Three moderation actions were added (`note`, `quarantine`, `unquarantine`) for the
same reason: the action table is the single source of truth for "what moderation can
record", so an automated trigger and a raid containment appear in `/history` next to
human actions rather than in a parallel log only its author understands.

---

## Configuration

`/settings view area:automod` and `area:security` are the operational view;
`/settings automod set` and `/settings security set` change values.

The `security` section gains two nested blocks:

- **`antiRaid`** — `enabled`, `burstThreshold`, `windowSeconds`, `minAccountAgeDays`,
  `verifyNewMembers`, `raidModeSeconds`, `lockdownOnRaid`,
  `suspiciousUsernameDetection`;
- **`antiNuke`** — `enabled`, `actionThreshold`, `windowSeconds`, `stripPermissions`,
  `whitelistUserIds`, `whitelistRoleIds`, `escalateToOwner`.

A new **`automod`** section holds `enabled`, `deleteTriggerMessages`,
`warnOnFirstTrigger`, `windowSeconds`, `rules.*` (nine booleans), `thresholds.*` and
`escalation[]`.

Discord caps a slash-command option at 25 choices. V5 has more settings than that, so
the setter is split **by area** (`/settings set` for the everyday areas, subcommand
groups for `automod` and `security`) rather than renamed into ambiguity.

---

## Required setup

Two things must be true before automod can work, and both are **checked by
diagnostics** rather than documented and forgotten:

1. the `messageContent` privileged intent must be enabled in the Discord developer
   portal (Bot → Privileged Gateway Intents). It is in `ENABLED_INTENT_FEATURES`, but
   Discord requires the portal toggle too;
2. `guildModeration` must be available for anti-nuke to read the audit log.

`automod.intent` fails loudly when automod is enabled without message access: a
silently inert automod — no error, no log, no rule ever firing — is indistinguishable
from "nobody is misbehaving", and is the worst possible failure mode.

`/setup run` creates `#bot-security` and the `Quarantined` role when security is
enabled; `security.resources` reports it when they are missing.

---

## Diagnostics

| Check                | Reports                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `automod.intent`     | Automod on but no `MessageContent` intent — a silently inert module        |
| `automod.rules`      | No rule enabled, empty ladder, first trigger neither recorded nor punished |
| `security.settings`  | Both detectors off, anti-nuke that only logs, account age ignored          |
| `security.resources` | Missing `#bot-security` or `Quarantined` role                              |

All read-only: none of them creates a role, a channel or a case.

---

## Testing

Three suites, 42 tests, asserting the _promises_ rather than the implementation:

- `tests/v5-automod.test.ts` — the evaluator is pure (a table of strings), a trigger
  produces one case + one audit event + one log line, escalation counts survive,
  exemptions hold, moderation-disabled is respected;
- `tests/v5-security.test.ts` — a veteran burst is watched and not contained, a new
  account burst is contained, a nuke's roles come off and **no ban is issued**, the
  lockdown lifts on expiry and on demand, guild isolation holds;
- `tests/v5-backup.test.ts` — capture is read-only, the guild is part of the address,
  a cross-guild or corrupt payload is refused _before_ any write, a restore recreates
  and repairs, and a partial restore is reported honestly.

Only Discord and PostgreSQL are faked: the evaluator, the windows, the ladders, the
detectors, the escalation and every moderation guard are the production ones.

---

## What this module does _not_ do

Tickets, AI moderation assistance, XP, economy and the dashboard are later phases.
Anti-nuke detects and _stops_; it does not repair — `/backup restore` does. A nuke
response is never a ban, by design. Verification restricts newcomers but does not yet
sweep accounts that never confirm, and the periodic backup worker's schedule is left
to a deployment decision rather than hardcoded here.
