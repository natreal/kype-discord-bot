/**
 * Shared test harness for the setup service.
 *
 * Lives in its own module so both setup test files can use it without
 * duplicating the wiring.
 */
import type { Guild } from "discord.js";

import { SetupService } from "../../src/modules/setup.service.js";
import { ConfigService } from "../../src/services/config/config.service.js";
import { PermissionService } from "../../src/services/permissions/index.js";
import { coreModule } from "../../src/modules/core/core.module.js";
import { loggingModule } from "../../src/modules/logging/logging.module.js";
import { securityModule } from "../../src/modules/security/security.module.js";
import type { BotModule } from "../../src/modules/module.types.js";
import { memoryDatabaseStub, type MemoryDatabaseStub } from "./database.js";
import { fakeSetuper, type FakeSetuperHarness } from "./setuper.js";
import { testLogger } from "./logger.js";
import type { DatabaseService } from "../../src/services/database/index.js";

export const SETUP_GUILD_ID = "111111111111111111";

export const setupGuild = { id: SETUP_GUILD_ID, name: "Guild" } as Guild;

export interface SetupHarness {
  readonly service: SetupService;
  readonly database: MemoryDatabaseStub;
  readonly discord: FakeSetuperHarness;
}

/** Builds a setup service wired to in-memory stubs (no Discord, no PostgreSQL). */
export function createSetupHarness(
  modules: readonly BotModule[] = [coreModule, loggingModule, securityModule],
): SetupHarness {
  const database = memoryDatabaseStub();
  const config = new ConfigService({
    database: database as unknown as DatabaseService,
    logger: testLogger,
    repository: database.configRepository,
  });
  const discord = fakeSetuper(SETUP_GUILD_ID);

  const service = new SetupService({
    database: database as unknown as DatabaseService,
    config,
    permissions: new PermissionService(),
    logger: testLogger,
    modules,
    createSetuper: () => discord.setuper,
  });

  return { service, database, discord };
}
