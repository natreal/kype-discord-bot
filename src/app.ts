/**
 * Application bootstrap.
 *
 * This file wires the foundation together and manages the process lifecycle:
 *
 *   1. load environment variables
 *   2. validate configuration with Zod
 *   3. initialise the logger
 *   4. create services (client, database, config, permissions, setup)
 *   5. discover and register commands
 *   6. discover and register events
 *   7. connect to Discord
 *   8. report successful startup
 *   9. handle startup failures
 *  10. handle SIGINT / SIGTERM and shut down gracefully
 *
 * `index.ts` only calls `main()`. All composition lives here.
 */
import { createConfig, redactConfig } from "./config/config.js";
import { DiscordClientFactory } from "./client/discord-client.js";
import type { BotClient } from "./client/client.types.js";
import type { IntentFeature } from "./client/intents.js";
import { CommandRegistry } from "./commands/command.registry.js";
import { loadAndRegisterCommands } from "./commands/command.loader.js";
import { registerEvents } from "./events/event.loader.js";
import { ConfigService } from "./services/config/index.js";
import { ServiceContainer } from "./services/container.js";
import { DatabaseService } from "./services/database/index.js";
import { PermissionService } from "./services/permissions/index.js";
import { createLogger, type Logger } from "./services/logger/index.js";
import { ConsoleSink } from "./services/logger/sinks.js";
import { botModules } from "./modules/registry.js";
import { SetupService } from "./modules/setup.service.js";
import { DiscordSetuper } from "./modules/setuper.js";
import { modulesDirectory } from "./utils/fs.js";
import { formatError } from "./utils/serialization.js";

/**
 * Intents enabled by default in V1.
 *
 * Enable additional features here (never by editing the client factory) as
 * modules ship — see `src/client/intents.ts` for the available features.
 */
export const ENABLED_INTENT_FEATURES: readonly IntentFeature[] = [];

export interface Application {
  readonly container: ServiceContainer;
  readonly client: BotClient;
  readonly logger: Logger;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

/** Builds all services and returns the application handle. */
export function createApplication(): Promise<Application> {
  const startedAt = Date.now();
  const config = createConfig();

  const logger = createLogger("app", {
    level: config.logging.level,
    sinks: [new ConsoleSink({ color: config.isDevelopment })],
  });

  logger.info("Application starting", { environment: config.environment, node: process.version });
  logger.debug("Configuration loaded", redactConfig(config));

  const client = new DiscordClientFactory(logger, {
    features: ENABLED_INTENT_FEATURES,
    debug: config.isDevelopment && config.logging.level === "debug",
  }).create();

  const registry = new CommandRegistry();
  const database = new DatabaseService(config, logger);
  const guildConfig = new ConfigService(database, logger);
  const permissions = new PermissionService();
  const setup = new SetupService({
    database,
    config: guildConfig,
    permissions,
    logger,
    modules: botModules,
    createSetuper: (guild, moduleLogger) => new DiscordSetuper(guild, moduleLogger),
  });

  const container = new ServiceContainer();
  const services = {
    config,
    logger,
    client,
    database,
    guildConfig,
    permissions,
    setup,
    commands: registry,
    startedAt,
  };
  container.set(services);

  const stop = (reason: string): Promise<void> => {
    logger.info("Shutting down", { reason });
    return shutdownResources({ client, container, logger });
  };

  const application: Application = {
    container,
    client,
    logger,
    stop,
    start: async () => {
      const commandReport = await loadAndRegisterCommands(registry, {
        directory: modulesDirectory("commands"),
        logger,
      });
      logger.info(`Loaded ${commandReport.commands.length} command(s)`, {
        skipped: commandReport.skipped.length,
      });

      const eventReport = await registerEvents(client, {
        directory: modulesDirectory("events"),
        logger,
        services,
      });
      logger.info(`Loaded ${eventReport.events.length} event(s)`);

      // `ready` opens the database connection; login failures are fatal.
      await client.login(config.discord.token);
      logger.info("Discord login request accepted");
    },
  };

  return Promise.resolve(application);
}

/**
 * Releases Discord and database resources.
 *
 * Extracted so it can be reused by signal handling and startup-failure paths
 * without capturing a method reference.
 */
async function shutdownResources(resources: {
  client: BotClient;
  container: ServiceContainer;
  logger: Logger;
}): Promise<void> {
  const { client, container, logger } = resources;
  try {
    if (client.isReady()) {
      await client.destroy();
    }
    await container.shutdown();
    logger.info("Shutdown complete");
  } catch (error) {
    logger.error("Error during shutdown", error);
    process.exitCode = 1;
  }
}
/** Entry point used by `src/index.ts` and by tests. */
export async function main(): Promise<void> {
  let application: Application;

  try {
    application = await createApplication();
  } catch (error) {
    // Configuration failures must be loud, actionable and secret-free.
    process.stderr.write(`[FATAL] Startup failed\n${formatError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const logger: Logger = application.logger;
  const shutdown = (reason: string): Promise<void> => {
    return application.stop(reason);
  };

  let stopping = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn("Second signal received; forcing exit", { signal });
      process.exit(1);
    }
    stopping = true;
    void shutdown(signal).then(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    handleSignal("SIGTERM");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    void shutdown("uncaughtException").then(() => {
      process.exit(1);
    });
  });

  try {
    await application.start();
  } catch (error) {
    logger.error("Failed to start the application", error);
    await shutdown("startupFailure");
    process.exitCode = 1;
  }
}
