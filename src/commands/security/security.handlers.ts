/**
 * `/security` subcommand handlers.
 *
 * Each handler takes the interaction and the context so the *decision* is readable
 * on its own: what was asked, what the module refused, and what changed. The one
 * rule they all follow is that nothing punishes a member except
 * `ModerationService` — containment is a `quarantine` case, and a nuke response is
 * a role removal.
 */
import type { ChatInputCommandInteraction } from "discord.js";

import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import { userActor } from "../../modules/moderation/moderation.types.js";
import { renderSecurityStatus } from "../utility/settings-security.js";

/** Message shown when the module is not wired or not enabled. */
const UNAVAILABLE = "The security module is not available in this build.";

/** Resolves the guild-bound security context, or replies with a refusal. */
async function requireSecurity(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
) {
  if (!interaction.guild) {
    await interaction.editReply({
      embeds: [errorEmbed("Server only", "Security only works inside a server.")],
    });
    return null;
  }
  if (!context.security) {
    await interaction.editReply({ embeds: [errorEmbed("Unavailable", UNAVAILABLE)] });
    return null;
  }
  return context.security;
}

/** `/security status` — the live state, read-only. */
export async function handleSecurityStatus(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const security = await requireSecurity(interaction, context);
  if (!security || !interaction.guild) {
    return;
  }
  const [config, incidents] = await Promise.all([
    security.service.config(interaction.guild.id),
    security.service.activeIncidents(interaction.guild.id),
  ]);
  await interaction.editReply({
    embeds: [renderSecurityStatus(config, incidents, interaction.guild.id)],
  });
}

/** `/security lockdown` — lock the guild now, for a holder of `security.lockdown`. */
export async function handleLockdown(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const security = await requireSecurity(interaction, context);
  if (!security || !interaction.guild) {
    return;
  }
  const reason =
    interaction.options.getString("reason")?.trim() ?? `Manual lockdown by ${interaction.user.tag}`;
  const locked = await security.service.setLockdown(
    interaction.guild.id,
    true,
    reason,
    interaction.user.id,
  );

  await interaction.editReply({
    embeds: [
      locked
        ? brandedEmbed("Server locked down").setDescription(
            "Every text channel now denies `Send Messages` to `@everyone`.\nUse `/security unlock` to restore it, or wait for the automatic recovery.",
          )
        : errorEmbed(
            "Lockdown not applied",
            "The security module is disabled in this server. Enable it with `/settings set area:security setting:security-enabled value:true`.",
          ),
    ],
  });
}

/** `/security unlock` — restore the guild, resolving the active incidents. */
export async function handleUnlock(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const security = await requireSecurity(interaction, context);
  if (!security || !interaction.guild) {
    return;
  }
  const result = await security.service.unlockByOperator(
    interaction.guild.id,
    interaction.user.id,
    `Manual unlock by ${interaction.user.tag}`,
  );

  await interaction.editReply({
    embeds: [
      result.unlocked
        ? brandedEmbed("Server unlocked").setDescription(
            `Channels restored. ${result.incidents.length} incident(s) closed.`,
          )
        : errorEmbed(
            "Unlock not applied",
            "The channels could not be restored. Run `/setup run` to repair, then try again.",
          ),
    ],
  });
}

/** `/security quarantine` — containment, recorded as a real moderation case. */
export async function handleQuarantine(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const security = await requireSecurity(interaction, context);
  if (!security || !interaction.guild) {
    return;
  }
  const user = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason", true);
  const target = await context.moderation.members.readTarget(interaction.guild.id, user.id);
  if (!target) {
    await interaction.editReply({
      embeds: [errorEmbed("Not a member", `${user.tag} is not in this server.`)],
    });
    return;
  }

  try {
    const outcome = await context.moderation.service.execute(interaction.guild.id, {
      action: "quarantine",
      actor: userActor(
        interaction.user.id,
        interaction.user.tag,
        hasGodAccess(interaction.user.id),
      ),
      target,
      reason,
      source: "command",
    });
    await interaction.editReply({
      embeds: [
        brandedEmbed("Member quarantined").setDescription(
          `Case **#${outcome.caseNumber}** — <@${user.id}>\nReason: ${reason}\nLift it with \`/unquarantine\`.`,
        ),
      ],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Quarantine refused",
          error instanceof Error ? error.message : "The member could not be contained.",
        ),
      ],
    });
  }
}

/** `/security recover` — close every active incident and restore the guild. */
export async function handleRecover(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const security = await requireSecurity(interaction, context);
  if (!security || !interaction.guild) {
    return;
  }
  const incidents = await security.service.activeIncidents(interaction.guild.id);
  const recoveredKinds: string[] = [];
  for (const incident of incidents) {
    const recovered = await security.service.recover(
      interaction.guild.id,
      incident.id,
      interaction.user.id,
    );
    if (recovered) {
      recoveredKinds.push(incident.kind);
    }
  }

  await interaction.editReply({
    embeds: [
      brandedEmbed("Recovery complete").setDescription(
        recoveredKinds.length === 0
          ? "There was no active incident to close."
          : `Closed: ${recoveredKinds.map((kind) => `\`${kind}\``).join(", ")}. Channels restored.`,
      ),
    ],
  });
}
