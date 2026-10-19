/**
 * Command deployment from the shell.
 *
 * This script is now a *thin CLI over `CommandDeploymentService`* — the same
 * service the bot uses at startup and when it joins a server. That matters: two
 * implementations of "register the commands" would eventually disagree about
 * which commands exist or which scope they belong to, and the symptom would be a
 * server whose command list silently differs from everyone else's.
 *
 * Usage:
 *   npm run deploy:commands                        # deploy per COMMANDS_DEPLOY_SCOPE
 *   npm run deploy:commands -- --dry-run           # show what would be sent
 *   npm run deploy:commands -- --verbose           # include the raw payload
 *   npm run deploy:commands -- --global-only       # application-wide scope only
 *   npm run deploy:commands -- --guilds            # also publish to each guild
 *   npm run deploy:commands -- --clear-guild <id>  # clear one guild's commands
 *
 * Note on `--guilds`: guild-scoped commands appear in the client immediately,
 * while global commands fan out over up to an hour. Use `--guilds` (or set
 * `COMMANDS_DEPLOY_SCOPE=dev-guild`) when the wait is unacceptable — at the cost
 * of a `PUT` per guild instead of one request for the whole application.
 */

import type { RESTPutAPIApplicationCommandsJSONBody } from "discord.js";

import { createConfig } from "../src/config/config.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";
import { loadCommands } from "../src/commands/command.loader.js";
import { CommandRegistry } from "../src/commands/command.registry.js";
import {
  CommandDeploymentService,
  MemoryCommandDeploymentRepository,
  type DeployScope,
} from "../src/services/deployment/index.js";
import { modulesDirectory } from "../src/utils/fs.js";
import { AppError } from "../src/utils/errors.js";

interface CliOptions {
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly globalOnly: boolean;
  /** Publish to the guild scope in addition to (or instead of) the global one. */
  readonly guilds: boolean;
  readonly clearGuildId: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const clearIndex = argv.indexOf("--clear-guild");
  return {
    dryRun: argv.includes("--dry-run"),
    verbose: argv.includes("--verbose"),
    globalOnly: argv.includes("--global-only"),
    guilds: argv.includes("--guilds"),
    clearGuildId: clearIndex >= 0 ? (argv[clearIndex + 1] ?? null) : null,
  };
}

/** The logger type the script uses, taken from the factory to avoid re-importing. */
type ScriptLogger = ReturnType<typeof createLogger>;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // 1. Configuration + logger are created exactly like the runtime does it.
  const config = createConfig();
  const logger = createLogger("deploy", {
    level: options.verbose ? "debug" : "info",
    sinks: [new ConsoleSink({ color: false })],
  });

  // 2. Discover commands the same way the runtime does, into the same registry.
  const registry = new CommandRegistry();
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
  registry.registerAll(report.commands);

  // 3. Build the deployment service. The script runs *outside* the bot process, so
  //    it has no database and no guild cache: the in-memory repository makes every
  //    guild look like it needs a deployment, which is what an explicit script run
  //    should do, and keeps the CLI free of a database dependency.
  const deployment = new CommandDeploymentService({
    token: config.discord.token,
    clientId: config.discord.clientId,
    devGuildId: config.discord.devGuildId,
    registry,
    repository: new MemoryCommandDeploymentRepository(logger),
    logger,
  });

  logDiscovery(logger, report, deployment.globalBody(), options.verbose);

  const scope = resolveScope(options, config.discord.devGuildId, config.discord.deployScope);

  if (options.dryRun) {
    logger.info("Dry run: no commands were registered", { scope });
    return;
  }

  // 4. Guild-scoped cleanup, used when switching a deployment to global-only:
  //    Discord merges the two scopes, so leftover guild commands would otherwise
  //    shadow the global ones forever.
  if (options.clearGuildId) {
    const cleared = await deployment.clearGuildScope(options.clearGuildId);
    if (!cleared.ok) {
      throw new AppError(`Could not clear guild commands: ${cleared.reason ?? "unknown"}`, {
        code: "CLEAR_GUILD_FAILED",
      });
    }
    return;
  }

  // 5. Deploy. Startup credentials are the same ones the runtime uses, and the
  //    service reports rather than throws, so a partial failure is visible here
  //    instead of only in the bot's log.
  const result = await deployment.deploy([], scope, "script");

  if (result.global && !result.global.ok) {
    throw new AppError(`Global registration failed: ${result.global.reason ?? "unknown"}`, {
      code: "DEPLOY_GLOBAL_FAILED",
    });
  }

  if (scope === "dev-guild" && result.guilds.length > 0 && !result.guilds[0]?.ok) {
    throw new AppError(
      `Development guild registration failed: ${result.guilds[0]?.reason ?? "unknown"}`,
      { code: "DEPLOY_DEV_GUILD_FAILED" },
    );
  }

  logger.info("Deployment complete", {
    scope,
    commands: result.commands,
    guilds: result.guilds.length,
    failed: result.failed.length,
    durationMs: result.durationMs,
  });
}

/**
 * @returns the scope the CLI deploys to.
 *
 * `--global-only` and `--guilds` are explicit operator choices and win. When
 * neither is passed, the configured `COMMANDS_DEPLOY_SCOPE` decides, falling back
 * to the development guild and then to the application-wide scope.
 */
function resolveScope(
  options: CliOptions,
  devGuildId: string | undefined,
  configured: DeployScope,
): DeployScope {
  if (options.globalOnly) {
    return "global";
  }
  if (options.guilds) {
    return configured === "dev-guild" ? "dev-guild" : "global+guilds";
  }
  if (configured) {
    return configured;
  }
  return devGuildId ? "dev-guild" : "global";
}

/** Logs what was discovered and, in verbose mode, the payload itself. */
function logDiscovery(
  logger: ScriptLogger,
  report: Awaited<ReturnType<typeof loadCommands>>,
  body: RESTPutAPIApplicationCommandsJSONBody,
  verbose: boolean,
): void {
  logger.info(`Discovered ${report.commands.length} command(s)`, {
    slash: body.length,
    contextMenus: report.commands.length - body.length,
    skipped: report.skipped,
  });

  const withheld = report.commands.filter((command) => !command.deploy);
  if (withheld.length > 0) {
    logger.info("Commands withheld from deployment", {
      commands: withheld.map((command) => command.name),
    });
  }

  if (verbose) {
    logger.debug("Command payload", { commands: body.map((command) => command.name) });
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
