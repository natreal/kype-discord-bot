/**
 * `ready` — fired once when the gateway connection is established.
 *
 * Reports startup success and reconciles the database with the guilds the bot is
 * currently in, so guilds that were joined while the bot was offline are not
 * missing from the database.
 */
import { defineEvent } from "./event.types.js";
import type { AppServices } from "../services/container.js";

export default defineEvent({
  name: "ready",
  once: true,
  execute: async (_readyClient, { services }) => {
    const { logger, client } = services;

    logger.info("Discord client ready", {
      user: client.user?.tag ?? "unknown",
      userId: client.user?.id ?? "unknown",
      guilds: client.guilds.cache.size,
      commands: client.commands.size,
    });

    await services.database.connect();
    await reconcileGuilds(services);

    logger.info("Startup complete");

    if (client.guilds.cache.size === 0) {
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
