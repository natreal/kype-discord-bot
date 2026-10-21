/**
 * `/restart` — restarts the bot through its supervisor.
 *
 * A restart is a stop plus an instruction to come back, and the second half is the
 * hard part: the supervisor treats a bot that exits on request as "stay down", which
 * is exactly what `/stop` needs and the opposite of what `/restart` needs. The
 * process control service writes a restart marker before shutting down; the
 * supervisor deletes it, sees that this exit was intentional, and relaunches.
 *
 * When nothing supervises the process the command refuses rather than stopping a bot
 * that would never come back, and says how to start it again.
 */
import { MessageFlags, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";
import { actionRequest, isOwner } from "./stop.js";

export default defineSlashCommand({
  meta: {
    name: "restart",
    description: "Restart the bot through its supervisor (owner only).",
    category: "utility",
    usage: "/restart [reason]",
  },
  data: new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the bot through its supervisor (owner only).")
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the bot is being restarted (recorded in the log).")
        .setMaxLength(200),
    ),
  execute: async (interaction, context) => {
    if (!isOwner(interaction, context)) {
      await interaction.reply({
        embeds: [
          errorEmbed("Owner only", "Only the bot owner or the server owner can restart the bot."),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const control = context.process;
    if (!control) {
      await interaction.reply({
        embeds: [errorEmbed("Unavailable", "Process control is not wired in this process.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Deferred, not replied: whether this is possible depends on the supervisor, and
    // the answer must be the kernel's, not an optimistic guess. The outcome is
    // reported in the same message a moment later.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await control.restart(actionRequest(interaction));

    if (!outcome.ok) {
      await interaction.editReply({
        embeds: [errorEmbed("Restart refused", outcome.reason ?? "The restart was not accepted.")],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        brandedEmbed("Restarting")
          .setDescription(
            [
              "Shutting down now; the supervisor brings the bot back up on its own (a few seconds, plus the build if the source changed).",
              "",
              "Slash commands are re-registered at startup, so give it a moment before retrying.",
            ].join("\n"),
          )
          .addFields(
            { name: "Uptime", value: formatDuration(context.uptimeMs), inline: true },
            {
              name: "Marker",
              value: `\`${outcome.markerPath ?? "restart.request"}\``,
              inline: true,
            },
          ),
      ],
    });
  },
});
