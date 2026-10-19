/**
 * Shared plumbing for the moderation commands.
 *
 * Every `/warn`, `/ban`, ... command is a thin interface: it resolves options,
 * builds a `ModerationRequest`, calls `ModerationService` and renders the
 * outcome. The logic that every one of them repeats — resolving a target without
 * trusting user input, mapping a duration string, rendering partial failures —
 * lives here so the commands stay readable and cannot drift apart.
 *
 * Nothing here performs a permission check: authorization happens before the
 * command runs (the interaction handler evaluates the granular permission
 * declared in `moderationCommandPermissions`), and the service re-checks the
 * hierarchy rules that Discord itself enforces.
 */
import { MessageFlags, type ChatInputCommandInteraction, type EmbedBuilder } from "discord.js";

import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";
import { ValidationError } from "../../utils/errors.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import { MODERATION_ACTION_DEFINITIONS } from "../../modules/moderation/moderation-actions.js";
import type { ModerationLogEvent } from "../../modules/moderation/moderation.service.js";
import type { MemberTarget, ModerationOutcome } from "../../modules/moderation/moderation.types.js";
import { userActor } from "../../modules/moderation/moderation.types.js";

/** Message shown when a command is used outside a guild. */
export const GUILD_ONLY = "Moderation only works inside a server.";

/**
 * Durations offered by the commands, in the order they appear.
 *
 * A closed set rather than free text: a moderator typing `1h30` is a support
 * ticket, and the same vocabulary is reused by every command that takes a
 * duration, so `/mute`, `/timeout` and the future automod agree on the options.
 */
export const DURATION_CHOICES = [
  { name: "60 seconds", value: 60_000 },
  { name: "5 minutes", value: 5 * 60_000 },
  { name: "10 minutes", value: 10 * 60_000 },
  { name: "30 minutes", value: 30 * 60_000 },
  { name: "1 hour", value: 60 * 60_000 },
  { name: "6 hours", value: 6 * 60 * 60_000 },
  { name: "12 hours", value: 12 * 60 * 60_000 },
  { name: "1 day", value: 24 * 60 * 60_000 },
  { name: "3 days", value: 3 * 24 * 60 * 60_000 },
  { name: "7 days", value: 7 * 24 * 60 * 60_000 },
  // 28 days is Discord's documented maximum, but a deadline landing exactly on the
  // boundary is rejected, so the largest choice offered stays one minute short of
  // it — the same bound `MODERATION_LIMITS.maxTimeoutMs` enforces.
  { name: "27 days, 23 hours", value: 28 * 24 * 60 * 60_000 - 60_000 },
] as const;

/** @returns the human label of a duration value, for confirmation messages. */
export function describeDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "permanent";
  }
  const match = DURATION_CHOICES.find((choice) => choice.value === durationMs);
  return match ? match.name : formatDuration(durationMs);
}

/**
 * Resolves the target of a command from the interaction options.
 *
 * A ban or an unban can name a user who is not in the guild, which is why the
 * user is read first and membership is only a fallback: a moderator must be able
 * to unban someone who never joined, or who left while banned.
 */
export async function resolveMemberTarget(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  options: { readonly option?: string; readonly allowBanFetch?: boolean } = {},
): Promise<MemberTarget> {
  const name = options.option ?? "user";
  const user = interaction.options.getUser(name, true);
  const guildId = interaction.guildId;
  if (!guildId) {
    throw new ValidationError(GUILD_ONLY);
  }

  const members = context.moderation.members;

  const member = await members.readTarget(guildId, user.id);
  if (member) {
    return member;
  }
  if (options.allowBanFetch === true) {
    const banned = await members.readBannedTarget(guildId, user.id);
    if (banned) {
      return banned;
    }
  }

  // Not in the guild: the target is still actionable (a ban, an unban), but the
  // hierarchy is unknowable, so those facts are reported as "unknown" rather
  // than invented.
  return {
    type: "member",
    id: user.id,
    tag: user.tag,
    present: false,
    sameGuild: true,
    protectedMember: false,
    botPermissions: 0n,
    highestRolePosition: null,
    botHighestRolePosition: Number.MAX_SAFE_INTEGER,
    timedOutUntil: null,
    muted: false,
    quarantined: false,
    banned: options.allowBanFetch === true,
    roleIds: [],
  };
}

/** Builds the actor of a command invocation, marking God Access honestly. */
export function actorFrom(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
) {
  const isGod = hasGodAccess(interaction.user.id);
  if (isGod) {
    context.logger.warn("Moderation action requested by the owner account", {
      guildId: interaction.guildId ?? "unknown",
      userId: interaction.user.id,
      command: interaction.commandName,
    });
  }
  return userActor(interaction.user.id, interaction.user.tag, isGod);
}

/** @returns the reason option, trimmed and empty-string-free. */
export function reasonFrom(
  interaction: ChatInputCommandInteraction,
  option = "reason",
): string | null {
  const value = interaction.options.getString(option)?.trim();
  return value && value.length > 0 ? value : null;
}

/** Renders a successful moderation outcome. */
export function outcomeEmbed(outcome: ModerationOutcome): EmbedBuilder {
  const embed = brandedEmbed(
    `${MODERATION_ACTION_DEFINITIONS[outcome.action].label} recorded`,
  ).setDescription(
    [
      `Case **#${outcome.caseNumber}** — <@${outcome.targetId}>`,
      `Moderator: <@${outcome.case.moderatorId}>`,
      outcome.case.reason ? `Reason: ${outcome.case.reason}` : "No reason given.",
      outcome.case.expiresAt
        ? `Expires <t:${Math.floor(outcome.case.expiresAt.getTime() / 1_000)}:R>`
        : null,
      outcome.warningCount === undefined ? null : `Warnings: **${outcome.warningCount}**`,
      outcome.purgedCount === undefined ? null : `Messages removed: **${outcome.purgedCount}**`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );

  if (outcome.notes.length > 0) {
    embed.addFields({ name: "Note", value: outcome.notes.join("\n").slice(0, 1_024) });
  }
  return embed;
}

/** Renders a refusal (module disabled, target protected, missing reason). */
export async function replyWithRefusal(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  await interaction.editReply({ embeds: [errorEmbed("Action refused", message)] });
}

/** Wraps a command body so a refusal becomes an embed instead of a traceback. */
export async function guard(
  interaction: ChatInputCommandInteraction,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof ValidationError) {
      await replyWithRefusal(interaction, error.message);
      return;
    }
    throw error;
  }
}

/** A Discord log line, built from a moderation outcome. */
export function logEventFrom(guildId: string, outcome: ModerationOutcome): ModerationLogEvent {
  const targetTag = outcome.case.targetId;
  return {
    guildId,
    action: outcome.action,
    label: MODERATION_ACTION_DEFINITIONS[outcome.action].label,
    caseNumber: outcome.caseNumber,
    actor: {
      id: outcome.case.moderatorId,
      kind: outcome.case.moderatorKind,
      tag: null,
    },
    targetId: outcome.case.targetId,
    targetTag,
    reason: outcome.case.reason,
    durationMs: outcome.case.durationMs,
    expiresAt: outcome.case.expiresAt,
  };
}

/** Re-exported so command files import everything from one place. */
export { MessageFlags, brandedEmbed, errorEmbed };
export type { ChatInputCommandInteraction };
