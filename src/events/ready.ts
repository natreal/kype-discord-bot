/**
 * `clientReady` — fired once when the gateway connection is established.
 *
 * discord.js v14 still emits this as `ready`, but that name is deprecated (and
 * will be removed in v15) because it collides with the gateway READY payload.
 * `clientReady` is the forward-compatible name.
 *
 * Reports startup success and reconciles the database with the guilds the bot is
 * currently in, so guilds that were joined while the bot was offline are not
 * missing from the database.
 *
 * When automatic deployment is enabled it is also where commands are published:
 * the bot that just came online is the only point that knows both the command
 * payload it is running and the servers it is serving, which is exactly what a
 * deployment needs.
 */
import { defineEvent } from "./event.types.js";
import type { AppServices } from "../services/container.js";
import type { DeployableGuild } from "../services/deployment/index.js";

export default defineEvent({
  name: "clientReady",
  once: true,
  execute: async (readyClient, { services }) => {
    const { logger } = services;

    // The ready payload carries the authenticated client, which is the only place
    // the bot's own user and guild list are guaranteed to be populated.
    logger.info("Discord client ready", {
      user: readyClient.user.tag,
      userId: readyClient.user.id,
      guilds: readyClient.guilds.cache.size,
      commands: readyClient.commands.size,
    });

    // `ready` is where the database connection is opened: login succeeding does
    // not imply the database is reachable, so a failure here is fatal and must
    // stop the bot rather than let it run half-configured.
    await services.database.connect();
    await reconcileGuilds(services);

    // The scheduler is started here, and not earlier, because it queries the
    // database on every tick: starting it before `connect()` would produce a burst
    // of connection errors for work that is not actually late. It is *not* awaited
    // on the first tick — a tick can take as long as the work it dispatches, and a
    // slow Discord API must not hold up a bot that is otherwise ready to serve.
    void startScheduler(services);

    logger.info("Startup complete");

    if (readyClient.guilds.cache.size === 0) {
      logger.warn("The bot is not in any guild yet; invite it to get started");
    }

    // Deployment is started here and deliberately *not* awaited: a slow or failing
    // Discord API must not hold up a bot that is otherwise ready to serve, and
    // every failure is logged where an operator will see it.
    void deployCommands(services);
  },
});

/** Ensures every guild the bot can see exists in the database. */
async function reconcileGuilds(services: AppServices): Promise<void> {
  for (const guild of services.client.guilds.cache.values()) {
    const existing = await services.database.findGuild(guild.id);
    await services.guildConfig.ensureGuild(guild.id, guild.name);
    if (!existing) {
      services.logger.info("Registered previously unseen guild", {
        guildId: guild.id,
        name: guild.name,
      });
    }
  }
}

/**
 * Starts the scheduler and makes sure every guild has its recurring work.
 *
 * Two jobs, in this order:
 *
 * 1. **Recover** what a restart left behind. A temp role whose deadline passed while
 *    the bot was down has no task left to fire (the task row may have been abandoned
 *    after exhausting its attempts), so recovery runs before the first tick rather
 *    than relying on it.
 * 2. **Schedule** the per-guild recurring sweeper. `ensureScheduled` is keyed on the
 *    guild, so calling it on every boot reuses the existing task instead of stacking
 *    a second one.
 *
 * Failures are logged and swallowed: the bot is already serving, and a scheduler
 * that could not start should not take a healthy process down with it.
 */
async function startScheduler(services: AppServices): Promise<void> {
  const logger = services.logger.child("scheduler");
  try {
    for (const guild of services.client.guilds.cache.values()) {
      try {
        await services.moderationSweeper.ensureScheduled(guild.id);
      } catch (error) {
        logger.error("Could not schedule the punishment sweep", error, {
          guildId: guild.id,
        });
      }
    }

    // Recovery before the tick: a resumed task only helps grants whose deadline is
    // still ahead. One that already passed needs lifting now, and `recoverExpired`
    // is what makes a restart alone sufficient to repair the drift.
    for (const guild of services.client.guilds.cache.values()) {
      const roles = services.rolesForGuild(guild.id);
      if (!roles) {
        continue;
      }
      try {
        await roles.recoverExpired();
      } catch (error) {
        logger.error("Could not recover expired role grants", error, {
          guildId: guild.id,
        });
      }
    }

    await services.scheduler.start();
  } catch (error) {
    logger.error("The scheduler could not be started", error, {
      impact: "Deferred work (temporary roles, punishment sweeps) will not run.",
    });
  }
}

/**
 * Publishes the command payload according to the configured deployment scope.
 *
 * This is the whole feature in one function: with `COMMANDS_AUTO_DEPLOY=true`,
 * every server the bot is in receives its commands at startup, and every server
 * that is behind is reported by name. Verification runs afterwards because a
 * successful API call is not the same as "the server has the commands" — a manual
 * deletion in server settings or a rolled-back change would otherwise go
 * unnoticed forever.
 */
export async function deployCommands(services: AppServices): Promise<void> {
  const logger = services.logger.child("command-deploy");
  const { deployment } = services;
  const config = services.config.discord;

  if (!config.autoDeployCommands) {
    logger.info("Automatic command deployment is disabled", {
      hint: "Set COMMANDS_AUTO_DEPLOY=true to register commands on every server, or run `npm run deploy:commands`.",
    });
    return;
  }

  const guilds: DeployableGuild[] = services.client.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
  }));

  logger.info("Deploying commands", {
    scope: config.deployScope,
    guilds: guilds.length,
    commands: deployment.globalBody().length,
  });

  const report = await deployment.deploy(guilds, config.deployScope, "startup");

  if (report.global && !report.global.ok) {
    logger.error("Global command registration failed", undefined, {
      reason: report.global.reason,
      impact:
        "Servers not covered by a guild deployment may be missing commands until this succeeds.",
    });
  }

  // Scope-aware on purpose: under `global` this verifies the global registration
  // instead of each guild's empty scope, so a healthy deployment is not mistaken
  // for a broken one and "repaired" back into every guild.
  const repaired = await deployment.verifyAndRepair(guilds, config.deployScope);
  if (repaired.incomplete.length > 0) {
    logger.warn("Some servers are still missing commands after deployment", {
      incomplete: repaired.incomplete,
      advice: "Run `npm run deploy:commands` or check the bot's permissions.",
    });
  }

  // A global deployment requires an empty guild scope. Without this, a guild that
  // still holds commands from an earlier `global+guilds` deployment keeps listing
  // every command twice, and nothing in the deploy path would ever notice.
  if (config.deployScope === "global") {
    const reconciled = await deployment.reconcileGlobalScope(guilds);
    if (reconciled.failed.length > 0) {
      logger.warn("Could not clear guild-scoped commands in some servers", {
        failed: reconciled.failed,
        impact: "Those servers will list each command twice until this succeeds.",
        advice: "Run `npm run deploy:clear-guilds` and check the bot's permissions.",
      });
    }
  }

  logger.info("Command deployment finished", {
    scope: config.deployScope,
    global: report.global?.ok ?? null,
    commands: report.commands,
    deployed: report.deployed,
    skipped: report.skipped,
    failed: report.failed.length,
    repaired: repaired.repaired,
    durationMs: report.durationMs,
  });
}
