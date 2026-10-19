/**
 * Rendering helpers for `/automod`.
 *
 * Split from the command so the two reports can be asserted without a Discord
 * interaction: each takes the plain configuration and returns an embed, which is
 * the same shape the moderation section's view already uses.
 */
import type { EmbedBuilder } from "discord.js";

import type { GuildConfig } from "../../services/config/index.js";
import { brandedEmbed } from "../../utils/presenters.js";
import {
  AUTOMOD_ACTOR_ID,
  AUTOMOD_RULES,
  automodRuleDefinition,
} from "../../modules/automod/index.js";

/** Renders the module's state and escalation ladder. */
export function renderAutomodStatus(config: GuildConfig, guildId: string): EmbedBuilder {
  const { automod } = config;
  const enabled = AUTOMOD_RULES.filter(
    (rule) => automod.rules[automodRuleDefinition(rule)!.setting],
  );

  return brandedEmbed("Automod")
    .setDescription(
      [
        `**Module:** ${automod.enabled ? "enabled" : "disabled"}`,
        `**Window:** ${automod.windowSeconds}s`,
        `**Delete trigger messages:** ${automod.deleteTriggerMessages ? "yes" : "no"}`,
        `**Note on a first trigger:** ${automod.warnOnFirstTrigger ? "yes" : "no"}`,
        `**Active rules:** ${enabled.length}/${AUTOMOD_RULES.length}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "Escalation ladder",
        value:
          automod.escalation.length === 0
            ? "Empty — triggers are recorded and nobody is punished."
            : [...automod.escalation]
                .sort((left, right) => left.triggers - right.triggers)
                .map(
                  (step) =>
                    `${step.triggers} trigger(s) → **${step.action}**${
                      step.action === "mute" || step.action === "timeout"
                        ? ` (${Math.round(step.durationMs / 60_000)} min)`
                        : ""
                    }`,
                )
                .join("\n"),
      },
      {
        name: "Who punishes",
        value: `Automod never sanctions directly: every action runs through the moderation module as \`${AUTOMOD_ACTOR_ID}\` (kind \`system\`, source \`automation\`).`,
      },
      {
        name: "Change these",
        value:
          "`/settings view area:automod` · `/settings set area:automod setting:automod-enabled value:true`",
      },
    )
    .setFooter({ text: `Guild ${guildId}` });
}

/** Renders every rule with its state and threshold. */
export function renderAutomodRules(config: GuildConfig, guildId: string): EmbedBuilder {
  const { automod } = config;
  const lines = AUTOMOD_RULES.map((rule) => {
    const definition = automodRuleDefinition(rule)!;
    const on = automod.rules[definition.setting];
    const threshold =
      definition.threshold === null ? "—" : String(automod.thresholds[definition.threshold]);
    return `${on ? "✅" : "⬜"} **${definition.label}** — ${definition.description} (threshold: ${threshold})`;
  });

  return brandedEmbed("Automod rules")
    .setDescription(lines.join("\n").slice(0, 4_000))
    .setFooter({ text: `Guild ${guildId}` });
}
