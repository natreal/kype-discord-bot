/**
 * Automod and security diagnostics (V5).
 *
 * Four checks, all read-only, each answering a question that is otherwise invisible
 * until a raid happens:
 *
 * | Check                 | Reports                                                      |
 * | --------------------- | ------------------------------------------------------------ |
 * | `automod.intent`      | Automod on but `MessageContent` off: a silently inert module |
 * | `automod.rules`       | No rule active, or an escalation ladder that punishes nobody |
 * | `security.settings`   | Anti-raid/anti-nuke off, or anti-nuke that only logs         |
 * | `security.resources`  | Missing `#bot-security` or `Quarantined` role                |
 *
 * The first one is the reason this file exists. Discord requires a *privileged
 * intent* for message content, and a bot that has automod enabled without it reads
 * every message as empty: no error, no log, no rule ever fires. That failure mode
 * is indistinguishable from "nobody is misbehaving", which is why it is a
 * diagnostic rather than a footnote in the README.
 */
import { ChannelType, type Guild } from "discord.js";

import type {
  Diagnostic,
  DiagnosticCategory,
  DiagnosticContext,
  DiagnosticResult,
} from "../diagnostic.types.js";
import { AUTOMOD_RULES, automodRuleDefinition } from "../../modules/automod/index.js";

/** The channel name the security module creates for its alerts. */
const SECURITY_CHANNEL_NAME = "bot-security";

/** The role name the security module creates for raid containment. */
const QUARANTINE_ROLE_NAME = "quarantined";

/** Whether automod can actually read messages in this deployment. */
export const automodIntentDiagnostic: Diagnostic = {
  id: "automod.intent",
  category: "moderation",
  label: "Automod message access",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return failed("automod.intent", "moderation", "Automod can only be checked inside a server.");
    }

    const config = await context.config.get(guild.id, guild.name);
    if (!config.automod.enabled) {
      return {
        id: "automod.intent",
        category: "moderation",
        label: "Automod message access",
        status: "pass",
        detail: "Automod is disabled, so message access is not required.",
      };
    }

    // The intent is a *client* fact, not a guild fact: if the bot was not
    // constructed with it, no configuration can make automod work.
    if (!context.hasMessageContentIntent) {
      return {
        id: "automod.intent",
        category: "moderation",
        label: "Automod message access",
        status: "fail",
        detail:
          "Automod is enabled but the bot has no `MessageContent` intent: it receives every message as empty and no rule can ever fire.",
        remediation:
          "Add `messageContent` to `ENABLED_INTENT_FEATURES`, then enable Message Content in the Discord developer portal (Bot → Privileged Gateway Intents).",
      };
    }

    return {
      id: "automod.intent",
      category: "moderation",
      label: "Automod message access",
      status: "pass",
      detail: "Message content is readable, so automod rules can fire.",
    };
  },
};

/** Whether any rule is active and the ladder actually escalates. */
export const automodRulesDiagnostic: Diagnostic = {
  id: "automod.rules",
  category: "moderation",
  label: "Automod rules",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return failed(
        "automod.rules",
        "moderation",
        "Automod rules can only be checked inside a server.",
      );
    }

    const config = await context.config.get(guild.id, guild.name);
    const automod = config.automod;
    if (!automod.enabled) {
      return {
        id: "automod.rules",
        category: "moderation",
        label: "Automod rules",
        status: "pass",
        detail: "Automod is disabled.",
      };
    }

    const active = AUTOMOD_RULES.filter(
      (rule) => automod.rules[automodRuleDefinition(rule)!.setting],
    );
    const notes: string[] = [];
    if (active.length === 0) {
      notes.push("no rule is enabled");
    }
    if (automod.escalation.length === 0) {
      notes.push("the escalation ladder is empty, so nothing is ever punished");
    }
    if (!automod.warnOnFirstTrigger && automod.escalation.every((step) => step.triggers > 1)) {
      notes.push("the first trigger is neither recorded nor punished");
    }

    return {
      id: "automod.rules",
      category: "moderation",
      label: "Automod rules",
      status: notes.length === 0 ? "pass" : "warn",
      detail:
        notes.length === 0
          ? `${active.length} rule(s) active, escalation ladder has ${automod.escalation.length} step(s).`
          : `Automod is enabled but ${notes.join("; ")}.`,
      ...(notes.length === 0
        ? {}
        : { remediation: "Review `/automod status` and `/settings view area:automod`." }),
      metrics: { activeRules: active.length, ladderSteps: automod.escalation.length },
    };
  },
};

