/**
 * discord.js implementation of `GuildRoleActions`.
 *
 * The only file in the role module that knows about discord.js, and deliberately
 * thin: one method maps to one API call and normalizes the outcome. The rules stay
 * in the service, which is what makes them testable.
 *
 * Three normalization decisions matter:
 * - a Discord failure is returned as `{ ok: false, detail }` rather than thrown,
 *   because "the member left before I could add the role" must not look like a bug;
 * - `roleIdsOf` returns `null` (not `[]`) for an absent member, so the service can
 *   tell "holds no roles" from "is not here" — a distinction that decides whether
 *   an expiry is closed or left pending;
 * - `canManage` folds three separate Discord questions (does it exist, is it
 *   managed by an integration, is it below my highest role) into one boolean,
 *   because every caller needs all three and forgetting one is the classic cause of
 *   a role that is granted, then silently never removed.
 */
import type { Guild } from "discord.js";

import type { GuildRoleActions, RoleActionResult } from "./role.types.js";

export class DiscordRoleActions implements GuildRoleActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async hasMember(userId: string): Promise<boolean> {
    const member = await this.fetchMember(userId);
    return member !== null;
  }

  public async roleIdsOf(userId: string): Promise<readonly string[] | null> {
    const member = await this.fetchMember(userId);
    return member ? [...member.roles.cache.keys()] : null;
  }

  public async setRole(
    userId: string,
    roleId: string,
    present: boolean,
    reason: string,
  ): Promise<RoleActionResult> {
    const member = await this.fetchMember(userId);
    if (!member) {
      return { ok: false, detail: "that member is not in this server" };
    }

    try {
      if (present) {
        await member.roles.add(roleId, reason);
      } else {
        await member.roles.remove(roleId, reason);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeRoleError(error) };
    }
  }

  public async canManage(roleId: string): Promise<boolean> {
    const role = await this.fetchRole(roleId);
    if (!role) {
      return false;
    }
    // A role owned by an integration (a bot role, a booster role) cannot be
    // assigned by hand, and Discord rejects the call.
    if (role.managed) {
      return false;
    }
    // Hierarchy: the bot may only touch roles strictly below its own highest.
    const highest = this.botHighestRolePosition();
    return highest !== null && role.position < highest;
  }

  public botHighestPosition(): Promise<number> {
    // Not an `async` method on purpose: it reads local state synchronously, and
    // `require-await` correctly flags an `async` function that never awaits.
    return Promise.resolve(this.botHighestRolePosition() ?? 0);
  }

  public async rolePosition(roleId: string): Promise<number | null> {
    const role = await this.fetchRole(roleId);
    return role ? role.position : null;
  }

  /** Looks a member up without letting a cache miss or a Discord error escape. */
  private fetchMember(userId: string) {
    return this.guild.members.fetch(userId).catch(() => null);
  }

  /** Looks a role up without letting a missing role throw. */
  private fetchRole(roleId: string) {
    return this.guild.roles.fetch(roleId).catch(() => null);
  }

  /** The bot's own highest role position, or `null` when it has no resolvable member. */
  private botHighestRolePosition(): number | null {
    const me = this.guild.members.me;
    return me ? me.roles.highest.position : null;
  }
}

/** Turns a discord.js failure into a sentence an administrator can act on. */
function describeRoleError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 50013) {
    return "I am missing the Manage Roles permission";
  }
  if (code === 10011 || code === 10007) {
    return "that role no longer exists";
  }
  return error instanceof Error ? error.message : "Discord refused the change";
}
