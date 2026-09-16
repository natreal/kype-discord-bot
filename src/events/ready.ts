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
 */
import { defineEvent } from "./event.types.js";
import type { AppServices } from "../services/container.js";

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

    logger.info("Startup complete");

    if (readyClient.guilds.cache.size === 0) {
      logger.warn("The bot is not in any guild yet; invite it to get started");
    }
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
