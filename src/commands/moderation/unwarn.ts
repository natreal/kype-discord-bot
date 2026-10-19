/**
 * `/unwarn` — remove a member's oldest active warning.
 *
 * Removing a warning is recorded as its own case, linked back to the warning it
 * cancels. The history therefore reads as a narrative ("warned, then cleared"),
 * which is what a moderator stepping into a case needs to see.
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
    name: "unwarn",
    description: "Remove a member's oldest active warning.",
    category: "moderation",
    usage: "/unwarn user:<member> [reason]",
    examples: ["/unwarn user:@Alex reason:Appeal accepted"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.warn"],
  },
  data: new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Remove a member's warning, by case number or oldest first.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to clear a warning for.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("case")
        .setDescription("The warning case number to remove. Omit to remove the oldest.")
        .setMinValue(1),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the warning is being removed.")
        .setMaxLength(500),
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
        action: "unwarn",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
        caseNumber: interaction.options.getInteger("case") ?? null,
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
