/**
 * `/unban` — lift a ban by user ID.
 *
 * Works for a user who never joined and for one who left while banned, which is
 * why the target is resolved by user ID rather than through the member cache.
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
    name: "unban",
    description: "Lift a ban from a user.",
    category: "moderation",
    usage: "/unban user:<user> [reason]",
    examples: ["/unban user:@Alex reason:Appeal accepted"],
  },
  permissions: {
    discord: [PermissionFlagsBits.BanMembers],
    custom: ["moderation.unban"],
  },
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Lift a ban from a user.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The banned user to release.").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Why the ban is being lifted.").setMaxLength(500),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(GUILD_ONLY);
      return;
    }

    await guard(interaction, async () => {
      const target = await resolveMemberTarget(interaction, context, { allowBanFetch: true });
      const outcome = await context.moderation.service.execute(guildId, {
        action: "unban",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
