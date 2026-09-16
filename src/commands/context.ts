/**
 * Execution context handed to every command handler.
 *
 * Services are injected here so command files never import singletons, which
 * keeps them testable and prevents circular dependencies.
 */
import type { BotClient } from "../client/client.types.js";
import type { CommandRegistry } from "./command.registry.js";
import type { AppConfig } from "../config/config.js";
import type { ConfigService, GuildConfig } from "../services/config/index.js";
import type { DatabaseService } from "../services/database/index.js";
import type { Logger } from "../services/logger/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { SetupService } from "../modules/setup.service.js";

export interface CommandExecutionContext {
  /** Discord client, for read-only metadata access. */
  readonly client: BotClient;
  /** Registry of loaded commands (used by `/help`). */
  readonly commands: CommandRegistry;
  /** Validated application configuration (environment, feature flags). */
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  /** Guild-scoped configuration service. */
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly permissions: PermissionService;
  readonly setup: SetupService;
  /** Guild configuration. Only available for guild-only commands. */
  readonly guildConfig: GuildConfig | null;
  /** Milliseconds since the process started; used by `/ping`. */
  readonly uptimeMs: number;
}

/** Services required to build an execution context. */
export interface CommandContextServices {
  readonly client: BotClient;
  readonly commands: CommandRegistry;
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly permissions: PermissionService;
  readonly setup: SetupService;
}
