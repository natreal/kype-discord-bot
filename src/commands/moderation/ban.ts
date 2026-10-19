/**
 * `/ban` — ban a user, optionally purging their recent messages.
 *
 * A user who is not in the guild can still be banned (by ID), which is the only
 * way to act on somebody who left before the punishment was decided.
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

/** Message-deletion windows offered on `/ban`, in seconds. */
const DELETE_CHOICES = [
  { name: "Do not delete anything", value: 0 },
  { name: "Last hour", value: 3_600 },
  { name: "Last 6 hours", value: 21_600 },
  { name: "Last 24 hours", value: 86_400 },
  { name: "Last 3 days", value: 259_200 },
  { name: "Last 7 days", value: 604_800 },
] as const;

export default defineSlashCommand({
  meta: {
    name: "ban",
    description: "Ban a user from this server.",
    category: "moderation",
    usage: "/ban user:<user> reason:<text> [delete-messages]",
    examples: ["/ban user:@Alex reason:Raiding delete-messages:Last 24 hours"],
  },
  permissions: {
    discord: [PermissionFlagsBits.BanMembers],
    custom: ["moderation.ban"],
  },
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user from this server.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user to ban.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why they are being banned.")
        .setMaxLength(500)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("delete-messages")
        .setDescription("Also delete their recent messages.")
        .addChoices(...DELETE_CHOICES.map((choice) => ({ ...choice }))),
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
        action: "ban",
        actor: actorFrom(interaction, context),
        target,
        reason: reasonFrom(interaction),
        source: "command",
      });
      await interaction.editReply({ embeds: [outcomeEmbed(outcome)] });
    });
  },
});
