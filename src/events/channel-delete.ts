/**
 * `channelDelete` — the channel-change log event.
 *
 * Deletion is the destructive half of `channelChanges`, and the one a moderator
 * actually reviews. The channel object is already gone from the cache by the time
 * this fires, so everything logged comes from the payload Discord supplied — no
 * lookup, which is also why this handler cannot fail.
 *
 * Anti-nuke watches the same event through the audit log, but for a different
 * purpose: it counts destructive actions to stop a raid. This handler records *what*
 * was lost, which is what a human needs afterwards.
 */
import { AuditLogEvent } from "discord.js";

import { defineEvent } from "./event.types.js";
import { channelTypeName, compact, field } from "./guild-log.helpers.js";
import { findActor } from "./guild-member-update.js";

export default defineEvent({
  name: "channelDelete",
  execute: async (channel, { services }) => {
    if (!("guild" in channel) || !channel.guild) {
      return;
    }
    const guild = channel.guild;
    const actorId = await findActor(guild, AuditLogEvent.ChannelDelete, channel.id);

    services.guildLog.emit({
      guildId: guild.id,
      event: "channelChanges",
      title: "Channel deleted",
      lines: compact([
        field("Channel", `\`${channel.name}\``),
        field("Type", channelTypeName(channel)),
        field("Category", channel.parent ? channel.parent.name : null),
        field("By", actorId === null ? null : `<@${actorId}>`),
      ]),
      targetId: channel.id,
      actorId,
    });
  },
});
