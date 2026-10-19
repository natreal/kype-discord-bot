/**
 * Centralized permission service.
 *
 * All authorization checks go through this service so that permission logic is
 * never duplicated across commands. Three layers are evaluated:
 *
 * - God Access: one operator-owned Discord user ID that bypasses everything.
 * - Discord permissions: the fully implemented authorization layer.
 * - Bot permissions: a namespaced catalog (`moderation.ban`, ...). The catalog is
 *   used to *describe* required permissions and to encode application policy.
 */
import {
  type GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type PermissionResolvable,
} from "discord.js";

import { PermissionError } from "../../utils/errors.js";
import { GOD_ACCESS_USER_ID } from "../../modules/setup/setup-module.js";
import type { Permission } from "../authorization/permissions.js";
import { CRITICAL_PERMISSIONS } from "./permission-profiles.js";
import { botPermissionsForDiscord } from "./permission-map.js";
import { isBotPermission, type BotPermission } from "./permissions.js";

const ADMINISTRATOR = PermissionFlagsBits.Administrator;

/**
 * Users who hold God Access.
 *
 * A single ID, by explicit operator decision: the deployment owner can use every
 * feature regardless of the Discord permissions they hold. It is intentionally a
 * *user* ID rather than a role, so no guild administrator can grant it to
 * themselves, and it is never read from configuration or user input.
 */
export const GOD_ACCESS_USER_IDS: readonly string[] = [GOD_ACCESS_USER_ID];

/** @returns true when `userId` holds God Access. */
export function hasGodAccess(userId: string | null | undefined): boolean {
  return typeof userId === "string" && GOD_ACCESS_USER_IDS.includes(userId);
}

export interface PermissionRequirement {
  /** Discord permissions the invoker must hold. */
  readonly discord?: readonly PermissionResolvable[];
  /**
   * Granular V3 permission identifiers the invoker must hold.
   *
   * Evaluated by the authorization layer through the role → class → permission
   * mapping, so a server can grant moderation powers without granting Discord's
   * own permissions — which is the whole point of the V3 permission model.
   */
  readonly custom?: readonly Permission[];
  /** Discord permissions the bot itself must hold in the channel. */
  readonly bot?: readonly PermissionResolvable[];
  /** Named bot permissions (used for future custom role overrides). */
  readonly botPermissions?: readonly BotPermission[];
  /** Only the guild owner may run the command. */
  readonly ownerOnly?: boolean;
}

/** Outcome of a permission check, including a user-safe reason. */
export interface PermissionCheckResult {
  readonly allowed: boolean;
  readonly missing: readonly string[];
  readonly reason?: string;
}

const ALLOWED: PermissionCheckResult = { allowed: true, missing: [] };

/**
 * Resolves the permissions required by a command.
 *
 * Explicit requirements win; otherwise the requirements are derived from the
 * bot permission catalog (e.g. `moderation.ban` implies Discord `BanMembers`).
 */
export function resolveRequirement(requirement: PermissionRequirement = {}): PermissionRequirement {
  if (requirement.discord && requirement.discord.length > 0) {
    return requirement;
  }
  if (requirement.botPermissions && requirement.botPermissions.length > 0) {
    return { ...requirement, discord: botPermissionsForDiscord(requirement.botPermissions) };
  }
  return requirement;
}

export class PermissionService {
  /**
   * @returns true when `member` satisfies the requirement.
   *
   * The guild owner and administrators bypass *Discord* permission checks, which
   * matches Discord's own semantics (the owner implicitly holds every
   * permission) and prevents locking an owner out of the bot.
   *
   * They do NOT bypass the named bot permission catalog: those are application
   * rules the operator chooses, so an administrator is still subject to them
   * unless the catalog says otherwise. This matters for a bot installed with
   * `Administrator` — see `docs/PERMISSIONS.md`.
   */
  public can(member: GuildMember, requirement: PermissionRequirement = {}): boolean {
    return this.check(member, requirement).allowed;
  }

