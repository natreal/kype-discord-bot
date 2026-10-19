/**
 * `guildMemberUpdate` — the role-change log event.
 *
 * `roleChanges` is one toggle covering several distinct events: a role added, a role
 * removed, a nickname change, a timeout starting or ending. All of them are member
 * updates, and a moderator reading the log wants them in one place, so they share
 * this handler.
 *
 * The *actor* is not on the payload. Recovering it means reading the audit log, which
 * costs an API call per update — so the actor is fetched only when the guild actually
 * wants the line. A guild with `roleChanges` off pays nothing for a busy server.
 */
import { AuditLogEvent, type Guild } from "discord.js";

import { defineEvent } from "./event.types.js";
import { compact, describeRoles, field } from "./guild-log.helpers.js";

export default defineEvent({
  name: "guildMemberUpdate",
  execute: async (before, after, { services }) => {
    const guild = after.guild;

    const added = after.roles.cache.filter((role) => !before.roles.cache.has(role.id));
    const removed = before.roles.cache.filter((role) => !after.roles.cache.has(role.id));
    const nicknameChanged = before.nickname !== after.nickname;
    const timeoutChanged =
      (before.communicationDisabledUntil?.getTime() ?? null) !==
      (after.communicationDisabledUntil?.getTime() ?? null);

    if (added.size === 0 && removed.size === 0 && !nicknameChanged && !timeoutChanged) {
      return;
    }

    const actorId = await findActor(guild, AuditLogEvent.MemberRoleUpdate, after.id);

    const lines = compact([
      field("Member", `${after.user.tag} (<@${after.id}>)`),
      field("Roles added", added.size === 0 ? null : added.map((role) => `<@&${role.id}>`).join(", ")),
      field("Roles removed", removed.size === 0 ? null : removed.map((role) => `<@&${role.id}>`).join(", ")),
      field("Nickname", nicknameChanged ? `${before.nickname ?? "*none*"} → ${after.nickname ?? "*none*"}` : null),
      field(
        "Timeout",
        timeoutChanged
          ? after.communicationDisabledUntil === null
            ? "lifted"
            : `until <t:${Math.floor(after.communicationDisabledUntil.getTime() / 1_000)}:f>`
          : null,
      ),
      field("Roles now", describeRoles(guild, after)),
      field("By", actorId === null ? null : `<@${actorId}>`),
    ]);

    services.guildLog.emit({
      guildId: guild.id,
      event: "roleChanges",
      title: describeTitle({ added: added.size, removed: removed.size, nicknameChanged, timeoutChanged }),
      lines,
      targetId: after.id,
      actorId,
    });
  },
});

/** @returns a title naming the change, so the embed says what happened at a glance. */
function describeTitle(changes: {
  readonly added: number;
  readonly removed: number;
  readonly nicknameChanged: boolean;
  readonly timeoutChanged: boolean;
}): string {
  if (changes.added > 0 && changes.removed === 0) {
    return "Roles added";
  }
  if (changes.removed > 0 && changes.added === 0) {
    return "Roles removed";
  }
  if (changes.added > 0 || changes.removed > 0) {
    return "Roles changed";
  }
  return changes.timeoutChanged ? "Member timeout changed" : "Nickname changed";
}

/**
 * @returns the ID of whoever performed a change, or `null` when unattributable.
 *
 * Best-effort by design: a missing `View Audit Log` permission or a stale entry
 * returns `null` and the line is still logged. Attribution is a bonus, never a
 * precondition for the log.
 */
export async function findActor(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string,
): Promise<string | null> {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((candidate) => {
      const target = candidate.target as { id?: unknown } | null;
      return target?.id === targetId;
    });
    return entry?.executorId ?? null;
  } catch {
    // No permission, or the entry has aged out: log without attribution.
    return null;
  }
}
