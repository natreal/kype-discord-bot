/**
 * Service container.
 *
 * Dependency injection happens exactly once, in the bootstrap. Services and
 * event handlers receive this object; nothing imports module-level singletons,
 * which keeps the architecture testable and free of circular dependencies.
 */
import type { BotClient } from "../client/client.types.js";

import type { AppConfig } from "../config/config.js";
import type { Logger } from "./logger/index.js";
import type { DatabaseService } from "./database/index.js";
import type { ConfigService } from "./config/index.js";
import type { PermissionService } from "./permissions/index.js";
import type { SetupService } from "../modules/setup.service.js";
import type { CommandRegistry } from "../commands/command.registry.js";

export interface AppServices {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly client: BotClient;
  readonly database: DatabaseService;
  /** Guild-scoped configuration service (`config.get(guildId)`). */
  readonly guildConfig: ConfigService;
  readonly permissions: PermissionService;
  readonly setup: SetupService;
  readonly commands: CommandRegistry;
  /** Epoch milliseconds of process start, used for uptime reporting. */
  readonly startedAt: number;
}

/**
 * Container with lifecycle helpers.
 *
 * The container is immutable: services are added while it is being built and are
 * then read-only for the lifetime of the process.
 */
export class ServiceContainer {
  private services: AppServices | null = null;

  public set(services: AppServices): void {
    if (this.services) {
      throw new Error("Service container has already been initialised");
    }
    this.services = services;
  }

  public get(): AppServices {
    if (!this.services) {
      throw new Error("Service container has not been initialised yet");
    }
    return this.services;
  }

  public get isInitialised(): boolean {
    return this.services !== null;
  }

  /** Releases every resource in reverse dependency order. */
  public async shutdown(): Promise<void> {
    const services = this.services;
    if (!services) {
      return;
    }
    await services.database.disconnect();
    services.logger.info("Services shut down");
    this.services = null;
  }
}
