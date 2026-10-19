/**
 * Public surface of the V2 auto-setup module.
 *
 * Import from here rather than reaching into individual files: the internal split
 * (identity, permissions, Discord adapter, module) is an implementation detail
 * that will grow as more modules join the setup system.
 */
export {
  SETUP_RESOURCE_KEYS,
  SETUP_RESOURCES,
  SETUP_RESOURCE_PROBLEMS,
  SETUP_SECTION_KEYS,
  findSetupResource,
  provisionableResources,
  setupResourcesOfType,
  validateSetupResources,
  type SetupResourceKey,
} from "./setup-resources.js";

export {
  DEFAULT_RACE_WAIT_MS,
  SetupResourceService,
  type SetupResourceDiscordAdapter,
  type SetupResourceRepository,
  type SetupResourceServiceOptions,
  type StaleResource,
} from "./setup-resource.service.js";

export {
  SETUP_BOT_PERMISSIONS,
  SetupPermissionService,
  type PlannedOverwrite,
  type SetupPermissionServiceOptions,
} from "./setup-permission.service.js";

export {
  TrackedSetuper,
  FORBIDDEN_SETUP_PERMISSIONS,
  type TrackedSetuperOptions,
} from "./tracked-setuper.js";

export {
  GuildSetupDiscordAdapter,
  type GuildSetupDiscordAdapterOptions,
} from "./guild-setup-discord.adapter.js";

export type {
  SetupPermissionOverwrite,
  SetupPermissionTarget,
  SetupResourceDefinition,
  SetupResourceRecord,
  SetupResourceType,
  TrackedResolution,
} from "../setup.types.js";

export { PrismaSetupResourceRepository } from "./prisma-setup-resource.repository.js";

export {
  GOD_ACCESS_USER_ID,
  createSetupModule,
  filterGodAccounts,
  isGodAccess,
  type SetupModuleDependencies,
} from "./setup-module.js";

export {
  createGuildSetupModuleFactory,
  type GuildSetupModuleFactory,
  type SetupModuleFactoryOptions,
} from "./setup-module.factory.js";
