/**
 * `guildCreate` — the bot joined a guild.
 *
 * Creates the guild record with default configuration and then runs the setup
 * orchestration, which is idempotent and permission-aware. Data is never deleted
 * when the bot leaves; retention is a policy decision left to the operator.
 *
 * This is also where a newly joined server can get its slash commands. Under the
 * `global+guilds` scope it receives an instant guild-scoped copy, so a server that
 * just installed the bot sees its commands immediately instead of waiting up to an
 * hour for the global scope to propagate. Deployment here is best-effort: the
 * startup path verifies every guild and repairs whatever is missing, so a failure
 * now is corrected on the next boot rather than lost.
 */
import type { Guild } from "discord.js";

import { defineEvent } from "./event.types.js";
import type { AppServices } from "../services/container.js";
import type { DeployScope } from "../services/deployment/index.js";

export default defineEvent({
  name: "guildCreate",
  execute: async (guild, { services }) => {
    const logger = services.logger.child("guildCreate");
    logger.info("Joined guild", {
      guildId: guild.id,
      name: guild.name,
      members: guild.memberCount,
    });

    await services.database.upsertGuild({ id: guild.id, name: guild.name });
    await services.guildConfig.ensureGuild(guild.id, guild.name);

    // Commands first: everything below this line is slower and more likely to
    // need fixing, and a server with no commands looks broken from the outside.
    await deployToNewGuild(guild, services, logger);

    // The permission check runs before setup: otherwise the operator only sees
    // channels silently fail to appear and has no idea why.
    reportPermissionState(guild, services);

    const report = await services.setup.run(guild, "all");

    logger.info("Automatic setup finished for new guild", {
      guildId: guild.id,
      status: report.status,
      created: report.created,
      reused: report.reused,
      failed: report.failed,
    });
  },
});

/**
 * Publishes the command payload into a guild that just joined.
 *
 * This honours the configured scope, because writing into the wrong scope is how a
 * server ends up missing every command. See {@link shouldDeployGuildCommandsOnJoin}
 * for the per-scope decision.
 *
 * @returns nothing: the result is logged and audited rather than thrown, because
 * a guild that could not be deployed to must still get the rest of the join
 * handling (configuration, setup) and must not be left half-processed.
 */
async function deployToNewGuild(
  guild: Guild,
  services: AppServices,
  logger: AppServices["logger"],
): Promise<void> {
  const config = services.config.discord;

  if (!config.autoDeployCommands) {
    logger.debug("Automatic command deployment is disabled; the guild is not deployed to", {
      guildId: guild.id,
    });
    return;
  }

  if (!shouldDeployGuildCommandsOnJoin(config.deployScope)) {
    logger.info("New guild is served by the configured scope, not a guild-specific copy", {
      guildId: guild.id,
      name: guild.name,
      scope: config.deployScope,
      reason:
        config.deployScope === "dev-guild"
          ? "Commands are registered in the development guild only."
          : "The global registration reaches every server; writing a guild copy would be cleared on the next boot.",
    });
    return;
  }

  const result = await services.deployment.deployToGuild(
    { id: guild.id, name: guild.name },
    "guildCreate",
  );

  await services.audit.record({
    guildId: guild.id,
    action: "commands.deploy",
    category: "config",
    severity: "info",
    actorId: null,
    actorKind: "system",
    targetType: "guild",
    targetId: guild.id,
    outcome: result.ok ? "success" : "failure",
    details: {
      trigger: "guildCreate",
      commands: result.commands,
      skipped: result.skipped,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    },
  });

  if (result.ok) {
    logger.info("Commands registered for the new guild", {
      guildId: guild.id,
      count: result.commands,
      skipped: result.skipped,
    });
    return;
  }

  logger.warn("Could not register commands for the new guild", {
    guildId: guild.id,
    reason: result.reason,
    recovery: "The next startup verifies every guild and repairs this one automatically.",
  });
}

/**
 * Decides whether a newly joined guild should receive an immediate guild-scoped
 * command deployment.
 *
 * This single boolean is the difference between a server that works as soon as the
 * bot is added and one that silently loses its commands on the next restart:
 *
 * - `global+guilds` — **true**. The global registration *and* an instant guild-scoped
 *   copy, so a server that just installed the bot works immediately.
 * - `global` — **false**. The global registration (refreshed on every boot by
 *   `ready`) is the single source of truth, and the guild scope is *supposed* to be
 *   empty. A guild-scoped copy here would look right — commands appear instantly —
 *   and then vanish on the next boot, when `reconcileGlobalScope` clears the copy and
 *   the server is left waiting on the (up to an hour) global propagation.
 * - `dev-guild` — **false**. Only the development guild ever receives commands; an
 *   innocent new server must not be sent a dev payload.
 */
export function shouldDeployGuildCommandsOnJoin(scope: DeployScope): boolean {
  return scope === "global+guilds";
}

/** Logs the bot's permission state and warns about anything critical missing. */
function reportPermissionState(guild: Guild, services: AppServices): void {
  const logger = services.logger.child("guildCreate");
  const me = services.permissions.botMember(guild);

  if (!me) {
    logger.warn("Could not resolve the bot member; skipping the permission check", {
      guildId: guild.id,
    });
    return;
  }

  if (services.permissions.isAdministrator(me)) {
    logger.warn("Bot holds Administrator in this guild", {
      guildId: guild.id,
      advice:
        "Granular permissions are safer; anti-nuke only needs ViewAuditLog plus management and moderation rights.",
    });
    return;
  }

  const missing = services.permissions.missingCriticalPermissions(me);
  if (missing.length > 0) {
    logger.warn("Bot is missing critical permissions; some features will not work", {
      guildId: guild.id,
      missing: missing.map(String),
      fix: "Re-invite the bot with the recommended profile (see /admin permissions).",
    });
  }
}
