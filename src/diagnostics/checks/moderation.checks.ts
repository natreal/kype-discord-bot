/**
 * Moderation diagnostics (V4).
 *
 * These checks answer the questions an operator actually asks when a moderator
 * reports a problem:
 *
 * 1. is the module enabled and usable? (`moderation.settings`)
 * 2. can it deliver what `/settings logging` promises? (`moderation.delivery`)
 * 3. can `/mute` work at all, and does it actually silence? (`moderation.mute-role`)
 * 4. has anything been recorded? (`moderation.history`)
 *
 * All four are read-only. A diagnostic never creates the `Muted` role, never
 * creates the log channel and never writes a case: it reports, and names the
 * command that fixes the situation (`/setup run` provisions and reconciles the
 * Muted role; the diagnostic only tells the operator to run it).
 */
import { ChannelType, type Guild } from "discord.js";

import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";
import { diffMuteRole, MUTE_ROLE_NAME } from "../../modules/moderation/mute-role.spec.js";
import { MODERATION_LIMITS } from "../../modules/moderation/moderation-actions.js";

/** The channel name `setup` creates for the log stream. */
const LOG_CHANNEL_NAME = "server-logs";

/** Whether the moderation module is enabled and its settings are usable. */
export const moderationSettingsDiagnostic: Diagnostic = {
  id: "moderation.settings",
  category: "moderation",
  label: "Module settings",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return {
        id: "moderation.settings",
        category: "moderation",
        label: "Module settings",
        status: "fail",
        detail: "Moderation settings can only be checked inside a server.",
      };
    }

    try {
      const config = await context.config.get(guild.id, guild.name);
      const moderation = config.moderation;

      if (!moderation.enabled) {
        return {
          id: "moderation.settings",
          category: "moderation",
          label: "Module settings",
          status: "warn",
          detail: "Moderation is disabled: every punishment command refuses.",
          remediation:
            "Run `/settings set area:moderation setting:moderation-enabled value:true` to enable it.",
          metrics: { warnThreshold: moderation.warnThreshold },
        };
      }

      const notes: string[] = [];
      if (moderation.warnThreshold === 0) {
        notes.push("no automatic warning threshold");
      }
      if (!moderation.dmOnPunishment) {
        notes.push("members are not notified by DM");
      }

      return {
        id: "moderation.settings",
        category: "moderation",
        label: "Module settings",
        status: "pass",
        detail:
          notes.length === 0
            ? `Enabled, threshold at ${moderation.warnThreshold} warning(s), DM notifications on.`
            : `Enabled (${notes.join(", ")}).`,
        metrics: { warnThreshold: moderation.warnThreshold },
      };
    } catch (error) {
      return {
        id: "moderation.settings",
        category: "moderation",
        label: "Module settings",
        status: "fail",
        detail: `The moderation settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * Whether a punishment is actually delivered to Discord's log channel.
 *
 * The failure modes are reported distinctly because the fixes differ: logging
 * disabled, logging enabled without a channel, a configured channel that no longer
 * exists, and a channel the bot cannot post in. Reporting "logging: off" for all
 * four would send an operator looking in the wrong place.
 */
export const moderationDeliveryDiagnostic: Diagnostic = {
  id: "moderation.delivery",
  category: "moderation",
  label: "Log delivery",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return {
        id: "moderation.delivery",
        category: "moderation",
        label: "Log delivery",
        status: "fail",
        detail: "Log delivery can only be checked inside a server.",
      };
    }

    const config = await context.config.get(guild.id, guild.name);
    if (!config.logging.enabled) {
      return {
        id: "moderation.delivery",
        category: "moderation",
        label: "Log delivery",
        status: "warn",
        detail: "Logging is disabled, so moderation actions are only written to the operator log.",
        remediation:
          "Run `/settings set area:logging setting:logging-enabled value:true`, then `/setup run`.",
      };
    }

    const channel = resolveLogChannel(guild, config.logging.channelId);
    if (channel === null) {
      return {
        id: "moderation.delivery",
        category: "moderation",
        label: "Log delivery",
        status: "warn",
        detail:
          config.logging.channelId === null
            ? "Logging is enabled but no channel is recorded yet."
            : `The configured log channel (${config.logging.channelId}) does not exist in this server.`,
        remediation: "Run `/setup run` to create or repair the log channel.",
      };
    }

    const canPost = guild.members.me?.permissionsIn(channel).has("SendMessages") ?? false;
    if (!canPost) {
      return {
        id: "moderation.delivery",
        category: "moderation",
        label: "Log delivery",
        status: "fail",
        detail: `The bot cannot post in the log channel (#${channel.name}).`,
        remediation: "Grant the bot View Channel and Send Messages on the log channel.",
      };
    }

    return {
      id: "moderation.delivery",
      category: "moderation",
      label: "Log delivery",
      status: "pass",
      detail: `Moderation actions are posted to #${channel.name}.`,
    };
  },
};

