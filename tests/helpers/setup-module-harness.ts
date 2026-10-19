/**
 * Full-stack setup harness.
 *
 * Wires the real `SetupService`, the real V2 setup module, the real identity
 * service and the real permission service, replacing only Discord and the
 * database. This is what makes the flow tests meaningful: they exercise the same
 * code path `/setup` uses, not a simplified stand-in.
 */
import type { Guild, GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";

import { SetupService } from "../../src/modules/setup.service.js";
import { ConfigService } from "../../src/services/config/config.service.js";
import { PermissionService } from "../../src/services/permissions/index.js";
import type { DatabaseService } from "../../src/services/database/index.js";
import { createSetupModule } from "../../src/modules/setup/setup-module.js";
import { SETUP_RESOURCES } from "../../src/modules/setup/setup-resources.js";
import { SetupPermissionService } from "../../src/modules/setup/setup-permission.service.js";
import { SetupResourceService } from "../../src/modules/setup/setup-resource.service.js";
import { TrackedSetuper } from "../../src/modules/setup/tracked-setuper.js";
import type { BotModule } from "../../src/modules/module.types.js";
import { memoryDatabaseStub, type MemoryDatabaseStub } from "./database.js";
import { fakeDiscord, setupGuildStub, type FakeDiscord } from "./fake-guild.js";
import { memoryResourceRepository, type MemoryResourceRepository } from "./setup-resources.js";
import { memberStub } from "./discord.js";
import { testLogger } from "./logger.js";

export const GUILD_ID = "111111111111111111";

/**
 * Permissions a correctly installed bot holds — the `recommended` profile.
 *
 * Defaulting to this (rather than to nothing) keeps the flow tests focused on the
 * setup pipeline; the tests that care about a *mis-installed* bot pass an explicit
 * narrower set instead.
 */
export const INSTALLED_BOT_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

export interface SetupModuleHarness {
  readonly service: SetupService;
  readonly guild: Guild;
  readonly discord: FakeDiscord;
  readonly database: MemoryDatabaseStub;
  readonly resources: SetupResourceService;
  /** In-memory identity store, for seeding drift. */
  readonly repository: MemoryResourceRepository;
  /** Builds a caller with the given Discord permissions. */
  readonly member: (permissions?: readonly bigint[]) => GuildMember;
}

export function getGuildSetupHarness(
  botPermissions: readonly bigint[] = INSTALLED_BOT_PERMISSIONS,
): SetupModuleHarness {
  const database = memoryDatabaseStub();
  const discord = fakeDiscord();
  const guild = setupGuildStub(
    GUILD_ID,
    botPermissions,
    discord.channelCache,
    discord.roleCache,
    discord,
  );
  const permissions = new PermissionService();
  const setupPermissions = new SetupPermissionService({ logger: testLogger });
  const repository = memoryResourceRepository();
  const config = new ConfigService({
    database: database as unknown as DatabaseService,
    logger: testLogger,
    repository: database.configRepository,
  });

  const resources = new SetupResourceService({
    guild,
    repository,
    discord,
    logger: testLogger,
  });

  const setuper = new TrackedSetuper({
    guild,
    logger: testLogger,
    resources,
    permissions: setupPermissions,
  });

  const module: BotModule = createSetupModule({
    setuperFor: () => setuper,
    resourcesFor: () => resources,
    permissions: setupPermissions,
    botMember: (target) => target.members.me ?? null,
  });

  const service = new SetupService({
    database: database as unknown as DatabaseService,
    config,
    permissions,
    logger: testLogger,
    // Only the automatic setup module is registered: `/setup` orchestrates the
    // setup module plus every feature module, and the V1 feature modules are
    // covered by their own tests against their own fixtures. Including them here
    // would test the fake guild's breadth rather than the setup pipeline.
    modules: [],
    resolveModules: () => [module],
    resourceDefinitions: SETUP_RESOURCES,
    createSetuper: () => setuper,
    repairResourcesFor: () => resources,
  });

  return {
    service,
    guild,
    discord,
    database,
    resources,
    repository,
    member: (granted: readonly bigint[] = []) => memberStub({ permissions: granted }),
  };
}
