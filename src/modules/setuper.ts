/**
 * Idempotent setup helpers mounted on a guild.
 *
 * This file intentionally contains no feature logic: it only knows how to find
 * or create Discord resources safely. Feature modules decide *what* to create.
 */
import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
} from "discord.js";

import { DiscordApiError } from "../utils/errors.js";
import type { Logger } from "../services/logger/index.js";
import {
  type EnsureCategoryOptions,
  type EnsureRoleOptions,
  type EnsureTextChannelOptions,
  type ReuseResult,
  type Setuper,
} from "./setup.types.js";

export class DiscordSetuper implements Setuper {
  public readonly guild: Guild;
  private readonly logger: Logger;

  public constructor(guild: Guild, logger: Logger) {
    this.guild = guild;
    this.logger = logger.child(`setup:${guild.id}`);
  }

  /** Finds a role by name (case-insensitive), used before creating one. */
  public async findRoleByName(name: string): Promise<Role | null> {
    const normalized = name.trim().toLowerCase();
    const isMatch = (role: Role): boolean =>
      role.name.trim().toLowerCase() === normalized && !role.managed;

    const cached = this.guild.roles.cache.find(isMatch);
    if (cached) {
      return cached;
    }
    try {
      const roles = await this.guild.roles.fetch();
      return roles.find(isMatch) ?? null;
    } catch (error) {
      throw new DiscordApiError("Failed to list guild roles", {
        cause: error,
        code: "ROLES_FETCH_FAILED",
      });
    }
  }

  public async findRoleById(roleId: string): Promise<Role | null> {
    const cached = this.guild.roles.cache.get(roleId);
    if (cached) {
      return cached;
    }
    try {
      return await this.guild.roles.fetch(roleId);
    } catch {
      return null;
    }
  }

  public async findChannelById(channelId: string): Promise<CategoryChannel | TextChannel | null> {
    const cached = this.guild.channels.cache.get(channelId);
    if (cached) {
      return cached as CategoryChannel | TextChannel;
    }
    try {
      const channel = await this.guild.channels.fetch(channelId);
      if (!channel || channel.guildId !== this.guild.id) {
        return null;
      }
      return channel as CategoryChannel | TextChannel;
    } catch {
      return null;
    }
  }

  public async findTextChannelByName(
    name: string,
    parentId?: string | null,
  ): Promise<TextChannel | null> {
    const normalized = normalizeChannelName(name);
    const isMatch = (channel: TextChannel): boolean =>
      matchesNormalized(toNormalizedName(channel.name), normalized) &&
      (parentId === undefined || channel.parentId === parentId);

    const cached = this.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && isMatch(channel),
    );
    if (cached) {
      return cached as TextChannel;
    }

    try {
      const channels = await this.guild.channels.fetch();
      const found = channels.find(
        (channel) => channel?.type === ChannelType.GuildText && isMatch(channel),
      );
      return (found as TextChannel | undefined) ?? null;
    } catch (error) {
      throw new DiscordApiError("Failed to list guild channels", {
        cause: error,
        code: "CHANNELS_FETCH_FAILED",
      });
    }
  }

  public async findCategoryByName(name: string): Promise<CategoryChannel | null> {
    const normalized = normalizeChannelName(name);
    const isMatch = (channel: CategoryChannel): boolean =>
      toNormalizedName(channel.name) === normalized;

    const cached = this.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && isMatch(channel),
    );
    if (cached) {
      return cached as CategoryChannel;
    }

    try {
      const channels = await this.guild.channels.fetch();
      const found = channels.find(
        (channel) => channel?.type === ChannelType.GuildCategory && isMatch(channel),
      );
      return (found as CategoryChannel | undefined) ?? null;
    } catch (error) {
      throw new DiscordApiError("Failed to list guild categories", {
        cause: error,
        code: "CHANNELS_FETCH_FAILED",
      });
    }
  }

  public async ensureRole(options: EnsureRoleOptions): Promise<ReuseResult<Role>> {
    const existing = await this.findRoleByName(options.name);
    if (existing) {
      this.logger.debug("Reusing existing role", { roleId: existing.id, name: existing.name });
      return { resource: existing, created: false };
    }

    try {
      const role = await this.guild.roles.create({
        name: options.name,
        ...(options.color === undefined ? {} : { color: options.color }),
        ...(options.hoist === undefined ? {} : { hoist: options.hoist }),
        ...(options.mentionable === undefined ? {} : { mentionable: options.mentionable }),
        ...(options.permissions === undefined ? {} : { permissions: [...options.permissions] }),
        reason: options.reason ?? DEFAULT_REASON,
      });
      this.logger.info("Created role", { roleId: role.id, name: role.name });
      return { resource: role, created: true };
    } catch (error) {
      throw new DiscordApiError(`Failed to create role ${options.name}`, {
        cause: error,
        code: "ROLE_CREATE_FAILED",
      });
    }
  }

  public async ensureCategory(
    options: EnsureCategoryOptions,
  ): Promise<ReuseResult<CategoryChannel>> {
    const existing = await this.findCategoryByName(options.name);
    if (existing) {
      return { resource: existing, created: false };
    }

    try {
      const category = await this.guild.channels.create({
        name: options.name,
        type: ChannelType.GuildCategory,
        reason: options.reason ?? DEFAULT_REASON,
      });
      this.logger.info("Created category", { channelId: category.id, name: category.name });
      return { resource: category, created: true };
    } catch (error) {
      throw new DiscordApiError(`Failed to create category ${options.name}`, {
        cause: error,
        code: "CATEGORY_CREATE_FAILED",
      });
    }
  }

  public async ensureTextChannel(
    options: EnsureTextChannelOptions,
  ): Promise<ReuseResult<TextChannel>> {
    const existing = await this.findTextChannelByName(options.name, options.parentId);
    if (existing) {
      this.logger.debug("Reusing existing channel", {
        channelId: existing.id,
        name: existing.name,
      });
      return { resource: existing, created: false };
    }

    try {
      const channel = await this.guild.channels.create({
        name: options.name,
        type: ChannelType.GuildText,
        ...(options.parentId === undefined || options.parentId === null
          ? {}
          : { parent: options.parentId }),
        ...(options.topic === undefined ? {} : { topic: options.topic }),
        reason: options.reason ?? DEFAULT_REASON,
      });
      this.logger.info("Created text channel", { channelId: channel.id, name: channel.name });
      return { resource: channel, created: true };
    } catch (error) {
      throw new DiscordApiError(`Failed to create text channel ${options.name}`, {
        cause: error,
        code: "CHANNEL_CREATE_FAILED",
      });
    }
  }
}

const DEFAULT_REASON = "Automatic server setup";

/** Discord lowercases and dashes channel names; normalize before comparing. */
function normalizeChannelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Accepts both `logs-archive` and `logsarchive` spellings as the same channel. */
function matchesNormalized(left: string, right: string): boolean {
  return left === right || left.replace(/-/g, "") === right.replace(/-/g, "");
}

function toNormalizedName(name: string): string {
  return normalizeChannelName(name);
}
