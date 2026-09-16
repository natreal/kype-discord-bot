/**
 * `guildCreate` — the bot joined a guild.
 *
 * Creates the guild record with default configuration and then runs the setup
 * orchestration, which is idempotent and permission-aware. Data is never deleted
 * when the bot leaves; retention is a policy decision left to the operator.
 */
import { defineEvent } from "./event.types.js";

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
