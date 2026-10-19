/**
 * discord.js implementation of `GuildBackupActions`.
 *
 * `read()` is the capture half and performs no writes at all: a snapshot taken
 * while a raid is in progress must not be able to make the raid worse. `create*` /
 * `update*` are the restore half, and each returns whether it actually changed
 * anything, so a restore can report "0 updated" rather than pretending to have
 * worked.
 *
 * Roles are the delicate part. Discord orders roles by their position, and a create
 * followed by a position update is *two* API calls; they are done in that order
 * because a role created at the bottom and immediately moved is stable, while a
 * role created directly at a position races with every other role.
 */
import {
  ChannelType,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type Role,
  type TextChannel,
} from "discord.js";

import type { GuildBackupActions } from "./backup.service.js";
import type { BackupChannel, BackupOverwrite, BackupRole } from "./backup.types.js";

/** The channel types Discord accepts when creating a guild channel. */
type CreatableChannelType =
  | ChannelType.GuildText
  | ChannelType.GuildVoice
  | ChannelType.GuildCategory
  | ChannelType.GuildAnnouncement
  | ChannelType.GuildStageVoice
  | ChannelType.GuildForum;

/**
 * Channel types a snapshot captures and a restore recreates.
 *
 * Typed as `CreatableChannelType` rather than `ChannelType`, so the capture filter
 * and the restore's `channels.create` agree by construction: a type a snapshot can
 * hold is exactly a type Discord can create.
 */
const BACKUP_CHANNEL_TYPES: readonly CreatableChannelType[] = [
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildStageVoice,
];

/** A snapshotted channel, narrowed to the types the module captures. */
type BackupableChannel = GuildBasedChannel & {
  readonly name: string;
  readonly rawPosition: number;
  readonly parentId: string | null;
  readonly permissionOverwrites: {
    readonly cache: Map<
      string,
      { type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }
    >;
    edit(
      target: unknown,
      options: { allow: PermissionsBitField; deny: PermissionsBitField },
      meta?: { reason?: string },
    ): Promise<unknown>;
  };
};

export class DiscordBackupActions implements GuildBackupActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public read(): Promise<{
    readonly roles: readonly BackupRole[];
    readonly channels: readonly BackupChannel[];
  }> {
    const roles = [...this.guild.roles.cache.values()]
      .sort((left, right) => left.position - right.position)
      .map(describeRole);
    const channels = [...this.guild.channels.cache.values()]
      .filter((channel) => (BACKUP_CHANNEL_TYPES as readonly number[]).includes(channel.type))
      .sort((left, right) => channelPosition(left) - channelPosition(right))
      .map((channel) => describeChannel(channel));
    return Promise.resolve({ roles, channels });
  }

  public roleIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.guild.roles.cache.keys()]);
  }

  public roleIdByName(name: string): Promise<string | null> {
    const normalized = name.trim().toLowerCase();
    const role = this.guild.roles.cache.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalized,
    );
    return Promise.resolve(role?.id ?? null);
  }

  public channelIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.guild.channels.cache.keys()]);
  }

  public async createRole(role: BackupRole): Promise<string | null> {
    try {
      const created = await this.guild.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: new PermissionsBitField(BigInt(role.permissions)),
        reason: "Backup restore",
      });
      // A position restore is attempted separately: Discord may refuse it when the
      // role would move above the bot's own, and a role restored at the bottom is
      // still better than no role at all.
      await this.guild.roles
        .setPosition(created.id, role.position, { reason: "Backup restore" })
        .catch(() => undefined);
      return created.id;
    } catch {
      return null;
    }
  }

  public async updateRole(roleId: string, role: BackupRole): Promise<boolean> {
    const existing = this.guild.roles.cache.get(roleId);
    if (!existing) {
      return false;
    }
    const drifted =
      existing.name !== role.name ||
      existing.color !== role.color ||
      existing.hoist !== role.hoist ||
      existing.mentionable !== role.mentionable ||
      existing.permissions.bitfield.toString() !== role.permissions;
    if (!drifted) {
      return false;
    }
    try {
      await existing.edit({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: new PermissionsBitField(BigInt(role.permissions)),
        reason: "Backup restore",
      });
      return true;
    } catch {
      return false;
    }
  }

  public async createChannel(
    channel: BackupChannel,
    parentId: string | null,
  ): Promise<string | null> {
    try {
      const created = await this.guild.channels.create({
        name: channel.name,
        type: toCreatableChannelType(channel.type),
        ...(parentId === null ? {} : { parent: parentId }),
        // `topic` is spread conditionally rather than passed as `undefined`: the
        // project enables `exactOptionalPropertyTypes`, and a voice channel has no
        // topic at all. The comparison is against the enum's *value*, since the
        // snapshot stores a plain number.
        ...(isTextualChannelType(channel.type)
          ? { nsfw: channel.nsfw, ...(channel.topic === null ? {} : { topic: channel.topic }) }
          : {}),
        reason: "Backup restore",
      });
      await this.applyOverwrites(created.id, channel.overwrites);
      return created.id;
    } catch {
      return null;
    }
  }

  public async updateChannel(channelId: string, channel: BackupChannel): Promise<boolean> {
    const existing = this.guild.channels.cache.get(channelId);
    if (!existing) {
      return false;
    }
    try {
      if (existing.name !== channel.name) {
        await existing.setName(channel.name, "Backup restore");
      }
      // Only a text-like channel has a topic; the check is on the *live* channel so
      // a restorable type mismatch is skipped instead of throwing.
      if (existing.isTextBased() && "setTopic" in existing) {
        const text = existing as TextChannel;
        if (text.topic !== channel.topic) {
          await text.setTopic(channel.topic ?? null, "Backup restore");
        }
      }
      await this.applyOverwrites(channelId, channel.overwrites);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Applies a channel's overwrites.
   *
   * A failed overwrite is skipped rather than aborting the channel: a permission
   * the bot cannot set (because another role outranks it there) must not lose the
   * channel name and topic that *were* restored.
   */
  private async applyOverwrites(
    channelId: string,
    overwrites: readonly BackupOverwrite[],
  ): Promise<void> {
    const channel = this.guild.channels.cache.get(channelId);
    if (!channel || overwrites.length === 0 || !("permissionOverwrites" in channel)) {
      return;
    }
    const manageable = channel as BackupableChannel;
    for (const overwrite of overwrites) {
      const target =
        overwrite.kind === "role"
          ? this.guild.roles.cache.get(overwrite.id)
          : this.guild.members.cache.get(overwrite.id);
      if (!target) {
        continue;
      }
      try {
        await manageable.permissionOverwrites.edit(
          target,
          {
            allow: new PermissionsBitField(BigInt(overwrite.allow)),
            deny: new PermissionsBitField(BigInt(overwrite.deny)),
          },
          { reason: "Backup restore" },
        );
      } catch {
        // Skipped deliberately; the restore report already counts what changed.
      }
    }
  }
}

/** Captures everything a restore needs about a role. */
function describeRole(role: Role): BackupRole {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
    managed: role.managed,
  };
}