/** @returns a failed result with the given identity filled in. */
function failed(id: string, category: DiagnosticCategory, detail: string): DiagnosticResult {
  return { id, category, label: id, status: "fail", detail };
}

/** @returns true when a guild has a text channel with the given name. */
function hasTextChannel(guild: Guild, name: string): boolean {
  return [...guild.channels.cache.values()].some(
    (channel) =>
      channel.type === ChannelType.GuildText && channel.name.trim().toLowerCase() === name,
  );
}

export { hasTextChannel, SECURITY_CHANNEL_NAME, QUARANTINE_ROLE_NAME };

/** Whether the security settings are coherent. */
export const securitySettingsDiagnostic: Diagnostic = {
  id: "security.settings",
  category: "security",
  label: "Security settings",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return failed(
        "security.settings",
        "security",
        "Security settings can only be checked inside a server.",
      );
    }

    const config = await context.config.get(guild.id, guild.name);
    const security = config.security;
    if (!security.enabled) {
      return {
        id: "security.settings",
        category: "security",
        label: "Security settings",
        status: "warn",
        detail: "The security module is disabled: no raid and no nuke is detected.",
        remediation:
          "Run `/settings set area:security setting:security-enabled value:true` to enable it.",
      };
    }

    const notes: string[] = [];
    if (!security.antiRaid.enabled && !security.antiNuke.enabled) {
      notes.push("both anti-raid and anti-nuke are off");
    }
    if (security.lockdown) {
      notes.push("a lockdown is configured as the expected state");
    }
    if (security.antiNuke.enabled && !security.antiNuke.stripPermissions) {
      // Reported because it is the difference between "we stopped it" and "we wrote
      // it down": the V5 brief requires the nuke to be stopped in flight.
      notes.push("anti-nuke only logs, it does not remove the account's permissions");
    }
    if (security.antiRaid.enabled && security.antiRaid.minAccountAgeDays === 0) {
      notes.push("account age is not considered, so a veteran burst looks like a raid");
    }

    return {
      id: "security.settings",
      category: "security",
      label: "Security settings",
      status: notes.length === 0 ? "pass" : "warn",
      detail:
        notes.length === 0
          ? `Anti-raid (${security.antiRaid.burstThreshold} join(s)/${security.antiRaid.windowSeconds}s) and anti-nuke (weight ${security.antiNuke.actionThreshold}/${security.antiNuke.windowSeconds}s) are configured.`
          : `Enabled, but ${notes.join("; ")}.`,
      ...(notes.length === 0
        ? {}
        : { remediation: "Review `/security status` and `/settings view area:security`." }),
    };
  },
};

/** Whether the security module's Discord resources exist. */
export const securityResourcesDiagnostic: Diagnostic = {
  id: "security.resources",
  category: "security",
  label: "Security resources",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return failed(
        "security.resources",
        "security",
        "Security resources can only be checked inside a server.",
      );
    }

    const config = await context.config.get(guild.id, guild.name);
    if (!config.security.enabled) {
      return {
        id: "security.resources",
        category: "security",
        label: "Security resources",
        status: "pass",
        detail: "The security module is disabled, so its resources are not required.",
      };
    }

    const channelId = config.logging.securityChannelId;
    const channelPresent =
      channelId === null
        ? hasTextChannel(guild, SECURITY_CHANNEL_NAME)
        : guild.channels.cache.has(channelId);
    const rolePresent = guild.roles.cache.some(
      (role) => role.name.trim().toLowerCase() === QUARANTINE_ROLE_NAME,
    );

    const notes: string[] = [];
    if (!channelPresent) {
      notes.push("no `#bot-security` channel, so alerts only reach the console");
    }
    if (!rolePresent) {
      notes.push("no `Quarantined` role, so raid containment is skipped");
    }

    return {
      id: "security.resources",
      category: "security",
      label: "Security resources",
      status: notes.length === 0 ? "pass" : "warn",
      detail:
        notes.length === 0
          ? "Security channel and quarantine role are present."
          : `Security is enabled but ${notes.join("; ")}.`,
      ...(notes.length === 0
        ? {}
        : { remediation: "Run `/setup run` to create the missing resources." }),
    };
  },
};

/** Every V5 diagnostic, in the order `/diagnostics` shows them. */
export const AUTOMOD_DIAGNOSTICS: readonly Diagnostic[] = [
  automodIntentDiagnostic,
  automodRulesDiagnostic,
];

export const SECURITY_DIAGNOSTICS: readonly Diagnostic[] = [
  securitySettingsDiagnostic,
  securityResourcesDiagnostic,
];
