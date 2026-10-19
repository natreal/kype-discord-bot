/**
 * Central authorization service (V3).
 *
 * One pipeline, one place to read the rules:
 *
 *   Command → AuthorizationService.authorize()
 *               → God Access bypass (privileged, audited)
 *               → Discord permission check
 *               → Custom permission check (role → class → permission)
 *               → structured AuthorizationDecision
 *
 * Commands never compare user IDs and never call `member.permissions.has()`
 * themselves: they declare a `PermissionRequest` and act on the decision. The God
 * Access ID is read from the single existing constant (it is *not* duplicated
 * here), so the mechanism V1/V2 established stays authoritative.
 */
import {
  PermissionFlagsBits,
  type GuildMember,
  type Guild,
  type PermissionResolvable,
} from "discord.js";

import type { Logger } from "../logger/index.js";
import type { AuditEventService } from "../audit/index.js";
import { botPermissionsForDiscord } from "../permissions/permission-map.js";
import { isBotPermission, type BotPermission } from "../permissions/permissions.js";
import {
  GOD_ACCESS_USER_IDS,
  hasGodAccess as legacyHasGodAccess,
} from "../permissions/permission.service.js";
import type { PermissionClassStore } from "./permission-class.store.js";
import { unknownPermissions, type Permission } from "./permissions.js";

/**
 * @returns true when `userId` holds God Access.
 *
 * Re-exported from the authorization layer so future modules import the check
 * from one place; the implementation still lives with the other V1/V2 permission
 * primitives, so there is exactly one comparison in the codebase.
 */
export function hasGodAccess(userId: string | null | undefined): boolean {
  return legacyHasGodAccess(userId);
}

/** Every outcome the authorization layer can produce. */
export type AuthorizationOutcome =
  | "ALLOW"
  | "DENY_DISCORD_PERMISSION"
  | "DENY_CUSTOM_PERMISSION"
  | "DENY_UNKNOWN_PERMISSION"
  | "DENY_OWNER_ONLY"
  | "DENY_NO_GUILD"
  | "DENY_UNKNOWN_COMMAND";

/** What a command asks for. */
export interface PermissionRequest {
  /** Discord permissions the actor must hold, when checked directly. */
  readonly discord?: readonly PermissionResolvable[];
  /** Granular permissions the actor must hold through a class or override. */
  readonly custom?: readonly Permission[];
  /** Legacy V2 catalog names; mapped onto the Discord layer as needed. */
  readonly botPermissions?: readonly BotPermission[];
  /** Only the guild owner may execute. */
  readonly ownerOnly?: boolean;
}

/** Structured result of an authorization check. */
export interface AuthorizationDecision {
  readonly outcome: AuthorizationOutcome;
  readonly allowed: boolean;
  /** Permission names the actor is missing, for the denial message. */
  readonly missing: readonly string[];
  /** Which layer decided the outcome. */
  readonly deniedBy: "god" | "discord" | "custom" | "policy" | "context" | null;
  /** True when the decision came from God Access rather than from a check. */
  readonly godAccess: boolean;
  /** User-safe explanation. */
  readonly reason?: string;
}

/**
 * Resolved facts about one (user, guild) pair.
 *
 * This is the "authorization context" of the V3 brief: everything a decision
 * needs, computed once, so no command has to assemble it. It is immutable and
 * guild-scoped; nothing here is cached across guilds or invocations.
 */
export interface AuthorizationContext {
  readonly userId: string;
  readonly guildId: string;
  /** Discord permissions the actor holds. */
  readonly discordPermissions: readonly string[];
  /** Discord permissions the bot holds. */
  readonly botPermissions: readonly string[];
  /** Granular permissions granted by classes and overrides. */
  readonly customPermissions: readonly Permission[];
  /** True for the compiled-in owner account. */
  readonly isGod: boolean;
  /** True for the guild owner or a member holding `Administrator`. */
  readonly isAdministrator: boolean;
  /** Permission class keys that matched, highest priority first. */
  readonly classes: readonly string[];
}

const ALLOW: Omit<AuthorizationDecision, "godAccess"> = {
  outcome: "ALLOW",
  allowed: true,
  missing: [],
  deniedBy: null,
};

