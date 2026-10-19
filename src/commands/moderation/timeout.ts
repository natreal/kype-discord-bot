/**
 * `/timeout` — Discord's native timeout.
 *
 * Preferred over a mute role for temporary punishment: Discord itself enforces
 * it everywhere, including in channels the bot cannot see, and it expires without
 * the bot being online.
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
    name: "timeout",
    description: "Time a member out using Discord's own timeout.",
    category: "moderation",
    usage: "/timeout user:<member> duration:<duration> reason:<text>",
    examples: ["/timeout user:@Alex duration:10 minutes reason:Spamming"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.timeout"],
  },
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Time a member out using Discord's own timeout.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to time out.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("How long the timeout lasts.")
        .setRequired(true)
        .addChoices(...DURATION_CHOICES.map((choice) => ({ ...choice }))),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being timed out.")
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
        action: "timeout",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        durationMs: interaction.options.getInteger("duration", true),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