/** Captures everything a restore needs about a channel. */
function describeChannel(channel: GuildBasedChannel): BackupChannel {
  const manageable = channel as BackupableChannel;
  const overwrites: BackupOverwrite[] = [];
  for (const [id, overwrite] of manageable.permissionOverwrites.cache) {
    overwrites.push({
      id,
      // `type` is `0` for a role and `1` for a member in Discord's model; the
      // discriminator is stored explicitly so a restore does not have to guess from
      // an ID it may no longer be able to resolve.
      kind: overwrite.type === 0 ? "role" : "member",
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    });
  }

  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: manageable.parentId ?? null,
    position: channelPosition(channel),
    topic: channel.isTextBased() && "topic" in channel ? (channel.topic ?? null) : null,
    nsfw: "nsfw" in channel && typeof channel.nsfw === "boolean" ? channel.nsfw : false,
    overwrites,
  };
}

/**
 * @returns true when a snapshotted channel type supports a topic.
 *
 * The comparison is against `ChannelType`'s *values* through a `number`, because a
 * snapshot stores a plain number: JSON has no enum. The narrowing is therefore
 * explicit rather than implicit, and reading the values from the enum keeps the two
 * from drifting.
 */
const TEXTUAL_CHANNEL_TYPES: readonly number[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
];

/** @returns true when a snapshotted channel type supports a topic. */
function isTextualChannelType(type: number): boolean {
  return TEXTUAL_CHANNEL_TYPES.includes(type);
}

/**
 * @returns the creation-time channel type for a snapshotted one.
 *
 * A snapshot stores a plain number (JSON has no enum), so this is the one place the
 * number becomes a `ChannelType` again. The comparison is numeric — `ChannelType`'s
 * members *are* numbers, and comparing a stored number with one through the enum's
 * own values is what keeps the fallback honest. An unrecognised value becomes a text
 * channel rather than throwing mid-restore: recreating a channel with the wrong type
 * is recoverable, aborting the restore is not.
 */
function toCreatableChannelType(type: number): CreatableChannelType {
  const match = CREATABLE_CHANNEL_TYPE_VALUES.get(type);
  return match ?? ChannelType.GuildText;
}

/** The creatable channel types, indexed by their numeric value. */
const CREATABLE_CHANNEL_TYPE_VALUES: ReadonlyMap<number, CreatableChannelType> = new Map(
  BACKUP_CHANNEL_TYPES.map((candidate) => [candidate, candidate]),
);

/** @returns a channel's raw position, or `0` for a type that does not expose one. */
function channelPosition(channel: GuildBasedChannel): number {
  return "rawPosition" in channel && typeof channel.rawPosition === "number"
    ? channel.rawPosition
    : 0;
}