export interface AuthorizationServiceOptions {
  readonly logger: Logger;
  /** Role → permission mapping store. Omitted in minimal test setups. */
  readonly classes?: PermissionClassStore;
  readonly audit?: AuditEventService;
}

export class AuthorizationService {
  private readonly logger: Logger;
  private readonly classes: PermissionClassStore | undefined;
  private readonly audit: AuditEventService | undefined;

  public constructor(options: AuthorizationServiceOptions) {
    this.logger = options.logger.child("authorization");
    this.classes = options.classes;
    this.audit = options.audit;
  }

  /**
   * Builds the authorization context for a member.
   *
   * `guildId` always comes from the member's guild, so a context can never
   * describe a different guild than the one being acted on.
   */
  public async contextFor(member: GuildMember): Promise<AuthorizationContext> {
    const isGod = hasGodAccess(member.id);
    const isOwner = member.guild.ownerId === member.id;
    const isAdministrator = isOwner || member.permissions.has(PermissionFlagsBits.Administrator);

    const effective = this.classes
      ? await this.classes.effectiveClasses(member.guild.id, [...member.roles.cache.keys()], {
          owner: isOwner,
          administrator: isAdministrator,
          god: isGod,
        })
      : [];

    const custom = new Set<Permission>();
    for (const definition of effective) {
      for (const permission of definition.permissions) {
        custom.add(permission);
      }
    }

    return {
      userId: member.id,
      guildId: member.guild.id,
      discordPermissions: [...member.permissions.toArray()],
      botPermissions: [...(member.guild.members.me?.permissions.toArray() ?? [])],
      customPermissions: [...custom].sort(),
      isGod,
      isAdministrator,
      classes: effective.map((definition) => definition.key),
    };
  }

  /**
   * Decides whether a member may proceed.
   *
   * God Access bypasses *every* layer; the guild owner and Administrators bypass
   * the *Discord* layer only (Discord already grants them everything), matching
   * V1/V2 semantics. Custom permissions are evaluated for everyone else.
   */
  public async authorize(
    member: GuildMember,
    request: PermissionRequest = {},
    commandName?: string,
  ): Promise<AuthorizationDecision> {
    const decision = await this.decide(member, request, commandName);
    if (!decision.allowed) {
      this.logger.warn("Authorization denied", {
        outcome: decision.outcome,
        guildId: member.guild.id,
        userId: member.id,
        missing: decision.missing,
        command: commandName ?? "unknown",
      });
    }
    return decision;
  }

  /** Performs the check without denial logging, for diagnostics and tests. */
  public async decide(
    member: GuildMember,
    request: PermissionRequest = {},
    commandName?: string,
  ): Promise<AuthorizationDecision> {
    const context = await this.contextFor(member);

    if (context.isGod) {
      await this.recordPrivileged(member, commandName, request);
      return {
        ...ALLOW,
        godAccess: true,
        deniedBy: "god",
        reason: "Authorized by the owner account.",
      };
    }

    const custom = this.customRequirements(request);
    const unknown = unknownPermissions(custom);
    if (unknown.length > 0) {
      return {
        outcome: "DENY_UNKNOWN_PERMISSION",
        allowed: false,
        missing: unknown,
        deniedBy: "policy",
        godAccess: false,
        reason: "The command requests permissions this build does not know about.",
      };
    }

    if (request.ownerOnly === true && member.guild.ownerId !== member.id) {
      return {
        outcome: "DENY_OWNER_ONLY",
        allowed: false,
        missing: ["guildOwner"],
        deniedBy: "policy",
        godAccess: false,
        reason: "This command is limited to the server owner.",
      };
    }

    const discord = this.discordRequirements(request);
    if (!context.isAdministrator && discord.length > 0) {
      const missing = discord.filter((permission) => !member.permissions.has(permission));
      if (missing.length > 0) {
        return {
          outcome: "DENY_DISCORD_PERMISSION",
          allowed: false,
          missing: missing.map(String),
          deniedBy: "discord",
          godAccess: false,
          reason: "You are missing the Discord permissions required for this command.",
        };
      }
    }

    if (custom.length > 0) {
      const granted = new Set(context.customPermissions);
      const missing = custom.filter((permission) => !granted.has(permission));
      if (missing.length > 0) {
        return {
          outcome: "DENY_CUSTOM_PERMISSION",
          allowed: false,
          missing,
          deniedBy: "custom",
          godAccess: false,
          reason: "You are missing the permissions required for this command.",
        };
      }
    }

    return { ...ALLOW, godAccess: false };
  }

