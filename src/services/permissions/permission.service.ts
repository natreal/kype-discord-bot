/**
 * Centralized permission service.
 *
 * All authorization checks go through this service so that permission logic is
 * never duplicated across commands. Two layers are evaluated:
 *
 * - Discord permissions: the initial, fully implemented authorization layer.
 * - Bot permissions: a namespaced catalog (`moderation.ban`, ...). For V1 the
 *   catalog is used to *describe* required permissions; custom role overrides
 *   can be plugged in later without changing call sites.
 */
import {
  type GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type PermissionResolvable,
} from "discord.js";

import { PermissionError } from "../../utils/errors.js";
import { botPermissionsForDiscord } from "./permission-map.js";
import { isBotPermission, type BotPermission } from "./permissions.js";

const ADMINISTRATOR = PermissionFlagsBits.Administrator;

export interface PermissionRequirement {
  /** Discord permissions the invoker must hold. */
  readonly discord?: readonly PermissionResolvable[];
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
   * The guild owner and administrators always pass Discord permission checks.
   * That matches Discord's own semantics (the owner implicitly holds every
   * permission) and prevents locking an owner out of the bot.
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

    if (resolved.ownerOnly === true && member.guild.ownerId !== member.id) {
      return {
        allowed: false,
        missing: ["guildOwner"],
        reason: "This command is limited to the server owner.",
      };
    }

    if (member.permissions.has(ADMINISTRATOR) || member.guild.ownerId === member.id) {
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

    return ALLOWED;
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

  /** The bot's own member object, when available. */
  public botMember(guild: Guild): GuildMember | null {
    return guild.members.me;
  }
}
