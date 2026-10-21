/**
 * `/stop` — shuts the bot down gracefully.
 *
 * The in-Discord equivalent of the launcher's stop button, for the case that
 * matters most: nobody is at the machine that runs the bot. The reply is sent
 * *before* the process stops listening, and the shutdown path is the same one a
 * `SIGTERM` takes, so the Discord session and the database pool are closed properly
 * instead of being cut off.
 *
 * Restricted to God Access and the server owner. Stopping the bot for every server
 * it serves is not a per-guild decision, and a moderator who can silence the bot
 * everywhere is a privilege escalation, not a convenience.
 */
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import type { ProcessActionRequest } from "../../services/process/index.js";

export default defineSlashCommand({
  meta: {
    name: "stop",
    description: "Shut the bot down gracefully (owner only).",
    category: "utility",
    usage: "/stop [reason]",
  },
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Shut the bot down gracefully (owner only).")
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the bot is being stopped (recorded in the log).")
        .setMaxLength(200),
    ),
  execute: async (interaction, context) => {
    if (!isOwner(interaction, context)) {
      await interaction.reply({
        embeds: [
          errorEmbed("Owner only", "Only the bot owner or the server owner can stop the bot."),
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

    await interaction.reply({
      embeds: [
        brandedEmbed("Stopping")
          .setDescription(
            [
              "Shutting down gracefully: the Discord connection is closed and the database pool released.",
              "",
              "Nothing restarts the bot automatically — start it again with the launcher (`npm run bot:start`, `Start-Bot.cmd` or the desktop icon).",
            ].join("\n"),
          )
          .addFields({ name: "Uptime", value: formatDuration(context.uptimeMs), inline: true }),
      ],
      flags: MessageFlags.Ephemeral,
    });

    await control.stop(actionRequest(interaction));
  },
});

/** Builds the audit record a stop or restart carries. */
export function actionRequest(interaction: ChatInputCommandInteraction): ProcessActionRequest {
  const reason = interaction.options.getString("reason") ?? undefined;
  return {
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    guildId: interaction.guildId ?? "unknown",
    guildName: interaction.guild?.name ?? "unknown",
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * @returns true when the caller may stop or restart the bot.
 *
 * God Access (the configured owner), the owner of the server the command was run in,
 * or the application's owner as reported by Discord. Deliberately not "anyone with
 * Manage Server": the bot lives in many guilds, and one administrator's reboot is
 * every server's outage.
 */
export function isOwner(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): boolean {
  if (hasGodAccess(interaction.user.id)) {
    return true;
  }
  if (interaction.guild?.ownerId === interaction.user.id) {
    return true;
  }
  // `DISCORD_OWNER_ID` is not always configured, and `hasGodAccess` only knows the
  // static owner list. Discord's own answer — the application owner — is the one that
  // is correct by construction, so it is checked as well.
  return context.client.application?.owner?.id === interaction.user.id;
}
