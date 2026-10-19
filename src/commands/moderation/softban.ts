/**
 * `/softban` — ban then immediately unban, to remove a user's recent messages.
 *
 * Recorded as one case with the deletion window it used, because the two Discord
 * calls are one decision, and a history that showed them as two actions would be
 * misleading. The target is always a guild member here: the point is to clear the
 * messages of somebody who is currently in the server.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import {
  GUILD_ONLY,
  actorFrom,
  guard,
  outcomeEmbed,
  reasonFrom,
  resolveMemberTarget,
} from "./moderation.helpers.js";

export default defineSlashCommand({
  meta: {
    name: "softban",
    description: "Remove a member and their recent messages, without a lasting ban.",
    category: "moderation",
    usage: "/softban user:<member> reason:<text>",
    examples: ["/softban user:@Alex reason:Posting invite links"],
  },
  permissions: {
    discord: [PermissionFlagsBits.BanMembers],
    custom: ["moderation.ban"],
  },
  data: new SlashCommandBuilder()
    .setName("softban")
    .setDescription("Remove a member and their recent messages, without a lasting ban.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to softban.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being softbanned.")
        .setMaxLength(500)
        .setRequired(true),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(GUILD_ONLY);
      return;
    }

    await guard(interaction, async () => {
      const target = await resolveMemberTarget(interaction, context);
      const outcome = await context.moderation.service.execute(guildId, {
        action: "softban",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
