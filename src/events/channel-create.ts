/**
 * Channel create / update / delete — the channel-change log event.
 *
 * Three gateway events, one toggle and one formatter, because they answer one
 * question: "what happened to this channel?". Splitting them would give an
 * administrator three differently-shaped embeds for the same investigation.
 *
 * `channelUpdate` is the noisy one: Discord fires it on any change including
 * position and permission overwrites, so the handler describes only the fields a
 * moderator can act on and drops an update where none of them moved.
 */
import { AuditLogEvent, type DMChannel, type GuildBasedChannel, type NonThreadGuildBasedChannel } from "discord.js";

import { defineEvent } from "./event.types.js";
import { channelTypeName, compact, field } from "./guild-log.helpers.js";
import { findActor } from "./guild-member-update.js";

export default defineEvent({
  name: "channelCreate",
  execute: async (channel, { services }) => {
    const guild = asGuildChannel(channel);
    if (!guild) {
      return;
    }
    const actorId = await findActor(guild.guild, AuditLogEvent.ChannelCreate, guild.id);
    services.guildLog.emit({
      guildId: guild.guild.id,
      event: "channelChanges",
      title: "Channel created",
      lines: compact([
        field("Channel", `${guild.toString()} (\`${guild.name}\`, ${channelTypeName(guild)})`),
        field("Category", guild.parent ? `${guild.parent.toString()}` : null),
        field("By", actorId === null ? null : `<@${actorId}>`),
      ]),
      targetId: guild.id,
      actorId,
    });
  },
});

/** @returns the channel when it belongs to a guild, otherwise `null`. */
function asGuildChannel(
  channel: GuildBasedChannel | DMChannel,
): NonThreadGuildBasedChannel | null {
  return "guild" in channel && channel.guild ? (channel as NonThreadGuildBasedChannel) : null;
}
