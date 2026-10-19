/**
 * discord.js implementation of `GuildMemberActions`.
 *
 * This is the only file in the moderation module that knows about discord.js, and
 * it is deliberately thin: it maps one method to one API call and normalizes the
 * outcome. The rules live in the service, which makes them testable.
 *
 * Two normalization decisions matter:
 * - a Discord failure is returned as `{ ok: false, detail }` rather than thrown,
 *   because "the DM could not be delivered" must not roll back a successful ban;
 * - a genuinely missing permission or unknown member becomes a short sentence an
 *   administrator can act on, never a raw API payload.
 */
import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";

import type { GuildMemberActions, MemberActionResult, MemberState } from "./member-actions.js";
import { MUTE_ROLE_NAME as MUTE_ROLE_SPEC_NAME } from "./mute-role.spec.js";
import type { MemberTarget } from "./moderation.types.js";

export class DiscordMemberActions implements GuildMemberActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async readTarget(guildId: string, userId: string): Promise<MemberTarget | null> {
    if (guildId !== this.guild.id) {
      // Structural guild isolation: an adapter bound to guild A can never read a
      // member of guild B, so no caller can be handed cross-guild state.
      return null;
    }
    const member = await this.fetchMember(userId);
    return member ? this.describe(member) : null;
  }

  public async readBannedTarget(guildId: string, userId: string): Promise<MemberTarget | null> {
    if (guildId !== this.guild.id) {
      return null;
    }
    try {
      const ban = await this.guild.bans.fetch(userId);
      return {
        type: "member",
        id: ban.user.id,
        tag: ban.user.tag,
        present: false,
        sameGuild: true,
        protectedMember: false,
        botPermissions: this.botPermissions(),
        highestRolePosition: null,
        botHighestRolePosition: this.botHighestRolePosition(),
        timedOutUntil: null,
        muted: false,
        quarantined: false,
        banned: true,
        roleIds: [],
      };
    } catch {
      // Discord throws for "no such ban", which is exactly the `null` case.
      return null;
    }
  }

  public async timeout(
    target: MemberTarget,
    durationMs: number,
    reason: string,
  ): Promise<MemberActionResult> {
    const member = await this.fetchMember(target.id);
    if (!member) {
      return { ok: false, detail: "That member is no longer in this server." };
    }
    // `member.timeout()` takes a *duration*, not an absolute timestamp. It adds the
    // value to `Date.now()` internally, so passing an epoch here used to double the
    // offset and send `communication_disabled_until` ~110 years out.
    return this.attempt("apply a timeout", () => member.timeout(durationMs, reason));
  }

  public async removeTimeout(target: MemberTarget, reason: string): Promise<MemberActionResult> {
    const member = await this.fetchMember(target.id);
    if (!member) {
      return { ok: false, detail: "That member is no longer in this server." };
    }
    return this.attempt("remove the timeout", () => member.timeout(null, reason));
  }

  public async kick(target: MemberTarget, reason: string): Promise<MemberActionResult> {
    const member = await this.fetchMember(target.id);
    if (!member) {
      return { ok: false, detail: "That member is no longer in this server." };
    }
    return this.attempt("kick the member", () => member.kick(reason));
  }

  public async ban(
    target: MemberTarget,
    reason: string,
    options: { readonly deleteMessageSeconds: number },
  ): Promise<MemberActionResult> {
    return this.attempt("ban the user", () =>
      this.guild.bans.create(target.id, {
        reason,
        deleteMessageSeconds: options.deleteMessageSeconds,
      }),
    );
  }

  public async unban(target: MemberTarget, reason: string): Promise<MemberActionResult> {
    return this.attempt("lift the ban", () => this.guild.bans.remove(target.id, reason));
  }

  public muteRole(): Promise<{ id: string; name: string; position: number } | null> {
    return Promise.resolve(this.findRoleByName(MUTE_ROLE_NAME));
  }

  public quarantineRole(): Promise<{ id: string; name: string; position: number } | null> {
    // The security module creates this role during setup; moderation only
    // adopts it, exactly like the `Muted` role.
    return Promise.resolve(this.findRoleByName(QUARANTINE_ROLE_NAME));
  }

  public async stripRoles(
    target: MemberTarget,
    options: { readonly keepRoleIds: readonly string[]; readonly reason: string },
  ): Promise<{
    readonly ok: boolean;
    readonly removed: readonly string[];
    readonly detail?: string;
  }> {
    const member = await this.fetchMember(target.id);
    if (!member) {
      return { ok: false, removed: [], detail: "That member is no longer in this server." };
    }

    // The bot's own managed role and `@everyone` are never removed: the first
    // would make the bot unmanageable, the second is not a real role. The
    // `keepRoleIds` a caller passes (the quarantine role, the guild's staff
    // roles) are honoured on top.
    const keep = new Set<string>([...options.keepRoleIds, this.guild.roles.everyone.id]);
    const removable = member.roles.cache.filter(
      (role) => !keep.has(role.id) && !role.managed && role.id !== this.guild.roles.everyone.id,
    );

    if (removable.size === 0) {
      return { ok: true, removed: [] };
    }

    const removed = [...removable.keys()];
    const result = await this.attempt("remove the member's roles", () =>
      member.roles.remove(removed, options.reason),
    );
    return result.ok ? { ok: true, removed } : { ok: false, removed: [], ...detailOf(result) };
  }

  public async setRole(
    target: MemberTarget,
    roleId: string,
    present: boolean,
    reason: string,
  ): Promise<MemberActionResult> {
    const member = await this.fetchMember(target.id);
    if (!member) {
      return { ok: false, detail: "That member is no longer in this server." };
    }
    return this.attempt(present ? "add the role" : "remove the role", () =>
      present ? member.roles.add(roleId, reason) : member.roles.remove(roleId, reason),
    );
  }

  public async directMessage(userId: string, content: string): Promise<MemberActionResult> {
    try {
      const user = await this.guild.client.users.fetch(userId);
      await user.send(content);
      return { ok: true };
    } catch {
      // Closed DMs and blocked bots are normal, not a reason to fail an action;
      // the caller records a note instead.
      return { ok: false, detail: "They could not be reached by direct message." };
    }
  }

  public async purgeMessages(
    channelId: string,
    options: {
      readonly limit: number;
      readonly authorId?: string | null;
      readonly maxAgeMs: number;
      readonly keepPinned: boolean;
    },
  ): Promise<{ readonly removed: number }> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return { removed: 0 };
    }
    const text = channel;
    const cutoff = Date.now() - options.maxAgeMs;

    const fetched = await text.messages.fetch({ limit: Math.min(options.limit, 100) });

    const candidates = [...fetched.values()]
      .filter((message) => message.createdTimestamp > cutoff)
      .filter((message) => !options.keepPinned || !message.pinned)
      .filter((message) => !options.authorId || message.author.id === options.authorId)
      .slice(0, options.limit);

    if (candidates.length === 0) {
      return { removed: 0 };
    }

    // Discord refuses a bulk delete containing a message older than two weeks,
    // which the cutoff above already excludes.
    const deleted = await text.bulkDelete(candidates, false);
    return { removed: deleted.size };
  }

  /**
   * @returns the member's live mutable state, or `null` when they have left.
   *
   * Read from Discord rather than from the `MemberTarget` snapshot: a moderator's
   * command is parsed before the action runs, and another moderator (or automod)
   * may have changed the member in between. The no-op guard depends on this being
   * the current truth.
   */
  public async readState(userId: string): Promise<MemberState | null> {
    const member = await this.fetchMember(userId);
    if (!member) {
      return null;
    }
    const muteRole = this.findRoleByName(MUTE_ROLE_NAME);
    const quarantineRole = this.findRoleByName(QUARANTINE_ROLE_NAME);
    return {
      timedOutUntil: member.communicationDisabledUntil?.toISOString() ?? null,
      muted: muteRole !== null && member.roles.cache.has(muteRole.id),
      quarantined: quarantineRole !== null && member.roles.cache.has(quarantineRole.id),
    };
  }

  /** Reads a member from the cache first, then from the API. */
  private async fetchMember(userId: string): Promise<GuildMember | null> {
    const cached = this.guild.members.cache.get(userId);
    if (cached) {
      return cached;
    }
    try {
      return await this.guild.members.fetch(userId);
    } catch {
      return null;
    }
  }

  /** Captures every fact the service needs about a member. */
  private describe(member: GuildMember): MemberTarget {
    const isOwner = this.guild.ownerId === member.id;
    const quarantineRole = this.findRoleByName(QUARANTINE_ROLE_NAME);
    return {
      type: "member",
      id: member.id,
      tag: member.user.tag,
      present: true,
      sameGuild: member.guild.id === this.guild.id,
      // Owner and Administrator are never punishable through the bot: Discord
      // would refuse anyway, and the attempt must not be reported as a success.
      protectedMember: isOwner || member.permissions.has(PermissionFlagsBits.Administrator),
      botPermissions: this.botPermissions(),
      highestRolePosition: member.roles.highest.position,
      botHighestRolePosition: this.botHighestRolePosition(),
      timedOutUntil: member.communicationDisabledUntil ?? null,
      muted: member.roles.cache.some((role) => role.name.trim().toLowerCase() === MUTE_ROLE_NAME),
      quarantined: quarantineRole !== null && member.roles.cache.has(quarantineRole.id),
      banned: false,
      roleIds: [...member.roles.cache.keys()],
    };
  }

  /** @returns a guild role by case-insensitive name, or `null`. */
  private findRoleByName(name: string): { id: string; name: string; position: number } | null {
    const role = this.guild.roles.cache.find(
      (candidate) => candidate.name.trim().toLowerCase() === name,
    );
    return role ? { id: role.id, name: role.name, position: role.position } : null;
  }

  /** @returns the bot's permission bitfield. */
  private botPermissions(): bigint {
    return this.guild.members.me?.permissions.bitfield ?? 0n;
  }

  /** @returns the bot's highest role position, or a value that never blocks. */
  private botHighestRolePosition(): number {
    const me = this.guild.members.me;
    return me ? me.roles.highest.position : Number.MAX_SAFE_INTEGER;
  }

  /** Converts one Discord call into a uniform, non-throwing result. */
  private async attempt(label: string, call: () => Promise<unknown>): Promise<MemberActionResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeFailure(label, error) };
    }
  }
}

/**
 * The role name adopted for mutes.
 *
 * `/mute` only ever adopts an existing role; `/setup run` is what creates it. The
 * canonical specification (which permissions a mute needs) lives in
 * `mute-role.spec.ts` and is re-exported here so this adapter and the setup resource
 * registry can never disagree about the name.
 */
const MUTE_ROLE_NAME = MUTE_ROLE_SPEC_NAME;

/** The role name the security module creates for raid containment. */
const QUARANTINE_ROLE_NAME = "quarantined";

/** @returns the spreadable detail of a failed result, for a richer return type. */
function detailOf(result: { ok: boolean; detail?: string }): { detail?: string } {
  return result.detail === undefined ? {} : { detail: result.detail };
}

/** @returns a short, actionable explanation of a failed Discord call. */
function describeFailure(label: string, error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 50013) {
    return `I could not ${label}: my role is not high enough, or I lack the permission.`;
  }
  if (code === 10013 || code === 10007) {
    return `I could not ${label}: the user or member no longer exists.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `I could not ${label}: ${message}`;
}
