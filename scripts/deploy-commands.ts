/**
 * Command deployment.
 *
 * Kept deliberately separate from the bot runtime: slash commands are registered
 * on demand (`npm run deploy:commands`), never on every startup. That avoids
 * unnecessary API calls, avoids global rate limits and gives operators a dry-run
 * mode.
 *
 * Usage:
 *   npm run deploy:commands            # register with Discord
 *   npm run deploy:commands -- --dry-run --verbose
 *   npm run deploy:commands -- --clear-guild <guildId>
 */

import { REST, Routes, type RESTPutAPIApplicationCommandsJSONBody } from "discord.js";

import { createConfig } from "../src/config/config.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";
import { loadCommands } from "../src/commands/command.loader.js";
import { modulesDirectory } from "../src/utils/fs.js";
import { AppError } from "../src/utils/errors.js";

interface CliOptions {
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly clearGuildId: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const clearIndex = argv.indexOf("--clear-guild");
  return {
    dryRun: argv.includes("--dry-run"),
    verbose: argv.includes("--verbose"),
    clearGuildId: clearIndex >= 0 ? (argv[clearIndex + 1] ?? null) : null,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // 1. Configuration + logger are created exactly like the runtime does it.
  const config = createConfig();
  const logger = createLogger("deploy", {
    level: options.verbose ? "debug" : "info",
    sinks: [new ConsoleSink({ color: false })],
  });

  // 2. Discover commands the same way the runtime does.
  const report = await loadCommands({
    directory: modulesDirectory("commands"),
    logger,
  });

  if (report.failures.length > 0) {
    for (const failure of report.failures) {
      logger.error(`Failed to load ${failure.moduleId}`, failure.error);
    }
    throw new AppError("Command discovery failed", { code: "COMMAND_DISCOVERY_FAILED" });
  }

  const body = report.commands
    .filter((command) => command.kind === "slash")
    .map((command) => command.data.toJSON()) as RESTPutAPIApplicationCommandsJSONBody;

  logger.info(`Discovered ${report.commands.length} command(s)`, {
    slash: body.length,
    contextMenus: report.commands.length - body.length,
    skipped: report.skipped,
  });

  if (options.verbose) {
    logger.debug("Command payload", { commands: body.map((command) => command.name) });
  }

  const rest = new REST({ version: "10" }).setToken(config.discord.token);

  // 3. Optional guild-scoped cleanup (useful when switching to global commands).
  if (options.clearGuildId) {
    if (options.dryRun) {
      logger.info("Would clear guild commands", { guildId: options.clearGuildId });
      return;
    }
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, options.clearGuildId), {
      body: [],
    });
    logger.info("Cleared guild commands", { guildId: options.clearGuildId });
    return;
  }

  if (options.dryRun) {
    logger.info("Dry run: no commands were registered");
    return;
  }

  // 4. Register. Guild scope in development gives instant updates; global scope
  //    is the production path.
  const devGuildId = config.discord.devGuildId;
  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, devGuildId), {
      body,
    });
    logger.info("Registered commands in development guild", {
      guildId: devGuildId,
      count: body.length,
    });
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
    logger.info("Registered global commands", { count: body.length });
  }
}

try {
  await main();
} catch (error) {
  const logger = createLogger("deploy", {
    level: "info",
    sinks: [new ConsoleSink({ color: false })],
  });
  logger.error("Command deployment failed", error);
  // Exit code 1 so CI and npm report the failure.
  process.exitCode = 1;
}

export { main, parseArgs, type CliOptions };
