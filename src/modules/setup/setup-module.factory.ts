/**
 * Factory that binds the V2 setup module to one guild.
 *
 * This is the seam that makes the setup system extensible: `SetupService` receives
 * a list of `BotModule`s, and the command creates the setup module with the guild,
 * database and resolver it owns. Future modules (logging, moderation, security,
 * tickets, AI) plug in by adding their own module to the same list — the
 * orchestration code itself never changes.
 *
 * Construction order note: the resource service needs a Discord adapter, and the
 * adapter needs the setuper that owns the resource service. The cycle is broken by
 * handing the adapter a *channel factory callback* rather than the setuper itself,
 * so no half-initialised object is ever reachable.
 */
import type { CategoryChannel, Guild, TextChannel } from "discord.js";

import type { BotModule } from "../module.types.js";
import type { Logger } from "../../services/logger/index.js";
import type { DatabaseService } from "../../services/database/index.js";
import { ValidationError } from "../../utils/errors.js";
import type { SetupResourceDefinition } from "../setup.types.js";
import { GuildSetupDiscordAdapter } from "./guild-setup-discord.adapter.js";
import { PrismaSetupResourceRepository } from "./prisma-setup-resource.repository.js";
import { SetupPermissionService } from "./setup-permission.service.js";
import { SetupResourceService } from "./setup-resource.service.js";
import { createSetupModule, type SetupModuleDependencies } from "./setup-module.js";
import { TrackedSetuper } from "./tracked-setuper.js";

export interface SetupModuleFactoryOptions {
  readonly database: DatabaseService;
  readonly logger: Logger;
}

/** Builds the setup module for the guild it is given. */
export type GuildSetupModuleFactory = (guild: Guild, logger: Logger) => BotModule;

/**
 * Creates a factory that builds the setup module for a guild.
 *
 * @returns a function suitable for the per-guild module list used by `/setup`.
 */
export function createGuildSetupModuleFactory(
  options: SetupModuleFactoryOptions,
): GuildSetupModuleFactory {
  const permissions = new SetupPermissionService({ logger: options.logger });

  return (guild: Guild, logger: Logger): BotModule => {
    const repository = new PrismaSetupResourceRepository(options.database.prisma, guild.name);
    const scope = logger.child(`setup:${guild.id}`);

    const dispatcher: {
      setuper?: TrackedSetuper;
    } = {};

    /**
     * @returns the initialised setuper, or `null` when construction is incomplete.
     *
     * Returning `null` (rather than throwing) is correct for *lookups*: a missing
     * adapter means "nothing found yet", and the resource service then creates.
     */
    const currentSetuper = (): TrackedSetuper | null => dispatcher.setuper ?? null;

    const discord = new GuildSetupDiscordAdapter({
      guild,
      findChannelById: (channelId) =>
        currentSetuper()?.findChannelById(channelId) ?? Promise.resolve(null),
      findChannelByName: (name, parentId) =>
        currentSetuper()?.findTextChannelByName(name, parentId) ?? Promise.resolve(null),
      createChannel: (definition, parentId): Promise<CategoryChannel | TextChannel> => {
        const setuper = currentSetuper();
        if (!setuper) {
          throw new ValidationError("Setup setuper was not initialised before channel creation");
        }
        return setuper.createFromDefinition(definition, parentId);
      },
      findRoleById: (roleId) => currentSetuper()?.findRoleById(roleId) ?? Promise.resolve(null),
      findRoleByName: (name) => currentSetuper()?.findRoleByName(name) ?? Promise.resolve(null),
      createRole: (definition: SetupResourceDefinition) => {
        const setuper = currentSetuper();
        if (!setuper) {
          throw new ValidationError("Setup setuper was not initialised before role creation");
        }
        return setuper.createRoleFromDefinition(definition);
      },
    });

    const resources = new SetupResourceService({ guild, repository, discord, logger: scope });
    const setuper = new TrackedSetuper({ guild, logger: scope, resources, permissions });
    dispatcher.setuper = setuper;

    const dependencies: SetupModuleDependencies = {
      setuperFor: () => setuper,
      resourcesFor: () => resources,
      permissions,
      botMember: (target) => target.members.me ?? null,
    };

    return createSetupModule(dependencies);
  };
}
