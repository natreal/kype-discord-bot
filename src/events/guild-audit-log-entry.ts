/**
 * `guildAuditLogEntryCreate` — the anti-nuke trigger.
 *
 * Anti-nuke cannot be built on the gateway events alone: `channelDelete` tells you a
 * channel vanished but not *who* removed it. The audit log is the only source that
 * attributes an action to an account, so this event is where anti-nuke lives.
 *
 * Two properties matter:
 *
 * - **the actor is read, never guessed.** An entry whose `executorId` is missing is
 *   ignored rather than attributed to the bot: a nuke response aimed at the wrong
 *   account is worse than no response.
 * - **the mapping table is explicit.** Discord has dozens of audit action types;
 *   only the destructive ones are watched, and an unmapped type produces `null`
 *   rather than a generic "something happened" that would count toward the
 *   threshold.
 */
import { AuditLogEvent, type GuildAuditLogsEntry } from "discord.js";

import { defineEvent } from "./event.types.js";
import type { NukeActionKind, NukeActionObservation } from "../modules/security/index.js";

/** Audit action types anti-nuke watches, and what each one means to it. */
const WATCHED_ACTIONS: Readonly<Partial<Record<AuditLogEvent, NukeActionKind>>> = {
  [AuditLogEvent.ChannelDelete]: "channel-delete",
  [AuditLogEvent.ChannelCreate]: "channel-create",
  [AuditLogEvent.RoleDelete]: "role-delete",
  [AuditLogEvent.RoleCreate]: "role-create",
  [AuditLogEvent.ChannelOverwriteUpdate]: "permission-update",
  [AuditLogEvent.ChannelOverwriteCreate]: "permission-update",
  [AuditLogEvent.MemberBanAdd]: "member-ban",
  [AuditLogEvent.MemberKick]: "member-kick",
  [AuditLogEvent.WebhookCreate]: "webhook-create",
  [AuditLogEvent.BotAdd]: "bot-add",
};

export default defineEvent({
  name: "guildAuditLogEntryCreate",
  execute: async (entry, guild, { services }) => {
    const security = services.securityForGuild(guild.id);
    if (!security) {
      return;
    }

    const kind = WATCHED_ACTIONS[entry.action];
    if (!kind) {
      return;
    }

    // An unattributed entry cannot be acted on: `executorId` is absent for actions
    // Discord performs itself, and blaming the bot for them would be a false
    // positive that disables the module.
    const actorId = entry.executorId;
    if (!actorId) {
      return;
    }

    const observation: NukeActionObservation = {
      guildId: guild.id,
      kind,
      actorId,
      actorTag: entry.executor?.tag ?? null,
      targetId: describeTargetId(entry),
      targetName: describeTargetName(entry),
      atMs: entry.createdTimestamp,
    };

    await security.observeNukeAction(observation);
  },
});

/** @returns the ID of the object acted upon, when the entry carries one. */
function describeTargetId(entry: GuildAuditLogsEntry): string | null {
  const target = entry.target as { id?: unknown } | null;
  return typeof target?.id === "string" ? target.id : null;
}

/** @returns a readable name for the object acted upon. */
function describeTargetName(entry: GuildAuditLogsEntry): string | null {
  const target = entry.target as { name?: unknown } | null;
  return typeof target?.name === "string" ? target.name : null;
}

/** Re-exported so the mapping table can be asserted by tests without Discord. */
export { WATCHED_ACTIONS };
