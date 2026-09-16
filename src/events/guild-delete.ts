/**
 * `guildDelete` — the bot was removed from a guild (or the guild became
 * unavailable).
 *
 * Guild data is intentionally NOT deleted. Retention, export and deletion are
 * future, explicit operations — silently dropping moderation/security history
 * would be a security and compliance problem.
 */
import { defineEvent } from "./event.types.js";

export default defineEvent({
  name: "guildDelete",
  execute: async (guild, { services }) => {
    const logger = services.logger.child("guildDelete");

    const record = await services.database.findGuild(guild.id);
    logger.info("Left guild (data retained)", {
      guildId: guild.id,
      name: guild.name,
      known: record !== null,
    });

    // Configuration is intentionally left untouched: retention policy belongs to
    // the operator, not to an implicit side effect of leaving.
  },
});
