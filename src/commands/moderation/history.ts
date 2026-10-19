/**
 * `/history` — the full case history of a member.
 *
 * Reads the `moderation_cases` table, not the audit trail: a case is what
 * moderation did to a member, and it carries the case number every log line and
 * every confirmation refers to.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed } from "../../utils/presenters.js";
import { GUILD_ONLY } from "./moderation.helpers.js";
import {
  MODERATION_ACTIONS,
  MODERATION_LIMITS,
  moderationActionDefinition,
  type ModerationAction,
} from "../../modules/moderation/moderation-actions.js";

export default defineSlashCommand({
  meta: {
    name: "history",
    description: "Show the moderation history of a member.",
    category: "moderation",
    usage: "/history user:<member> [action] [limit]",
    examples: ["/history user:@Alex", "/history user:@Alex action:ban"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.view"],
  },
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show the moderation history of a member.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to inspect.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Only show one kind of action.")
        .addChoices(...MODERATION_ACTIONS.map((action) => ({ name: action, value: action }))),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("How many entries to show (default 25, maximum 100).")
        .setMinValue(1)
        .setMaxValue(MODERATION_LIMITS.maxHistoryEntries),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(GUILD_ONLY);
      return;
    }

    const user = interaction.options.getUser("user", true);
    const action = interaction.options.getString("action") as ModerationAction | null;
    const limit = interaction.options.getInteger("limit") ?? MODERATION_LIMITS.defaultHistoryLimit;

    const cases = await context.moderation.service.history(guildId, {
      targetId: user.id,
      action,
      limit,
    });
    const warnCount = cases.filter((record) => record.action === "warn").length;

    if (cases.length === 0) {
      const empty = brandedEmbed(`History — ${user.tag}`).setDescription(
        "Nothing recorded for this member.",
      );
      await interaction.editReply({ embeds: [empty] });
      return;
    }

    const lines = cases.map((record) => {
      const label = moderationActionDefinition(record.action)?.label ?? record.action;
      const reason = record.reason ? ` — ${record.reason}` : "";
      const moderator =
        record.moderatorKind === "system" ? "automation" : `<@${record.moderatorId}>`;
      return `**#${record.caseNumber}** ${label} · ${moderator} · <t:${Math.floor(
        record.createdAt.getTime() / 1_000,
      )}:R>${reason}`;
    });

    const embed = brandedEmbed(`History — ${user.tag}`).setDescription(
      [
        `Cases shown: **${cases.length}**${action ? ` (filtered to \`${action}\`)` : ""}`,
        `Warnings recorded historically: **${warnCount}**`,
        `User ID: \`${user.id}\``,
      ].join("\n"),
    );

    // Fields are capped at 1024 characters, so the list is chunked rather than
    // truncated: an operator must see every case the service returned.
    const chunks = chunkLines(lines, 1_000);
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? "Cases" : `Cases (${index + 1})`,
        value: chunk,
      });
    });

    await interaction.editReply({ embeds: [embed] });
  },
});

/** @returns lines grouped into chunks no longer than `maxLength`. */
function chunkLines(lines: readonly string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length > 0 && current.length + line.length + 1 > maxLength) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
