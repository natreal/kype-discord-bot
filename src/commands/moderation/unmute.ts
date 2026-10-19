/**
 * `/unmute` — remove the server's `Muted` role.
 *
 * A pardon, so it stays available even with `moderation.enabled` off: a server
 * that disables the module must still be able to unblock somebody.
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
    name: "unmute",
    description: "Remove the Muted role from a member.",
    category: "moderation",
    usage: "/unmute user:<member> [reason]",
    examples: ["/unmute user:@Alex reason:Mute served"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.mute"],
  },
  data: new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove the Muted role from a member.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to unmute.").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Why they are being unmuted.").setMaxLength(500),
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
        action: "unmute",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
