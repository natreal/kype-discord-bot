/**
 * discord.js implementation of `GuildSecurityActions`.
 *
 * Lockdown is implemented with per-channel permission overwrites on `@everyone`
 * rather than by removing the `Send Messages` permission from the role itself. Two
 * reasons, both learned the hard way by every bot that does it the other way:
 *
 * 1. **It is reversible without a snapshot.** An overwrite is set and unset; a role
 *    permission has to be remembered to be restored, and remembering it is exactly
 *    the bug that leaves a server permanently muted.
 * 2. **It is scoped.** Locking `@everyone` out of every channel at once also locks
 *    out the staff who are handling the raid, unless every staff role has an
 *    explicit overwrite — which most servers do not have.
 *
 * Channels the bot cannot edit are reported, not thrown: a raid is not the moment
 * to abort because one channel is owned by another bot.
 */
import { ChannelType, PermissionFlagsBits, type Guild, type TextChannel } from "discord.js";

import type { GuildSecurityActions } from "./security.service.js";

/** Channel types a lockdown applies to. Voice channels are left alone. */
const LOCKABLE_TYPES: readonly ChannelType[] = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
];

/** The role name the security module creates for raid containment. */
export const QUARANTINE_ROLE_NAME = "Quarantined";

/**
 * The mute role, read so containment can leave an active mute in place.
 *
 * Declared here rather than imported from the moderation module: security must not
 * depend on moderation, and the name is a stable contract between the two (the
 * canonical permission specification lives in `moderation/mute-role.spec.ts`).
 */
export const MUTE_ROLE_NAME = "Muted";

export class DiscordSecurityActions implements GuildSecurityActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async lock(reason: string): Promise<{
    readonly ok: boolean;
    readonly changed: readonly string[];
    readonly detail?: string;
  }> {
    return this.applyLockdown(true, reason);
  }

  public async unlock(reason: string): Promise<{
    readonly ok: boolean;
    readonly changed: readonly string[];
    readonly detail?: string;
  }> {
    return this.applyLockdown(false, reason);
  }

  public quarantineRole(): Promise<{ id: string; name: string; position: number } | null> {
    const role = this.guild.roles.cache.find(
      (candidate) => candidate.name.trim().toLowerCase() === QUARANTINE_ROLE_NAME.toLowerCase(),
    );
    return Promise.resolve(role ? { id: role.id, name: role.name, position: role.position } : null);
  }

  public muteRole(): Promise<{ id: string; name: string; position: number } | null> {
    const role = this.guild.roles.cache.find(
      (candidate) => candidate.name.trim().toLowerCase() === MUTE_ROLE_NAME.toLowerCase(),
    );
    return Promise.resolve(role ? { id: role.id, name: role.name, position: role.position } : null);
  }

  public ownerId(): string {
    return this.guild.ownerId;
  }

  public botId(): string {
    return this.guild.members.me?.id ?? this.guild.client.user?.id ?? "";
  }

  public async roleIdsOf(userId: string): Promise<readonly string[]> {
    const member = this.guild.members.cache.get(userId) ?? (await this.fetchMember(userId));
    return member ? [...member.roles.cache.keys()] : [];
  }

  /**
   * Sets or clears the `Send Messages` overwrite for `@everyone`.
   *
   * `changed` lists the channels whose overwrite actually differed, so a second
   * lockdown during the same raid reports zero changes rather than claiming to have
   * locked the server again.
   */
  private async applyLockdown(
    locked: boolean,
    reason: string,
  ): Promise<{
    readonly ok: boolean;
    readonly changed: readonly string[];
    readonly detail?: string;
  }> {
    const everyone = this.guild.roles.everyone;
    const channels = [...this.guild.channels.cache.values()].filter(
      (channel): channel is TextChannel =>
        LOCKABLE_TYPES.includes(channel.type) && channel.parentId !== null,
    );

    const changed: string[] = [];
    const failed: string[] = [];

    for (const channel of channels) {
      const current = channel.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages);
      // `undefined` means the bot cannot resolve the state (no access): editing it
      // would be a guess, so it is reported instead.
      if (current === undefined) {
        failed.push(channel.id);
        continue;
      }
      if (locked ? current === false : current === true) {
        continue;
      }
      try {
        await channel.permissionOverwrites.edit(
          everyone,
          { SendMessages: locked ? false : null },
          { reason },
        );
        changed.push(channel.id);
      } catch {
        failed.push(channel.id);
      }
    }

    return {
      ok: failed.length === 0,
      changed,
      ...(failed.length === 0
        ? {}
        : { detail: `${failed.length} channel(s) could not be updated` }),
    };
  }

  /** Reads a member from the cache first, then from the API. */
  private async fetchMember(userId: string) {
    try {
      return await this.guild.members.fetch(userId);
    } catch {
      return null;
    }
  }
}
