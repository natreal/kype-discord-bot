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
 *   npx tsx scripts/setup.ts deploy            # register commands in the dev guild
 *   npx tsx scripts/setup.ts deploy --missing  # only guilds that are behind
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
import { SETUP_RESOURCES, createGuildSetupModuleFactory } from "../src/modules/setup/index.js";
import { CommandRegistry } from "../src/commands/command.registry.js";
import { loadAndRegisterCommands } from "../src/commands/command.loader.js";
import {
  CommandDeploymentService,
  PrismaCommandDeploymentRepository,
} from "../src/services/deployment/index.js";
import { modulesDirectory } from "../src/utils/fs.js";
import { formatError } from "../src/utils/serialization.js";
import type { SetupScope } from "../src/modules/setup.service.js";

const mode = process.argv[2] === "run" ? "run" : process.argv[2] === "deploy" ? "deploy" : "plan";
const missingOnly = process.argv.includes("--missing");
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

// The V2 setup module is built per guild, exactly as the bootstrap does it, so this
// script exercises the same pipeline `/setup` uses instead of a reduced one.
const setupModuleFactory = createGuildSetupModuleFactory({ database, logger });

const setup = new SetupService({
  database,
  config: guildConfig,
  permissions: new PermissionService(),
  logger,
  modules: botModules,
  resolveModules: (guild, moduleLogger) => [setupModuleFactory(guild, moduleLogger)],
  resourceDefinitions: SETUP_RESOURCES,
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

  if (mode === "deploy") {
    // Deployment needs a registry, which means discovering the commands the same
    // way the runtime does rather than importing a hardcoded list.
    const registry = new CommandRegistry();
    await loadAndRegisterCommands(registry, {
      directory: modulesDirectory("commands"),
      logger,
    });

    const deployment = new CommandDeploymentService({
      token: config.discord.token,
      clientId: config.discord.clientId,
      devGuildId: config.discord.devGuildId,
      scope: config.discord.deployScope,
      registry,
      repository: new PrismaCommandDeploymentRepository(database),
      logger,
    });

    const guilds = client.guilds.cache.map((entry) => ({ id: entry.id, name: entry.name }));
    const targets = missingOnly ? await deployment.guildsMissingCommands(guilds) : guilds;

    process.stdout.write(
      `\nDeploying ${deployment.globalBody().length} command(s) to ${targets.length} of ${guilds.length} guild(s)\n`,
    );

    const report = await deployment.deploy(targets, config.discord.deployScope, "script");
    process.stdout.write(
      `global=${report.global?.ok ?? "skipped"} deployed=${report.deployed} skipped=${report.skipped} failed=${report.failed.length} in ${report.durationMs}ms\n`,
    );

    for (const failure of report.failed) {
      process.stdout.write(
        `  failed: ${failure.guildName} (${failure.guildId}) — ${failure.reason}\n`,
      );
    }

    const verification = await deployment.verifyAndRepair(targets, config.discord.deployScope);
    process.stdout.write(`verified: repaired=${verification.repaired}\n`);
    for (const incomplete of verification.incomplete) {
      process.stdout.write(`  still incomplete: ${incomplete}\n`);
    }
  } else if (mode === "plan") {
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
