/**
 * `/warn` — warn a member.
 *
 * The thin-command rule holds here: resolve the target, delegate, render. The
 * warning threshold is *reported* (as a note) rather than enforced, because an
 * automatic punishment belongs to the moderation policy, not to the act of
 * warning someone — and `moderation.enabled`, the threshold and the DM switch
 * all remain owned by `/settings moderation`.
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
    name: "warn",
    description: "Warn a member, and record it in their history.",
    category: "moderation",
    usage: "/warn user:<member> reason:<text>",
    examples: ["/warn user:@Alex reason:Spamming in #general"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.warn"],
  },
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member, and record it in their history.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to warn.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being warned.")
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
        action: "warn",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
