/**
 * `channelUpdate` — the channel-change log event.
 *
 * The noisiest event in the set: Discord fires it for a position change, a topic
 * edit, a rename and every permission-overwrite write. Only the fields a moderator
 * can act on are reported, and an update where none of them moved is dropped
 * entirely — otherwise reordering a category would empty the log channel of anything
 * worth reading.
 */
import { AuditLogEvent, type DMChannel, type GuildBasedChannel } from "discord.js";

import { defineEvent } from "./event.types.js";
import { channelTypeName, compact, field } from "./guild-log.helpers.js";
import { findActor } from "./guild-member-update.js";

export default defineEvent({
  name: "channelUpdate",
  execute: async (before, after, { services }) => {
    const guild = "guild" in after && after.guild ? after : null;
    if (!guild) {
      return;
    }
    const previous = before as GuildBasedChannel | DMChannel;
    const beforeName = "name" in previous ? previous.name : null;
    const beforeTopic = "topic" in previous ? previous.topic : null;
    const afterTopic = "topic" in guild ? guild.topic : null;
    const renamed = beforeName !== null && beforeName !== guild.name;
    const topicChanged = beforeTopic !== afterTopic;

    if (!renamed && !topicChanged) {
      return;
    }

    const actorId = await findActor(guild.guild, AuditLogEvent.ChannelUpdate, guild.id);
    services.guildLog.emit({
      guildId: guild.guild.id,
      event: "channelChanges",
      title: renamed ? "Channel renamed" : "Channel topic changed",
      lines: compact([
        field("Channel", `${guild.toString()} (\`${guild.name}\`, ${channelTypeName(guild)})`),
        field("Before", renamed ? `\`${beforeName}\`` : null),
        field("After", renamed ? `\`${guild.name}\`` : null),
        field("Topic", renamed ? null : `\`${afterTopic ?? "*none*"}\``),
        field("By", actorId === null ? null : `<@${actorId}>`),
      ]),
      targetId: guild.id,
      actorId,
    });
  },
});
