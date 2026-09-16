/**
 * Setup dry run and execution.
 *
 * Reports what the setup system would create in a guild, optionally running it.
 * This is the operator-facing entry point until `/setup` ships, and it exercises
 * `SetupService.plan()` / `run()` against a real guild.
 *
 * Usage:
 *   npx tsx scripts/setup.ts plan              # dry run (no Discord writes)
 *   npx tsx scripts/setup.ts run               # actually run setup
 *   npx tsx scripts/setup.ts run --section logging
 */
import { createConfig } from "../src/config/config.js";
import { DiscordClientFactory } from "../src/client/discord-client.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";
import { DatabaseService } from "../src/services/database/index.js";
import { ConfigService } from "../src/services/config/index.js";
import { PermissionService } from "../src/services/permissions/index.js";
import { SetupService } from "../src/modules/setup.service.js";
import { DiscordSetuper } from "../src/modules/setuper.js";
import { botModules } from "../src/modules/registry.js";
import { formatError } from "../src/utils/serialization.js";
import type { SetupScope } from "../src/modules/setup.service.js";

const mode = process.argv[2] === "run" ? "run" : "plan";
const sectionIndex = process.argv.indexOf("--section");
const scope = (sectionIndex >= 0 ? process.argv[sectionIndex + 1] : "all") as SetupScope;

const config = createConfig();
const logger = createLogger("setup-script", {
  level: "info",
  sinks: [new ConsoleSink({ color: false })],
});

const client = new DiscordClientFactory(logger, { features: [] }).create();
const database = new DatabaseService(config, logger);
const guildConfig = new ConfigService(database, logger);
const setup = new SetupService({
  database,
  config: guildConfig,
  permissions: new PermissionService(),
  logger,
  modules: botModules,
  createSetuper: (guild, moduleLogger) => new DiscordSetuper(guild, moduleLogger),
});

try {
  await client.login(config.discord.token);

  const guildId = config.discord.devGuildId;
  if (!guildId) {
    throw new Error("DISCORD_DEV_GUILD_ID must be set to run this script");
  }

  const guild = await client.guilds.fetch(guildId);
  logger.info("Target guild resolved", { guildId: guild.id, name: guild.name });

  if (mode === "plan") {
    const actions = await setup.plan(guild, scope);
    process.stdout.write(
      `\nPlanned actions (${actions.length}) — nothing was written to Discord:\n`,
    );
    for (const action of actions) {
      process.stdout.write(`  - ${action.key}: ${action.description}\n`);
    }
    process.stdout.write("\nRun with `run` to apply them.\n");
  } else {
    const report = await setup.run(guild, scope);
    process.stdout.write(`\nSetup ${report.status.toUpperCase()} in ${report.durationMs}ms\n`);
    for (const entry of report.results) {
      const detail = entry.resourceId ? ` -> ${entry.resourceId}` : "";
      process.stdout.write(`  [${entry.status}] ${entry.key}${detail}\n`);
    }
    process.stdout.write(
      `\ncreated=${report.created} reused=${report.reused} skipped=${report.skipped} failed=${report.failed}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`\nSetup script failed\n${formatError(error)}\n`);
  process.exitCode = 1;
} finally {
  if (client.isReady()) {
    client.destroy();
  }
  await database.disconnect();
}
