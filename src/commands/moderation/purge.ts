/**
 * `/purge` — remove recent messages from the current channel.
 *
 * One command, not three: the optional author filter covers the
 * "delete everything Alex said here" case without a second command to keep in
 * sync. Pinned messages and anything older than Discord's two-week bulk-delete
 * limit are always kept, and the reply says how many were actually removed.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { GUILD_ONLY, actorFrom, guard, outcomeEmbed, reasonFrom } from "./moderation.helpers.js";
import { MODERATION_LIMITS } from "../../modules/moderation/moderation-actions.js";

export default defineSlashCommand({
  meta: {
    name: "purge",
    description: "Delete recent messages in this channel.",
    category: "moderation",
    usage: "/purge count:<n> [user] [reason]",
    examples: ["/purge count:50", "/purge count:25 user:@Alex reason:Spam cleanup"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ManageMessages],
    custom: ["moderation.purge"],
  },
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages in this channel.")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("How many messages to delete (1-100).")
        .setRequired(true)
        .setMinValue(MODERATION_LIMITS.minPurgeCount)
        .setMaxValue(MODERATION_LIMITS.maxPurgeCount),
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("Only delete messages from this user."),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Why the messages are removed.").setMaxLength(500),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const channel = interaction.channel;
    if (!guildId || !channel || !channel.isTextBased()) {
      await interaction.editReply(GUILD_ONLY);
      return;
    }
    const channelName =
      "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;

    await guard(interaction, async () => {
      const author = interaction.options.getUser("user");
      const outcome = await context.moderation.service.execute(guildId, {
        action: "purge",
        actor: actorFrom(interaction, context),
        target: { type: "channel", id: channel.id, name: channelName },
        reason: reasonFrom(interaction),
        count: interaction.options.getInteger("count", true),
        authorId: author?.id ?? null,
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
