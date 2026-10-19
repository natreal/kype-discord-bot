/**
 * `/kick` — remove a member from the server.
 *
 * A reason is mandatory: a kick is irreversible, and "why" is the first thing
 * anyone reviewing the action asks.
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
    name: "kick",
    description: "Kick a member from this server.",
    category: "moderation",
    usage: "/kick user:<member> reason:<text>",
    examples: ["/kick user:@Alex reason:Ignoring staff instructions"],
  },
  permissions: {
    discord: [PermissionFlagsBits.KickMembers],
    custom: ["moderation.kick"],
  },
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from this server.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to kick.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being kicked.")
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
        action: "kick",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