/**
 * Whether `/mute` and `/unmute` can work, *and whether the mute actually silences*.
 *
 * The second half is the important one. Checking that a role named `Muted` exists
 * answers the wrong question: a role that allows Send Messages passes such a check
 * while silencing nobody, and the moderator sees a successful mute. So this check
 * verifies the role against `diffMuteRole` and reports exactly which denies are
 * missing, naming the command that fixes it.
 *
 * Its absence is a *warning*, not a failure: a server that only uses timeouts is
 * healthy, and a red diagnostic on every fresh installation would be noise.
 */
export const moderationMuteRoleDiagnostic: Diagnostic = {
  id: "moderation.mute-role",
  category: "moderation",
  label: "Muted role",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return Promise.resolve({
        id: "moderation.mute-role",
        category: "moderation",
        label: "Muted role",
        status: "fail",
        detail: "The Muted role can only be checked inside a server.",
      });
    }

    const role = guild.roles.cache.find(
      (candidate) => candidate.name.trim().toLowerCase() === MUTE_ROLE_NAME,
    );
    if (!role) {
      return Promise.resolve({
        id: "moderation.mute-role",
        category: "moderation",
        label: "Muted role",
        status: "warn",
        detail:
          "No `Muted` role exists, so `/mute` and `/unmute` refuse. This is fine if you only use timeouts.",
        remediation:
          "Run `/setup run` to create it, or create a role named `Muted` that denies Send Messages and move it below the bot's role.",
      });
    }

    const me = guild.members.me;
    const botPosition = me?.roles.highest.position ?? 0;
    const diff = diffMuteRole(
      {
        id: role.id,
        name: role.name,
        permissionBitfield: role.permissions.bitfield,
        position: role.position,
        botHighestPosition: botPosition,
      },
      guild.roles.everyone.permissions.bitfield,
      // Falls back to the guild-level permission set when the bot's own member is
      // unavailable, which reports a difference rather than silently passing.
      me?.permissions.bitfield ?? 0n,
    );

    if (diff.ok) {
      return Promise.resolve({
        id: "moderation.mute-role",
        category: "moderation",
        label: "Muted role",
        status: "pass",
        detail: `\`${role.name}\` denies the permissions a mute needs, and the bot can assign it.`,
        metrics: { rolePosition: role.position, botPosition },
      });
    }

    // A missing deny makes `/mute` look successful while the member keeps posting, so
    // the check fails rather than warns: it is a broken feature, not a preference.
    const blocking = diff.differences.filter((entry) => entry.code.startsWith("deny-missing"));
    const unwritable = diff.differences.some((entry) => entry.detail.includes("Grant the bot"));
    const remediation = unwritable
      ? "Grant the bot the permissions named above, then run `/setup run` to correct the role."
      : "Run `/setup run` to correct the role's permissions, or clear them on the role by hand.";

    return Promise.resolve({
      id: "moderation.mute-role",
      category: "moderation",
      label: "Muted role",
      status: blocking.length > 0 ? "fail" : "warn",
      detail:
        blocking.length > 0
          ? `\`${role.name}\` does not deny ${blocking
              .map((entry) => `\`${entry.code.replace("deny-missing:", "")}\``)
              .join(", ")}, so a muted member can still post.`
          : `\`${role.name}\` has ${diff.differences.length} permission difference(s) from the mute specification.`,
      remediation,
      metrics: {
        rolePosition: role.position,
        botPosition,
        differences: diff.differences.length,
      },
    });
  },
};

/**
 * What moderation has actually recorded.
 *
 * Informational by construction: a guild with no cases is not unhealthy, and the
 * check reports it as a pass with a count of zero rather than a warning.
 */
export const moderationHistoryDiagnostic: Diagnostic = {
  id: "moderation.history",
  category: "moderation",
  label: "Recorded cases",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    const moderation = context.moderation;
    if (!guild || !moderation) {
      return {
        id: "moderation.history",
        category: "moderation",
        label: "Recorded cases",
        status: "warn",
        detail: "The moderation service is not available in this context.",
      };
    }

    try {
      const cases = await moderation.service.history(guild.id, {
        limit: MODERATION_LIMITS.maxHistoryEntries,
      });
      const last = cases[0] ?? null;
      return {
        id: "moderation.history",
        category: "moderation",
        label: "Recorded cases",
        status: "pass",
        detail:
          last === null
            ? "No moderation case has been recorded in this server yet."
            : `${cases.length} recent case(s); the latest is #${last.caseNumber} (\`${last.action}\`).`,
        metrics: { recentCases: cases.length },
      };
    } catch (error) {
      return {
        id: "moderation.history",
        category: "moderation",
        label: "Recorded cases",
        status: "fail",
        detail: `The case history could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/** @returns the log channel of a guild, by ID first and then by expected name. */
function resolveLogChannel(guild: Guild, channelId: string | null) {
  if (channelId !== null) {
    const configured = guild.channels.cache.get(channelId);
    return configured && configured.type === ChannelType.GuildText ? configured : null;
  }
  return (
    guild.channels.cache.find(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.name.trim().toLowerCase() === LOG_CHANNEL_NAME,
    ) ?? null
  );
}

/** Every moderation check, in the order they are shown. */
export const MODERATION_DIAGNOSTICS: readonly Diagnostic[] = [
  moderationSettingsDiagnostic,
  moderationDeliveryDiagnostic,
  moderationMuteRoleDiagnostic,
  moderationHistoryDiagnostic,
];
