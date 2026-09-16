/**
 * `guildCreate` — the bot joined a guild.
 *
 * Creates the guild record with default configuration and then runs the setup
 * orchestration, which is idempotent and permission-aware. Data is never deleted
 * when the bot leaves; retention is a policy decision left to the operator.
 */
import type { Guild } from "discord.js";

import { defineEvent } from "./event.types.js";
import type { AppServices } from "../services/container.js";

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
