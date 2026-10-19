/**
 * `messageReactionAdd` — the automod reaction path.
 *
 * `anti-mass-reactions` exists because reaction spam is the cheapest way to annoy a
 * server and the least visible: nothing appears in the channel, so no moderator
 * will notice it. The handler reports one *addition* and lets the sliding window
 * count them, exactly like messages.
 *
 * A partial reaction (uncached user or message) is ignored rather than fetched: a
 * fetch per reaction would turn a reaction raid into an API storm, which is a
 * denial of service the module would be causing itself.
 */
import { PermissionFlagsBits } from "discord.js";

import { defineEvent } from "./event.types.js";
import type { AutomodReactionObservation } from "../modules/automod/index.js";

export default defineEvent({
  name: "messageReactionAdd",
  execute: async (reaction, user, _details, { services }) => {
    if (user.bot) {
      return;
    }
    // A partial reaction has no guild or channel cached, and fetching it is the
    // storm described above.
    if (!reaction.message.inGuild()) {
      return;
    }

    const guild = reaction.message.guild;
    if (!guild) {
      return;
    }

    const automod = services.automodForGuild(guild.id);
    if (!automod) {
      return;
    }

    const observation: AutomodReactionObservation = {
      kind: "reaction",
      guildId: guild.id,
      channelId: reaction.message.channelId,
      channelName: channelNameOf(reaction.message.channel),
      messageId: reaction.message.id,
      authorId: user.id,
      authorTag: user.tag,
      authorIsOwner: guild.ownerId === user.id,
      authorIsAdministrator:
        guild.members.cache.get(user.id)?.permissions.has(PermissionFlagsBits.Administrator) ??
        false,
      botAuthor: user.bot,
      // A custom emoji has an ID and no name Discord will render back; a unicode
      // emoji has a name and no ID. Either way the string is stable for the window.
      emoji: reaction.emoji.id ?? reaction.emoji.name ?? "unknown-emoji",
      timestampMs: Date.now(),
    };

    await automod.observe(observation);
  },
});

/** @returns a readable channel name, falling back to the channel ID. */
function channelNameOf(channel: { id: string; name?: string | null }): string {
  return typeof channel.name === "string" && channel.name.length > 0 ? channel.name : channel.id;
}
