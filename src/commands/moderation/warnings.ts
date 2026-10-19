/**
 * `/warnings` — a member's active warnings.
 *
 * Reads through the moderation service, so what the command shows and what the
 * threshold counts are the same computation, never two.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed } from "../../utils/presenters.js";
import { GUILD_ONLY, resolveMemberTarget } from "./moderation.helpers.js";
import { moderationActionDefinition } from "../../modules/moderation/moderation-actions.js";

export default defineSlashCommand({
  meta: {
    name: "warnings",
    description: "Show a member's active warnings.",
    category: "moderation",
    usage: "/warnings user:<member> [page]",
    examples: ["/warnings user:@Alex"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.view"],
  },
  data: new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show a member's active warnings.")
    .addUserOption((option) =>
      option.setName("user").setDescription("The member to inspect.").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("How many entries to show (default 10, maximum 50).")
        .setMinValue(1)
        .setMaxValue(50),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply(GUILD_ONLY);
      return;
    }

    const limit = interaction.options.getInteger("limit") ?? 10;
    const target = await resolveMemberTarget(interaction, context);
    const cases = (
      await context.moderation.service.history(guildId, { targetId: target.id, limit: 100 })
    ).filter((record) => record.action === "warn" || record.action === "unwarn");

    const active = await context.moderation.service.warningCount(guildId, target.id);
    const cancelled = new Set(
      cases
        .filter((record) => record.action === "unwarn" && record.relatedCaseNumber !== null)
        .map((record) => record.relatedCaseNumber as number),
    );

    const embed = brandedEmbed(`Warnings — ${target.tag}`).setDescription(
      [`Active warnings: **${active}**`, `Threshold: see \`/settings view area:moderation\`.`].join(
        "\n",
      ),
    );

    if (cases.length === 0) {
      embed.addFields({ name: "History", value: "No warnings recorded." });
    } else {
      embed.addFields({
        name: "History",
        value: renderWarnings(cases.slice(0, limit), cancelled),
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
});

/** @returns one line per warning, marking those cancelled by an `unwarn`. */
function renderWarnings(
  cases: readonly {
    caseNumber: number;
    action: string;
    moderatorId: string;
    reason: string | null;
    createdAt: Date;
    relatedCaseNumber: number | null;
  }[],
  cancelled: ReadonlySet<number>,
): string {
  return cases
    .map((record) => {
      const label = moderationActionDefinition(record.action)?.label ?? record.action;
      const state = cancelled.has(record.caseNumber) ? " ~~removed~~" : "";
      const reason = record.reason ? ` — ${record.reason}` : "";
      return `**#${record.caseNumber}** ${label} by <@${record.moderatorId}> <t:${Math.floor(
        record.createdAt.getTime() / 1_000,
      )}:R>${reason}${state}`;
    })
    .join("\n")
    .slice(0, 1_024);
}
