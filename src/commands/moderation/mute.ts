/**
 * `/mute` — apply the server's `Muted` role.
 *
 * The bot deliberately does not create that role: provisioning a permission
 * role in a server the bot does not own is a decision for its administrators,
 * and a wrongly configured role is worse than an absent one. When the role is
 * missing, the command says exactly what to create — and `/diagnostics` reports
 * the same condition, so an operator learns about it before a moderator needs it.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import {
  DURATION_CHOICES,
  GUILD_ONLY,
  actorFrom,
  guard,
  outcomeEmbed,
  reasonFrom,
  resolveMemberTarget,
} from "./moderation.helpers.js";

export default defineSlashCommand({
  meta: {
    name: "mute",
    description: "Mute a member by giving them the Muted role.",
    category: "moderation",
    usage: "/mute user:<member> reason:<text> [duration]",
    examples: ["/mute user:@Alex reason:Caps spam duration:1 hour"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.mute"],
  },
  data: new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a member by giving them the Muted role.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to mute.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being muted.")
        .setMaxLength(500)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("How long the mute lasts (default: until unmuted).")
        .addChoices(...DURATION_CHOICES.map((choice) => ({ ...choice }))),
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
        action: "mute",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        durationMs: interaction.options.getInteger("duration"),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
