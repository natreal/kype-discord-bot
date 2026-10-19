# Moderation module (V4)

Classic moderation: warnings, mutes, timeouts, kicks, bans. No automod, no
security, no tickets, no AI — those are later phases, and the module is built so
they can plug in without a rewrite.

---

## What ships

| Command      | Action                                                |
| ------------ | ----------------------------------------------------- |
| `/warn`      | Warn a member, recorded in their history              |
| `/warnings`  | A member's active warnings                            |
| `/unwarn`    | Remove the oldest active warning                      |
| `/mute`      | Apply the server's `Muted` role (optional duration)   |
| `/unmute`    | Remove the `Muted` role                               |
| `/timeout`   | Discord's native timeout                              |
| `/untimeout` | Clear a timeout                                       |
| `/kick`      | Kick a member                                         |
| `/ban`       | Ban a user (works on a user who is not in the server) |
| `/unban`     | Lift a ban                                            |
| `/softban`   | Ban then immediately unban, to clear recent messages  |
| `/purge`     | Delete recent messages, optionally from one author    |
| `/history`   | A member's full case history                          |

`/settings view area:moderation` and `/diagnostics category:moderation` report the
module's live state.

---

## One action, one pipeline

```
Command → ModerationRequest → ModerationService.execute(guildId, request)
                                → moderation enabled?  (settings, per guild)
                                → hierarchy and self-action guards
                                → Discord call (GuildMemberActions port)
                                → case + audit_event + Discord log
```

Three consequences that matter:

1. **Nothing is recorded unless it happened.** Every guard runs _before_ the
   Discord call, and a refused or failed call writes no case, no audit event and
   no log line. The history is evidence, not an attempt log.
2. **Commands hold no logic.** They resolve options, build a `ModerationRequest`
   and render the outcome. Permissions live in the command declaration, rules in
   the service, Discord calls in one adapter.
3. **Automation uses the same path.** The service takes a plain request and a
   `ModerationActor` (`user` / `system` / `god`), never an interaction, so a future
   automod or AI caller gets the same permissions, audit trail and log line — and
   is recorded as `system`, never as a human.

---

## Database schema

Two tables, both guild-scoped and cascade-deleted with the guild.

`moderation_cases` — one row per action:

| Column                              | Why                                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| `caseNumber`                        | Per-guild, stable, human-facing (`case #12`)                    |
| `action`, `targetType`, `targetId`  | What happened, to whom (or to which channel, for a purge)       |
| `moderatorId`, `moderatorKind`      | Who, and whether it was a user, automation or the owner         |
| `reason`, `durationMs`, `expiresAt` | Why, how long, and until when                                   |
| `before`, `after`                   | Member state around the action, which makes it reviewable       |
| `details`                           | Action extras (channel name, message counts, mute role, ...)    |
| `relatedCaseNumber`                 | The case this one reverses (`unban` → `ban`, `unwarn` → `warn`) |
| `(guildId, caseNumber)` unique      | A case number can never be handed out twice                     |

`guild_moderation_counters` — one row per guild, backing the case sequence:

```sql
BEGIN
  INSERT INTO guild_moderation_counters ("guildId", "value") VALUES ($1, 0)
    ON CONFLICT ("guildId") DO NOTHING;
  UPDATE guild_moderation_counters SET "value" = "value" + 1 WHERE "guildId" = $1
    RETURNING "value";
  INSERT INTO moderation_cases (...);
COMMIT
```

`MAX(caseNumber) + 1` was rejected on purpose: two moderators acting at the same
moment would both read the same maximum, and the unique constraint would turn the
second action into a failed ban. The counter increments atomically inside the same
transaction as the insert, and the row lock is scoped to one guild, so an action in
server A never waits on server B.

### Why cases are not `audit_events`

The audit trail answers _"who changed the bot's state"_, and is written from the
same code path: every action also produces an `audit_events` row carrying the case
number. A case answers _"what happened to this member"_, and needs a stable number,
an expiry a future sweeper can query, and the member state around the action.
Keeping them separate means neither has to be denormalized to satisfy the other.

`expiresAt` is written today although nothing sweeps it yet: temporary punishments
are recorded in a form a later background job can act on with no migration and no
backfill.

---

## Configuration: `/settings moderation` is the source of truth

The `moderation` section was already authoritative and stays that way:

| Setting          | Effect on the module                                     |
| ---------------- | -------------------------------------------------------- |
| `enabled`        | Refuses every punishment when false (pardons still work) |
| `warnThreshold`  | The count that flags `thresholdReached` on a warning     |
| `dmOnPunishment` | Whether the punished member is notified by DM            |

Writes go through `ConfigService`, so validation, provenance and auditing are the
same as everywhere else. A threshold of `0` means "no automatic threshold", never
"everyone is already over it".

**The threshold is reported, not enforced.** Crossing it adds a note to the
moderator's confirmation; it does not silently auto-timeout anybody. Automatic
punishment is a policy decision that belongs to automod, and inventing it here
would contradict the module's scope.

---

## The Muted role

`/mute` adopts a role named `Muted` and never creates it: provisioning a
permission role in a server the bot does not own is a decision for that server's
administrators, and a wrongly configured role is worse than an absent one. When the
role is missing, `/mute` explains exactly what to create, and
`/diagnostics category:moderation` reports the same condition before a moderator
needs it.

`/mute` also refuses when the role sits at or above the bot's highest role, since
Discord would reject the assignment.

---

## Discord log delivery

`/settings logging` configured a log channel that nothing ever wrote to. V4 closes
that gap for the moderation category:

- `ModerationService` emits through a `ModerationLogPort`;
- `LoggerModerationLogPort` turns that into a structured logger record carrying the
  category `moderation`;
- `ModerationLogSink` picks those records up and posts an embed to the guild's
  `#server-logs`, resolved by recorded ID first and by name as a fallback.

The sink never throws and never blocks an action, and it resolves the channel per
record, so a rename or a repair takes effect immediately. `logs.server-logs` is now
provisionable: a guild that enables logging and runs `/setup run` gets the channel,
and a guild that leaves logging off never gets an unused one.

Only the **moderation** category is delivered today. Member, message and security
events will bring their own formatters; the sink ignores anything it does not
recognise rather than posting a half-understood line.

---

## Diagnostics

Four checks under the `moderation` category, all read-only — none of them creates a
role, a channel or a case:

| Check                  | Reports                                                 |
| ---------------------- | ------------------------------------------------------- |
| `moderation.settings`  | Module disabled, threshold at `0`, DM notifications off |
| `moderation.delivery`  | Logging off, no channel, channel missing, cannot post   |
| `moderation.mute-role` | No `Muted` role, or a role the bot cannot assign        |
| `moderation.history`   | Recent case count and the latest case number            |

---

## What this module does _not_ do

Automod, anti-raid/anti-nuke, tickets, AI moderation assistance and a punishment
sweeper are out of scope. The pieces that make them cheap to add are already in
place: `autoModAllowed` on every action declaration (nothing reads it yet, and it
exists so that automation cannot silently widen what a non-human actor may do),
`expiresAt` on every temporary punishment, and a service callable without an
interaction.

Also out of scope, and deliberately: removing a member's roles while they are timed
out, and restoring roles after a mute. A mute case stores the member's roles in
`before`/`after`, so a restore can be built on top without a migration.
