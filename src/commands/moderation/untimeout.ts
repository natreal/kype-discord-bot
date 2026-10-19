/**
 * `/untimeout` — clear a member's Discord timeout.
 *
 * A pardon: available even with moderation disabled, so a server can always
 * release somebody it timed out by mistake.
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
    name: "untimeout",
    description: "Remove a member's timeout.",
    category: "moderation",
    usage: "/untimeout user:<member> [reason]",
    examples: ["/untimeout user:@Alex reason:Appeal accepted"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.timeout"],
  },
  data: new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a member's timeout.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to release.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the timeout is being removed.")
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
        action: "untimeout",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
