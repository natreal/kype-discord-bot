/**
 * Bridges `SetupResourceService` to a real Discord guild.
 *
 * The service is deliberately unaware of discord.js; this adapter is the only
 * piece that knows how to find and create resources. It receives callbacks rather
 * than a setuper instance so the resource service and the setuper can be wired
 * without a construction cycle, and so tests can substitute a fake guild.
 *
 * `findChannelByName` is scoped to text channels inside the expected parent
 * category, which is the only adoption case V2 needs; categories are resolved
 * through their own `category`-less definitions.
 */
import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
} from "discord.js";

import type { SetupResourceDefinition } from "../setup.types.js";
import type { SetupResourceDiscordAdapter } from "./setup-resource.service.js";

export interface GuildSetupDiscordAdapterOptions {
  readonly guild: Guild;
  readonly findChannelById: (channelId: string) => Promise<CategoryChannel | TextChannel | null>;
  readonly findChannelByName: (
    name: string,
    parentId: string | null,
  ) => Promise<CategoryChannel | TextChannel | null>;
  readonly createChannel: (
    definition: SetupResourceDefinition,
    parentId: string | null,
  ) => Promise<CategoryChannel | TextChannel>;
  readonly findRoleById: (roleId: string) => Promise<Role | null>;
  readonly findRoleByName: (name: string) => Promise<Role | null>;
  readonly createRole: (definition: SetupResourceDefinition) => Promise<Role>;
}

export class GuildSetupDiscordAdapter implements SetupResourceDiscordAdapter {
  private readonly guild: Guild;
  private readonly operations: GuildSetupDiscordAdapterOptions;

  public constructor(options: GuildSetupDiscordAdapterOptions) {
    this.guild = options.guild;
    this.operations = options;
  }

  public findChannelById(channelId: string): Promise<CategoryChannel | TextChannel | null> {
    return this.operations.findChannelById(channelId);
  }

  /**
   * Finds a channel by its expected name inside the expected parent.
   *
   * Used only when no usable identity is stored, so that a guild which already has
   * `#welcome` never receives a second one. Name matching is exact (Discord
   * lowercases and dashes channel names on creation) and never crosses categories,
   * so `#logs` cannot be adopted as the `#logs` of another section.
   */
  public async findChannelByName(
    name: string,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel | null> {
    const normalized = name.trim().toLowerCase();
    const matches = (channel: CategoryChannel | TextChannel): boolean =>
      channel.name.trim().toLowerCase() === normalized &&
      (parentId === null ? channel.parentId === null : channel.parentId === parentId);

    const cached = this.guild.channels.cache.find(
      (channel): channel is CategoryChannel | TextChannel =>
        isRelevantChannel(channel) && matches(channel),
    );
    if (cached) {
      return cached;
    }

    try {
      const channels = await this.guild.channels.fetch();
      return (
        [...channels.values()].find(
          (channel): channel is CategoryChannel | TextChannel =>
            channel !== null && isRelevantChannel(channel) && matches(channel),
        ) ?? null
      );
    } catch {
      // A failed lookup means "nothing adoptable"; creation is the safe fallback
      // and Discord will reject it if the permission is genuinely missing.
      return null;
    }
  }

  public createChannel(
    definition: SetupResourceDefinition,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel> {
    return this.operations.createChannel(definition, parentId);
  }

  public findRoleById(roleId: string): Promise<Role | null> {
    return this.operations.findRoleById(roleId);
  }

  public findRoleByName(name: string): Promise<Role | null> {
    return this.operations.findRoleByName(name);
  }

  public createRole(definition: SetupResourceDefinition): Promise<Role> {
    return this.operations.createRole(definition);
  }
}

/** Only categories and text channels are managed by V2. */
function isRelevantChannel(
  channel: { type: ChannelType } | null,
): channel is CategoryChannel | TextChannel {
  return (
    channel !== null &&
    (channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildText)
  );
}
