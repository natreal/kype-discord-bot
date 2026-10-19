/**
 * Deployment diagnostics.
 *
 * Every check here answers a question that used to require reading the bot's log
 * and guessing: *does this server actually have the commands?* A deployment that
 * "succeeded" from the bot's point of view, while the server shows an empty command
 * list, is exactly the failure this feature exists to make visible.
 *
 * The checks are read-only and never deploy: `/diagnostics` reports, it does not
 * change state. Repairing is `/admin deploy` or the next startup.
 */
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";
import type { CommandDeploymentService } from "../../services/deployment/index.js";

/** Automatic deployment mode: is the bot registering commands by itself? */
export const deploymentModeDiagnostic: Diagnostic = {
  id: "deployment.mode",
  category: "core",
  label: "Command deployment",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const deployment = deploymentOf(context);
    if (!deployment) {
      return Promise.resolve({
        id: "deployment.mode",
        category: "core",
        label: "Command deployment",
        status: "warn",
        detail: "The deployment service is not wired up in this process.",
        remediation: "Report this: the command deployment service should always be available.",
      });
    }

    return Promise.resolve({
      id: "deployment.mode",
      category: "core",
      label: "Command deployment",
      status: "pass",
      detail: `${context.commands.size} command(s) loaded and ready to deploy (scope: ${deployment.scope}).`,
      metrics: { commands: context.commands.size },
    });
  },
};

/**
 * Whether this guild holds the commands the bot is running.
 *
 * A real read of the guild's live command scope, not a stored flag: a command
 * removed by hand in server settings, or a deployment that failed while something
 * else reported success, is only visible by asking Discord.
 */
export const guildDeploymentDiagnostic: Diagnostic = {
  id: "deployment.guild",
  category: "core",
  label: "This server's commands",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return {
        id: "deployment.guild",
        category: "core",
        label: "This server's commands",
        status: "pass",
        detail: "Not running in a server; nothing to verify.",
      };
    }

    const deployment = deploymentOf(context);
    if (!deployment) {
      return {
        id: "deployment.guild",
        category: "core",
        label: "This server's commands",
        status: "warn",
        detail: "The deployment service is not wired up in this process.",
        remediation: "Report this: the command deployment service should always be available.",
      };
    }

    const expected = deployment.globalBody().length;
    // The service knows which scope it deploys to, and the scope decides which scope
    // is authoritative: under `global` this server's own guild scope is empty by
    // design, so checking it would report every command as missing on a healthy bot.
    const verification =
      deployment.scope === "global"
        ? await deployment.verifyGlobal()
        : await deployment.verifyGuild(guild.id);

    if (verification.failed.length > 0) {
      return {
        id: "deployment.guild",
        category: "core",
        label: "This server's commands",
        status: "fail",
        detail: `Discord could not be queried: ${verification.failed.join(", ")}`,
        remediation: "Check the bot's network access and token, then run `/admin deploy`.",
        metrics: { expected },
      };
    }

    if (verification.missing.length > 0) {
      return {
        id: "deployment.guild",
        category: "core",
        label: "This server's commands",
        status: "fail",
        detail: `${verification.missing.length} command(s) missing here: ${verification.missing.join(", ")}`,
        remediation: "Run `/admin deploy` to register them immediately.",
        metrics: { expected, missing: verification.missing.length },
      };
    }

    return {
      id: "deployment.guild",
      category: "core",
      label: "This server's commands",
      status: "pass",
      detail: `All ${expected} command(s) are registered here.`,
      metrics: { commands: expected },
    };
  },
};

/** Known guilds that are behind the payload the bot is running. */
export const guildCoverageDiagnostic: Diagnostic = {
  id: "deployment.coverage",
  category: "core",
  label: "Server command coverage",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const deployment = deploymentOf(context);
    if (!deployment) {
      return {
        id: "deployment.coverage",
        category: "core",
        label: "Server command coverage",
        status: "warn",
        detail: "The deployment service is not wired up in this process.",
      };
    }

    const guilds = knownGuilds(context);
    if (guilds.length === 0) {
      return {
        id: "deployment.coverage",
        category: "core",
        label: "Server command coverage",
        status: "pass",
        detail: "The bot is not in any server, so there is nothing to deploy to.",
        metrics: { guilds: 0 },
      };
    }

    const behind = await deployment.guildsMissingCommands(guilds);
    if (behind.length === 0) {
      return {
        id: "deployment.coverage",
        category: "core",
        label: "Server command coverage",
        status: "pass",
        detail: `All ${guilds.length} server(s) hold the current commands.`,
        metrics: { guilds: guilds.length, behind: 0 },
      };
    }

    return {
      id: "deployment.coverage",
      category: "core",
      label: "Server command coverage",
      status: "warn",
      detail: `${behind.length} of ${guilds.length} server(s) are behind: ${behind
        .slice(0, 5)
        .map((guild) => guild.name)
        .join(", ")}${behind.length > 5 ? ", ..." : ""}`,
      remediation: "They are redeployed on the next startup, or immediately with `/admin deploy`.",
      metrics: { guilds: guilds.length, behind: behind.length },
    };
  },
};

/** Every deployment diagnostic, in the order they should run. */
export const DEPLOYMENT_DIAGNOSTICS: readonly Diagnostic[] = [
  deploymentModeDiagnostic,
  guildDeploymentDiagnostic,
  guildCoverageDiagnostic,
];

/**
 * @returns the deployment service from the context, or `null` when none is wired.
 */
function deploymentOf(context: DiagnosticContext): CommandDeploymentService | null {
  return context.deployment ?? null;
}

/**
 * @returns every guild the client can see, as a plain array.
 *
 * discord.js exposes a `Collection` (a `Map` subclass), so iterating it yields
 * `[key, value]` pairs. The entries are read explicitly rather than assuming
 * `.values()`, because a diagnostic is a health check: it must still produce a
 * report against a partially-stubbed client instead of throwing and taking the
 * whole `/diagnostics` output down with it.
 */
function knownGuilds(context: DiagnosticContext): { id: string; name: string }[] {
  const cache = context.client?.guilds?.cache as
    Iterable<readonly [string, { id?: unknown; name?: unknown }]> | undefined;

  if (!cache || typeof (cache as Iterable<unknown>)[Symbol.iterator] !== "function") {
    return [];
  }

  const guilds: { id: string; name: string }[] = [];
  for (const entry of cache) {
    const value = Array.isArray(entry) ? entry[1] : (entry as { id?: unknown; name?: unknown });
    if (typeof value?.id !== "string") {
      continue;
    }
    guilds.push({
      id: value.id,
      name: typeof value.name === "string" ? value.name : value.id,
    });
  }
  return guilds;
}
