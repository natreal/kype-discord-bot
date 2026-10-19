/**
 * Rendering helpers for the security module.
 *
 * Shared between `/security status` and the security section of `/settings view`,
 * because both answer the same question and an operator reading one should see
 * exactly what the other shows.
 */
import type { EmbedBuilder, ChatInputCommandInteraction } from "discord.js";

import type { GuildConfig } from "../../services/config/index.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import type { SecurityIncident } from "../../modules/security/index.js";

/** Renders the live security state, including any active incident. */
export function renderSecurityStatus(
  config: GuildConfig["security"],
  incidents: readonly SecurityIncident[],
  guildId: string,
): EmbedBuilder {
  const embed = brandedEmbed("Security")
    .setDescription(
      [
        `**Module:** ${config.enabled ? "enabled" : "disabled"}`,
        `**Lockdown:** ${config.lockdown ? "requested by configuration" : "not configured"}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "Anti-raid",
        value: config.antiRaid.enabled
          ? [
              `${config.antiRaid.burstThreshold} join(s) per ${config.antiRaid.windowSeconds}s across ${config.antiRaid.joinsPerMinute}/min`,
              `New accounts (< ${config.antiRaid.minAccountAgeDays} day(s)) are treated as raid signatures.`,
              `Verification of newcomers: ${config.antiRaid.verifyNewMembers ? "on" : "off"}`,
              `Automatic lockdown: ${config.antiRaid.lockdownOnRaid ? "on" : "off"} · recovery after ${Math.round(config.antiRaid.raidModeSeconds / 60)} min`,
            ].join("\n")
          : "Disabled.",
      },
      {
        name: "Anti-nuke",
        value: config.antiNuke.enabled
          ? [
              `Weight ${config.antiNuke.actionThreshold} of destructive actions per ${config.antiNuke.windowSeconds}s`,
              `Remove the culprit's permissions: ${config.antiNuke.stripPermissions ? "yes" : "no (log only)"}`,
              `Escalate to the owner: ${config.antiNuke.escalateToOwner ? "yes" : "no"}`,
              `Whitelisted accounts: ${config.antiNuke.whitelistUserIds.length}`,
            ].join("\n")
          : "Disabled.",
      },
      {
        name: "Active incidents",
        value:
          incidents.length === 0
            ? "None."
            : incidents
                .map(
                  (incident) =>
                    `**${incident.kind}** — ${incident.summary}${
                      incident.expiresAt
                        ? `\nRecovery <t:${Math.floor(incident.expiresAt.getTime() / 1_000)}:R>`
                        : ""
                    }`,
                )
                .join("\n")
                .slice(0, 1_024),
      },
    )
    .setFooter({ text: `Guild ${guildId}` });

  if (!config.enabled) {
    embed.addFields({
      name: "Enable it",
      value:
        "`/settings set area:security setting:security-enabled value:true`, then `/setup run` to create `#bot-security` and the `Quarantined` role.",
    });
  }
  return embed;
}

/** Renders the security section inside `/settings view area:security`. */
export function renderSecurityConfigView(
  config: GuildConfig["security"],
  guildId: string,
): EmbedBuilder {
  return renderSecurityStatus(config, [], guildId);
}

/**
 * Replies with the security view.
 *
 * Reads the *live* incidents rather than assuming there are none: an operator
 * asking about security while a raid is in progress is exactly the person who needs
 * to see it, and a report that says "no incidents" during a raid is worse than no
 * report at all.
 */
export async function replyWithSecurityView(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      embeds: [errorEmbed("Server only", "Security is configured per server.")],
    });
    return;
  }

  const config = await context.config.get(guild.id, guild.name);
  const incidents = context.security
    ? await context.security.service.activeIncidents(guild.id)
    : [];
  await interaction.editReply({
    embeds: [renderSecurityStatus(config.security, incidents, guild.id)],
  });
}