  /** @returns true when the decision allows the action (convenience helper). */
  public async can(
    member: GuildMember,
    request: PermissionRequest = {},
    commandName?: string,
  ): Promise<boolean> {
    const decision = await this.decide(member, request, commandName);
    return decision.allowed;
  }

  /**
   * @returns true when `member` may bind a role to (or create one as) `classKey`.
   *
   * This is the anti-escalation invariant of the role → class mapping: nobody may
   * grant a class that contains a permission they do not already hold. Without
   * it, `/roles bind` was itself an escalation primitive — anyone allowed to
   * manage roles but *not* to configure the bot could bind their own role to
   * `administrator`, then pass every `custom` gate (`/ai`, `/settings`, ...).
   *
   * The guild owner and Discord administrators may grant anything bindable: the
   * authorization model already gives them the implied `owner`/`administrator`
   * class (every permission), so the subset rule accepts them naturally. God
   * Access likewise. Everything unresolvable — no class store, unknown key — and
   * `owner` (implied by Discord, never bound to a role) deny, so the failure mode
   * is always "no grant".
   */
  public async canGrantClass(member: GuildMember, classKey: string): Promise<boolean> {
    const context = await this.contextFor(member);

    if (!this.classes) {
      return false;
    }

    const definitions = await this.classes.list(member.guild.id);
    const definition = definitions.find((candidate) => candidate.key === classKey);
    if (!definition || definition.key === "owner") {
      return false;
    }

    if (context.isGod || context.isAdministrator) {
      return true;
    }

    const held = new Set(context.customPermissions);
    return definition.permissions.every((permission) => held.has(permission));
  }

  /**
   * @returns the bot's own authorization facts for a guild.
   *
   * Used by diagnostics to report what the *bot* can do, which is a different
   * question from what a member may ask it to do.
   */
  public guildContext(guild: Guild): {
    readonly guildId: string;
    readonly botPermissions: readonly string[];
    readonly botIsAdministrator: boolean;
  } {
    const me: GuildMember | null = guild.members.me ?? null;
    return {
      guildId: guild.id,
      botPermissions: [...(me?.permissions.toArray() ?? [])],
      botIsAdministrator: me?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    };
  }

  /** @returns the granular permissions a request asks for. */
  private customRequirements(request: PermissionRequest): Permission[] {
    return [...(request.custom ?? [])];
  }

  /**
   * @returns the Discord permissions a request asks for.
   *
   * Explicit `discord` wins; otherwise legacy bot permission names are expanded
   * through the shared mapping, so a V2-style command declaration keeps working.
   */
  private discordRequirements(request: PermissionRequest): readonly PermissionResolvable[] {
    if (request.discord && request.discord.length > 0) {
      return request.discord;
    }
    const legacy = (request.botPermissions ?? []).filter(isBotPermission);
    return legacy.length > 0 ? botPermissionsForDiscord(legacy) : [];
  }

  /** Records the God Access bypass; it is privileged and always audited. */
  private async recordPrivileged(
    member: GuildMember,
    commandName: string | undefined,
    request: PermissionRequest,
  ): Promise<void> {
    this.logger.warn("Authorization bypassed by God Access", {
      guildId: member.guild.id,
      userId: member.id,
      command: commandName ?? "unknown",
    });

    if (!this.audit) {
      return;
    }
    await this.audit.record({
      guildId: member.guild.id,
      action: "authorization.godAccess",
      category: "authorization",
      severity: "privileged",
      actorId: member.id,
      actorKind: "god",
      targetType: "command",
      targetId: commandName ?? null,
      outcome: "success",
      details: {
        requestedDiscord: (request.discord ?? []).map(String),
        requestedCustom: request.custom ?? [],
        requestedLegacy: request.botPermissions ?? [],
      },
    });
  }
}

/** The IDs that hold God Access; exported for diagnostics. */
export const GOD_ACCESS_IDS: readonly string[] = GOD_ACCESS_USER_IDS;
