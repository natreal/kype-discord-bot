/**
 * Role module types.
 *
 * The module exists for one capability the platform could not express before:
 * **a role that comes back off on its own**. Every temporary grant is a persisted
 * deadline plus a scheduled task, never an in-memory timer, because a timer dies
 * with the process and leaves the member holding the role forever — the failure
 * mode that makes temporary roles untrustworthy.
 *
 * Three properties shape the types here:
 *
 * - **Grant identity is (guild, member, role).** Granting the same role twice
 *   extends the existing grant rather than stacking a second one, so there is
 *   exactly one deadline to reason about and no way to revoke "one of" it.
 * - **Expiry is idempotent.** `revokedAt`/`status` make the terminal state
 *   explicit, so a duplicate task fire, a manual revoke and a sweep racing each
 *   other all converge on the same outcome.
 * - **The Discord calls are a port.** `GuildRoleActions` is injected, so the
 *   service is testable against a fake and the hierarchy rules live in one place.
 */
import type { Guild } from "discord.js";

/** Lifecycle state of a grant. Mirrors the `status` column. */
export type RoleGrantStatus = "active" | "expired" | "revoked";

/**
 * Why a role was granted.
 *
 * Stored so an operator can tell a self-service role from an automated one, and so
 * one table can serve every V6 role surface without a second grant mechanism.
 */
export type RoleGrantSource =
  "temporary" | "menu" | "button" | "reaction" | "welcome" | "automation";

/** A persisted grant. */
export interface RoleGrantRecord {
  readonly id: string;
  readonly guildId: string;
  /** Member the role was granted to. */
  readonly userId: string;
  readonly roleId: string;
  readonly source: RoleGrantSource;
  /** The menu that produced the grant, when there was one. */
  readonly menuId: string | null;
  /** Discord user ID or `system:<name>` that performed the grant. */
  readonly grantedBy: string;
  readonly status: RoleGrantStatus;
  /** When the role must come off; `null` for a permanent grant. */
  readonly expiresAt: Date | null;
  readonly grantedAt: Date;
  /** When it actually came off, or `null` while it is still held. */
  readonly revokedAt: Date | null;
  /** Who or what removed it, once it has been removed. */
  readonly revokedBy: string | null;
}

/** Everything needed to create or extend a grant. */
export interface RoleGrantDraft {
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly source: RoleGrantSource;
  readonly menuId?: string | null;
  readonly grantedBy: string;
  /** `null` for a permanent grant; the temporary path always sets it. */
  readonly expiresAt: Date | null;
}

/** Filters for listing grants. All guild-scoped. */
export interface RoleGrantQuery {
  readonly userId?: string | null;
  readonly roleId?: string | null;
  readonly status?: RoleGrantStatus | null;
  readonly limit?: number;
}

/**
 * Persistence port for role grants.
 *
 * `upsert` is the only way a grant is created, and it is deliberately an upsert:
 * granting a role a member already holds must move the deadline, not create a
 * second row that the sweeper would then race against.
 */
export interface RoleGrantRepository {
  /** Creates or extends the live grant for (guild, userId, roleId). */
  upsert(draft: RoleGrantDraft): Promise<RoleGrantRecord>;
  /** Closes the live grant for one member/role pair. @returns false when none was live. */
  close(
    guildId: string,
    userId: string,
    roleId: string,
    status: Exclude<RoleGrantStatus, "active">,
    at: Date,
    closedBy: string,
  ): Promise<boolean>;
  /** Closes one grant by id. @returns false when it was already closed. */
  closeById(
    id: string,
    status: Exclude<RoleGrantStatus, "active">,
    at: Date,
    closedBy: string,
  ): Promise<boolean>;
  findById(id: string): Promise<RoleGrantRecord | null>;
  /** The live grant for one member/role pair, or `null`. */
  findLive(guildId: string, userId: string, roleId: string): Promise<RoleGrantRecord | null>;
  list(guildId: string, query?: RoleGrantQuery): Promise<RoleGrantRecord[]>;
  /** @returns active grants whose `expiresAt` has passed, oldest deadline first. */
  listExpired(now: Date, limit: number): Promise<RoleGrantRecord[]>;
}

/** Result of one Discord role mutation. */
export interface RoleActionResult {
  readonly ok: boolean;
  /** Set when `ok` is false: a short, user-safe reason. */
  readonly detail?: string;
}

/**
 * Discord operations the role module needs, bound to one guild.
 *
 * Mirrors `GuildMemberActions`: a port rather than a direct client, so the
 * service is testable and the "is this role assignable by the bot" rules are
 * answered in one place instead of at every call site.
 */
export interface GuildRoleActions {
  /** @returns whether the member is currently in the guild. */
  hasMember(userId: string): Promise<boolean>;
  /** @returns the role IDs the member holds, or `null` when they are not here. */
  roleIdsOf(userId: string): Promise<readonly string[] | null>;
  /** Adds or removes one role. */
  setRole(
    userId: string,
    roleId: string,
    present: boolean,
    reason: string,
  ): Promise<RoleActionResult>;
  /** @returns whether the role exists and the bot can manage it. */
  canManage(roleId: string): Promise<boolean>;
  /** The bot's own highest role position, to answer hierarchy questions. */
  botHighestPosition(): Promise<number>;
  /** @returns a role's position, or `null` when it no longer exists. */
  rolePosition(roleId: string): Promise<number | null>;
}

/** Adapter factory, injected so tests can substitute a fake. */
export type GuildRoleActionAdapter = (guild: Guild) => GuildRoleActions;
