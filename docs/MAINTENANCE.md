# Maintenance mode

`/maintenance` pauses the bot for **one server** while it is being worked on. It is a
guild-scoped configuration switch, not a process kill: the bot stays online, keeps its
gateway connection, and keeps protecting the server.

```
/maintenance <on|off|status> [reason] [minutes]

  on      pause; omit minutes for "until turned off"
  off     resume now
  status  what is on, since when, until when
```

`action` is a required choice on the one `/maintenance` command — not three separate
commands. `reason` is shown to members who try to use the bot, and `minutes` (1–10 080,
i.e. up to seven days) schedules an automatic resume; both are used by `on` and ignored
by `off` and `status`.

## What is paused

- every slash command from a non-exempt member;
- autocomplete suggestions (answered with an empty list);
- ticket panel buttons: open, claim, close, transcript, delete;
- the AI keyword reply (the assistant stays silent rather than answering and costing
  provider tokens).

## What keeps running

Maintenance silences **conversation**, not **protection**:

- automod rules and their sanctions;
- anti-raid and anti-nuke detection;
- logging (member, message, role and channel events);
- the expired-punishment sweeper;
- scheduled work in general.

A server that is being upgraded is still a server that can be raided.

## Who bypasses a pause

Only the people who can turn it back off:

| Member                           | Bypasses |
| -------------------------------- | -------- |
| God Access                       | yes      |
| Guild owner                      | yes      |
| Discord `Administrator`          | yes      |
| Holds granular `server.settings` | yes      |
| Everyone else (staff included)   | no       |

`/maintenance` itself declares `server.settings`, so the bypass set and the management
set are the same set by construction. In practice `bot-manager` and anything above it can
operate during a pause; `helper`, `support`, `moderator` and `senior-moderator` cannot.
That is intentional: maintenance is about availability, not rank.

## Storage, audit and restarts

The state lives in the guild configuration, in the `maintenance` section
(`enabled`, `reason`, `since`, `until`, `by`):

- it survives a restart, and a restarted bot reads the remaining window instead of
  losing it;
- each change is a configuration write, so it is revisioned and recorded in the audit
  trail (`config.update`, category `config`) with the actor and the changed fields;
- an automatic window is evaluated **on read**. When `until` has passed the bot simply
  serves normally again; the stored flags are left alone as history. `/maintenance
status` reports the window as ended.

Nothing is shared between guilds: enabling maintenance in one server has no effect on
another.

## Recovering from a forgotten pause

1. `/maintenance off` — anyone in the bypass set can run it, even while paused.
2. `/settings reset` (guild owner or God Access) — resets every configuration section,
   including maintenance.
3. Directly, as a last resort:

   ```sql
   DELETE FROM guild_config_sections
   WHERE guild_id = '<guild-id>' AND section = 'maintenance';
   ```

   The next read falls back to the defaults (`enabled: false`).

## Maintenance is not "stop the bot"

`npm run bot:stop` (or the Windows service/supervisor) stops the **process**: every
server loses the bot. `/maintenance` affects **one guild**, keeps the process alive, and
is reversible from inside Discord. Use it for upgrades, migrations and debugging — use the
process controls only when the bot itself must go down.
