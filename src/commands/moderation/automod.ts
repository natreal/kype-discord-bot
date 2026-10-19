/**
 * `/automod` — the automod module's operational view.
 *
 * Subcommands, not settings: rule configuration belongs to `/settings automod`,
 * which `/automod status` points at. What a moderator needs at 3am is "which rules
 * are on, with what thresholds, and what has fired recently" — plus a way to clear
 * a member's window after they have already been punished.
 *
 * Every value is read, never assumed: rule states come from the live configuration
 * and the trigger history from an in-process lookup, never from a cached snapshot.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { AUTOMOD_ACTOR_ID } from "../../modules/automod/index.js";
import { renderAutomodRules, renderAutomodStatus } from "../utility/settings-automod.js";

/** Message shown when automod is not wired in this build. */
const UNAVAILABLE = "Automod is not available in this build.";

export default defineSlashCommand({
  meta: {
    name: "automod",
    description: "Inspect the automatic moderation rules.",
    category: "moderation",
    usage: "/automod <status|rules|history|reset>",
    examples: ["/automod status", "/automod history user:@Alex"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ModerateMembers],
    custom: ["moderation.view"],
  },
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Inspect the automatic moderation rules.")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show whether automod is enabled and how it escalates."),
    )
    .addSubcommand((sub) =>
      sub.setName("rules").setDescription("List every rule, its state and its threshold."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("history")
        .setDescription("Show what automod recorded against a member.")
        .addUserOption((option) =>
          option.setName("user").setDescription("The member to inspect.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Forget a member's recent trigger window, after a punishment.")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The member whose window to clear.")
            .setRequired(true),
        ),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({
        embeds: [errorEmbed("Server only", "Automod is configured per server.")],
      });
      return;
    }
    const automod = context.automod;
    if (!automod) {
      await interaction.editReply({ embeds: [errorEmbed("Unavailable", UNAVAILABLE)] });
      return;
    }

    const config = await context.config.get(guildId);
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "status") {
      await interaction.editReply({ embeds: [renderAutomodStatus(config, guildId)] });
      return;
    }

    if (subcommand === "rules") {
      await interaction.editReply({ embeds: [renderAutomodRules(config, guildId)] });
      return;
    }

    const user = interaction.options.getUser("user", true);

    if (subcommand === "history") {
      const cases = await context.moderation.service.history(guildId, {
        targetId: user.id,
        limit: 25,
      });
      const automation = cases.filter((record) => record.moderatorId === AUTOMOD_ACTOR_ID);
      await interaction.editReply({
        embeds: [
          brandedEmbed(`Automod history — ${user.tag}`).setDescription(
            automation.length === 0
              ? "Automod has nothing on record for this member."
              : automation
                  .map(
                    (record) =>
                      `**#${record.caseNumber}** ${record.action} — ${record.reason ?? "no reason"} · <t:${Math.floor(record.createdAt.getTime() / 1_000)}:R>`,
                  )
                  .join("\n")
                  .slice(0, 4_000),
          ),
        ],
      });
      return;
    }

    // `reset` clears the sliding window only: the recorded cases stay, because the
    // history is evidence and a request to "forget" it deserves a conversation,
    // not a silently rewritten log.
    automod.service.reset(guildId, user.id);
    await interaction.editReply({
      embeds: [
        brandedEmbed("Automod window cleared").setDescription(
          `<@${user.id}>'s recent message and reaction history has been forgotten.\nRecorded cases are unchanged — use \`/history\` to review them.`,
        ),
      ],
    });
  },
});
