/**
 * `/leave` — makes the bot leave the server it was invoked in.
 *
 * The counterpart of inviting the bot: an operator can remove it from one server
 * without touching the host, stopping the process, or affecting any other guild.
 * The reply is ephemeral and is sent *before* the leave, because once the bot has
 * left it can no longer answer in the channel it was invoked in; the grace period
 * itself lives in `GuildLeaveService` so it is tested rather than incidental.
 *
 * Bot-owner only (God Access or Discord's application owner). A server owner can
 * already remove the bot through Discord's own settings, so this command adds no
 * capability for them — it exists so the operator can do it from inside Discord.
 */
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import type { GuildLeaveRequest } from "../../services/guild/index.js";

/** Everything a leave needs except the guild, which comes from the interaction. */
export type GuildLeaveActionRequest = Omit<GuildLeaveRequest, "guild">;

export default defineSlashCommand({
  meta: {
    name: "leave",
    description: "Make the bot leave this server (owner only).",
    category: "utility",
    usage: "/leave [reason]",
  },
  data: new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave this server (owner only).")
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the bot is leaving (recorded in the log and audit trail).")
        .setMaxLength(200),
    ),
  execute: async (interaction, context) => {
    if (!isBotOwner(interaction, context)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            "Owner only",
            "Only the bot owner can make the bot leave a server. A server owner can remove the bot from the server's own integration settings.",
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        embeds: [errorEmbed("Server only", "This command can only be used in a server.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const leave = context.guildLeave;
    if (!leave) {
      await interaction.reply({
        embeds: [errorEmbed("Unavailable", "Leaving a server is not wired in this process.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const request = actionRequest(interaction);
    const fields = [{ name: "Requested by", value: interaction.user.tag, inline: true }];
    if (request.reason !== undefined) {
      fields.push({ name: "Reason", value: request.reason, inline: true });
    }

    await interaction.reply({
      embeds: [
        brandedEmbed("Leaving server")
          .setDescription(
            [
              `Leaving **${guild.name}** now. This reply is sent first, so it reaches you before the bot loses access to this channel.`,
              "",
              "Stored configuration and history are kept — re-invite the bot to bring it back.",
            ].join("\n"),
          )
          .addFields(...fields),
      ],
      flags: MessageFlags.Ephemeral,
    });

    const outcome = await leave.leave({ ...request, guild });

    // Best-effort and guild-scoped: the audit row survives the leave, which is the
    // point of writing it here rather than relying on a log in a channel the bot
    // is about to lose access to.
    await context.audit.record({
      guildId: guild.id,
      action: "guild.leave",
      category: "guild",
      severity: "privileged",
      actorId: request.actorId,
      actorKind: "user",
      targetType: "guild",
      targetId: guild.id,
      outcome: outcome.ok ? "success" : "failure",
      details: { guildName: guild.name, reason: request.reason ?? null },
    });

    if (!outcome.ok) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            "Could not leave",
            `Discord did not accept the request, so the bot is still in **${guild.name}**. Check the logs for details.`,
          ),
        ],
      });
    }
  },
});

/** Reads the command options into the shape the leave service expects. */
export function actionRequest(interaction: ChatInputCommandInteraction): GuildLeaveActionRequest {
  const reason = interaction.options.getString("reason") ?? undefined;
  return {
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * @returns true when the caller owns the bot.
 *
 * God Access (the configured owner) or the application's owner as reported by
 * Discord. Deliberately not the guild owner: leaving is a decision about the bot,
 * and a guild owner can already remove it through Discord itself.
 */
export function isBotOwner(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): boolean {
  if (hasGodAccess(interaction.user.id)) {
    return true;
  }
  // `DISCORD_OWNER_ID` is not always configured, and `hasGodAccess` only knows the
  // static owner list. Discord's own answer is correct by construction.
  return context.client.application?.owner?.id === interaction.user.id;
}