  /** Same as `can`, but returns the missing permissions for diagnostics. */
  public check(
    member: GuildMember,
    requirement: PermissionRequirement = {},
  ): PermissionCheckResult {
    const resolved = resolveRequirement(requirement);

    // God Access is absolute: it precedes every other rule, including `ownerOnly`
    // and unknown bot permission names, so the owner can never lock themselves out
    // of their own deployment. Callers log the bypass as a privileged event.
    if (hasGodAccess(member.id)) {
      return ALLOWED;
    }

    if (resolved.ownerOnly === true && member.guild.ownerId !== member.id) {
      return {
        allowed: false,
        missing: ["guildOwner"],
        reason: "This command is limited to the server owner.",
      };
    }

    // Named bot permissions are application policy: verify them for everyone,
    // including administrators.
    const unknownBotPermissions = (resolved.botPermissions ?? []).filter(
      (permission) => !isBotPermission(permission),
    );
    if (unknownBotPermissions.length > 0) {
      return {
        allowed: false,
        missing: unknownBotPermissions,
        reason: "The command requests an unknown bot permission.",
      };
    }

    // Granular (custom) permissions are resolved by `AuthorizationService`
    // through the guild's role → class mapping, which this synchronous service
    // has no access to (the mapping is guild-scoped and asynchronous).
    //
    // Ignoring them here — as this service used to — is a silent *allow*, and it
    // is exactly how `/ai enable` was reachable by every member. Failing closed
    // makes the limitation explicit: a caller that needs a custom permission
    // must go through the authorization layer, never through this service.
    // The guild owner and administrators keep passing, because the authorization
    // layer models them as holding the implied `owner`/`administrator` class
    // (every granular permission).
    const custom = resolved.custom ?? [];
    if (custom.length > 0 && !this.bypassesDiscordChecks(member)) {
      return {
        allowed: false,
        missing: custom,
        reason:
          "This action needs role-based permissions, which only the authorization layer can resolve.",
      };
    }

    // Discord permissions are bypassed by administrators and the guild owner.
    if (this.bypassesDiscordChecks(member)) {
      return ALLOWED;
    }

    const missingPermissions = (resolved.discord ?? []).filter(
      (permission) => !member.permissions.has(permission),
    );
    if (missingPermissions.length > 0) {
      return {
        allowed: false,
        missing: missingPermissions.map(String),
        reason: "You are missing the Discord permissions required for this command.",
      };
    }

    return ALLOWED;
  }

  /**
   * @returns true when the member holds `Administrator`, owns the guild, or has
   * God Access.
   *
   * Exposed so that future modules can log privileged actions distinctly: an
   * administrator acting through the bot is an audit-worthy event.
   */
  public bypassesDiscordChecks(member: GuildMember): boolean {
    return (
      hasGodAccess(member.id) ||
      member.permissions.has(ADMINISTRATOR) ||
      member.guild.ownerId === member.id
    );
  }

  /**
   * @returns true when `member` holds God Access.
   *
   * A named accessor (rather than comparing IDs at call sites) keeps the single
   * source of truth intact and makes the privilege greppable.
   */
  public isGodAccess(member: GuildMember | null | undefined): boolean {
    return hasGodAccess(member?.id);
  }

  /** Verifies the bot can actually act in the guild/channel it was invoked in. */
  public checkBotPermissions(
    interaction: ChatInputCommandInteraction,
    requirement: PermissionRequirement = {},
  ): PermissionCheckResult {
    const resolved = resolveRequirement(requirement);
    const required = resolved.bot ?? [];
    if (required.length === 0) {
      return ALLOWED;
    }

    const me = interaction.guild?.members.me;
    if (!me) {
      return {
        allowed: false,
        missing: required.map(String),
        reason: "The bot is not in this server.",
      };
    }

    const missing = required.filter((permission) => !me.permissions.has(permission));
    if (missing.length > 0) {
      return {
        allowed: false,
        missing: missing.map(String),
        reason: "The bot is missing permissions required for this action.",
      };
    }
    return ALLOWED;
  }

  /** Convenience assertion used by services (throws `PermissionError`). */
  public assert(
    member: GuildMember,
    requirement: PermissionRequirement = {},
    context?: string,
  ): void {
    const result = this.check(member, requirement);
    if (!result.allowed) {
      throw new PermissionError(result.missing.join(", ") || "unknown", {
        ...(context === undefined ? {} : { context }),
        missing: result.missing,
      });
    }
  }

  /** @returns the Discord permission bitfield required for a requirement. */
  public requiredDiscordPermissions(
    requirement: PermissionRequirement = {},
  ): PermissionResolvable[] {
    return [...(resolveRequirement(requirement).discord ?? [])];
  }

  /** Checks a bot permission directly (used for custom overrides later). */
  public canBotPermission(member: GuildMember, permission: BotPermission): boolean {
    return this.can(member, { botPermissions: [permission] });
  }

  /**
   * @returns the critical Discord permissions the bot is missing in a guild.
   *
   * Used by the startup self-check and `/admin permissions`: an operator should
   * learn *what* is missing rather than watching a feature fail silently when
   * Discord rejects an action. Administrators are never reported as missing
   * anything.
   */
  public missingCriticalPermissions(bot: GuildMember): PermissionResolvable[] {
    if (this.bypassesDiscordChecks(bot)) {
      return [];
    }
    return CRITICAL_PERMISSIONS.filter((permission) => !bot.permissions.has(permission));
  }

  /** @returns true when the bot holds `Administrator` in the guild. */
  public isAdministrator(bot: GuildMember): boolean {
    return bot.permissions.has(ADMINISTRATOR);
  }

  /** The bot's own member object, when available. */
  public botMember(guild: Guild): GuildMember | null {
    return guild.members.me;
  }
}
