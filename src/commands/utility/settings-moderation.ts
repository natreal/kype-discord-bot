/**
 * `/settings moderation` — the moderation section's operational view.
 *
 * The section was already the source of truth (`enabled`, `warnThreshold`,
 * `dmOnPunishment`) and `moderation.enabled` is enforced by the service. What V4
 * adds is the view an administrator needs when a moderator reports "the bot logs
 * nothing" or "/mute does not work": whether the log channel exists, whether the
 * `Muted` role exists, and what has been recorded.
 *
 * Every value is measured, never assumed: the log channel is looked up in the
 * guild cache, and the mute role through the same adapter `/mute` uses.
 */
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import type { CommandExecutionContext } from "../context.js";
import type { ConfigWriteActor } from "../../services/config/index.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import { MODERATION_LIMITS } from "../../modules/moderation/moderation-actions.js";

/** The channel name `setup` creates for the log stream. */
const LOG_CHANNEL_NAME = "server-logs";

/** Everything the report shows. */
export interface ModerationOverview {
  readonly enabled: boolean;
  readonly warnThreshold: number;
  readonly dmOnPunishment: boolean;
  readonly loggingEnabled: boolean;
  readonly logChannelId: string | null;
  readonly logChannelPresent: boolean;
  readonly muteRolePresent: boolean;
  readonly muteRoleName: string | null;
  readonly cases: number;
  readonly warnings: number;
}

/** Reads every fact the report shows, from the live guild. */
export async function readModerationOverview(
  guildId: string,
  guildName: string,
  context: CommandExecutionContext,
): Promise<ModerationOverview> {
  const config = await context.config.get(guildId, guildName);
  const guild = context.client.guilds.cache.get(guildId) ?? null;

  const [muteRole, recentCases] = await Promise.all([
    context.moderation.members.muteRole(),
    context.moderation.service.history(guildId, { limit: MODERATION_LIMITS.maxHistoryEntries }),
  ]);

  const logChannelId = config.logging.channelId;
  const logChannelPresent =
    guild === null
      ? false
      : logChannelId === null
        ? guild.channels.cache.some(
            (channel) => channel.name.trim().toLowerCase() === LOG_CHANNEL_NAME,
          )
        : guild.channels.cache.has(logChannelId);

  return {
    enabled: config.moderation.enabled,
    warnThreshold: config.moderation.warnThreshold,
    dmOnPunishment: config.moderation.dmOnPunishment,
    loggingEnabled: config.logging.enabled,
    logChannelId,
    logChannelPresent,
    muteRolePresent: muteRole !== null,
    muteRoleName: muteRole?.name ?? null,
    cases: recentCases.length,
    warnings: recentCases.filter((record) => record.action === "warn").length,
  };
}

/** Renders the moderation report. */
export function renderModerationOverview(
  overview: ModerationOverview,
  guildId: string,
): EmbedBuilder {
  return brandedEmbed("Moderation")
    .setDescription(
      [
        `**Module:** ${overview.enabled ? "enabled" : "disabled"}`,
        `**Warning threshold:** ${
          overview.warnThreshold === 0
            ? "no automatic threshold"
            : `${overview.warnThreshold} warning(s)`
        }`,
        `**DM on punishment:** ${overview.dmOnPunishment ? "yes" : "no"}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "Log channel",
        value: overview.loggingEnabled
          ? overview.logChannelPresent
            ? `Posting to ${overview.logChannelId ? `<#${overview.logChannelId}>` : `#${LOG_CHANNEL_NAME}`}.`
            : "Enabled, but the channel does not exist yet. Run `/setup run`."
          : "Logging is disabled, so no moderation action is posted.",
      },
      {
        name: "Muted role",
        value: overview.muteRolePresent
          ? `\`${overview.muteRoleName}\` found, so \`/mute\` and \`/unmute\` work.`
          : "No `Muted` role found: `/mute` refuses until one exists. Run `/setup run` to create it.",
      },
      {
        name: "Recorded",
        value: `${overview.cases} recent case(s), including ${overview.warnings} warning(s).`,
      },
    )
    .setFooter({ text: `Guild ${guildId}` });
}

/** Renders the moderation section inside `/settings view area:moderation`. */
export async function replyWithModerationView(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      embeds: [errorEmbed("Server only", "Moderation is configured per server.")],
    });
    return;
  }
  const overview = await readModerationOverview(guild.id, guild.name, context);
  await interaction.editReply({ embeds: [renderModerationOverview(overview, guild.id)] });
}

/** @returns the audit actor of a configuration write, marking the owner account. */
export function moderationActor(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): ConfigWriteActor {
  const markGod = hasGodAccess(interaction.user.id);
  if (markGod) {
    context.logger.warn("Moderation settings changed by the owner account", {
      guildId: interaction.guildId ?? "unknown",
      userId: interaction.user.id,
    });
  }
  return { id: interaction.user.id, kind: markGod ? "god" : "user" };
}
