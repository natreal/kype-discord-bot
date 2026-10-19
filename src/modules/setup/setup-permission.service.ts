/**
 * Reusable permission-configuration service for setup-managed resources.
 *
 * Section 12 of the V2 brief: permission overwrites must have exactly one home.
 * Commands and future modules only ever *declare* intent
 * (`{ target, allow, deny }`); this service resolves that declaration into
 * concrete overwrite plans, applies the safety rules, and reports what the bot is
 * unable to do.
 *
 * The rules enforced here, and nowhere else:
 * - never grant `Administrator` to a resource setup created;
 * - never revoke another administrator's permissions;
 * - refuse to resolve a target that does not exist rather than guess by ID.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type PermissionResolvable,
  type Role,
  type TextChannel,
} from "discord.js";

import type { Logger } from "../../services/logger/index.js";
import { ValidationError } from "../../utils/errors.js";
import type { SetupPermissionOverwrite } from "../setup.types.js";
import {
  FORBIDDEN_SETUP_PERMISSIONS,
  FORBIDDEN_SETUP_PERMISSION_NAMES,
} from "./tracked-setuper.js";

/** Discord permissions the setup system needs to provision a guild. */
export const SETUP_BOT_PERMISSIONS: readonly PermissionResolvable[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

/** A resolved, ready-to-apply overwrite. */
export interface PlannedOverwrite {
  /** Role or user snowflake the overwrite applies to. */
  readonly overwriteId: string;
  /** Human-readable target description, used by the audit log. */
  readonly targetLabel: string;
  /** `allow: true` / `deny: false` map accepted by `permissionOverwrites.edit`. */
  readonly options: Readonly<Record<string, boolean>>;
  readonly remove: boolean;
  readonly reason: string;
}

export interface SetupPermissionServiceOptions {
  readonly logger: Logger;
}

export class SetupPermissionService {
  private readonly logger: Logger;

  public constructor(options: SetupPermissionServiceOptions) {
    this.logger = options.logger.child("setup-permissions");
  }

  /**
   * @returns the setup-critical permissions the bot is missing in this guild.
   *
   * `Administrator` satisfies every requirement, matching Discord's own semantics.
   * The result is used to fail fast *before* creating anything: a run that cannot
   * finish should say so up front rather than leave half a structure behind.
   */
  public missingBotPermissions(guild: Guild): readonly PermissionResolvable[] {
    const me: GuildMember | null = guild.members.me ?? null;
    if (!me) {
      return SETUP_BOT_PERMISSIONS;
    }
    if (me.permissions.has(PermissionFlagsBits.Administrator)) {
      return [];
    }
    return SETUP_BOT_PERMISSIONS.filter((permission) => !me.permissions.has(permission));
  }

  /** @returns a user-safe sentence naming the missing permissions. */
  public describeMissing(missing: readonly PermissionResolvable[]): string {
    if (missing.length === 0) {
      return "No permissions are missing.";
    }
    const listed = missing.map((permission) => `\`${String(permission)}\``).join(", ");
    return `Missing permissions: ${listed}.`;
  }

  /**
   * Resolves declarative overwrites into concrete Discord plans.
   *
   * Unresolvable targets are skipped with a warning rather than applied to the
   * wrong role: a missing `Support Team` role must never silently become an
   * overwrite on `@everyone`.
   */
  public async planOverwrites(
    guild: Guild,
    overwrites: readonly SetupPermissionOverwrite[],
  ): Promise<readonly PlannedOverwrite[]> {
    const plans: PlannedOverwrite[] = [];

    for (const overwrite of overwrites) {
      const target = await this.resolveTarget(guild, overwrite);
      if (!target) {
        this.logger.warn("Skipped a permission overwrite with an unresolvable target", {
          guildId: guild.id,
          target: overwrite.target.kind,
        });
        continue;
      }

      const allow = this.sanitize(overwrite.allow ?? [], overwrite, target.label);
      const deny = this.sanitize(overwrite.deny ?? [], overwrite, target.label);

      if (allow.length === 0 && deny.length === 0 && overwrite.remove !== true) {
        continue;
      }

      // Discord's own serializer produces exactly the allow/deny record that
      // `permissionOverwrites.edit` expects, so the conversion lives here once.
      const field = new PermissionsBitField(allow).remove(deny);
      const options: Record<string, boolean> = { ...field.serialize() };
      // A forbidden permission must never appear in the payload, not even as an
      // explicit `false`: writing `Administrator: false` is how a bot strips another
      // administrator's power, which setup is never allowed to do.
      for (const name of FORBIDDEN_SETUP_PERMISSION_NAMES) {
        delete options[name];
      }

      plans.push({
        overwriteId: target.id,
        targetLabel: target.label,
        options,
        remove: overwrite.remove === true,
        reason: overwrite.reason ?? "Automatic server setup",
      });
    }

    return plans;
  }

  /**
   * Applies overwrites to a channel.
   *
   * @returns the number of overwrites written or removed.
   */
  public async applyTo(
    resource: CategoryChannel | TextChannel | Role,
    overwrites: readonly SetupPermissionOverwrite[],
  ): Promise<number> {
    if (!isChannel(resource)) {
      throw new ValidationError("Permission overwrites only apply to channels in V2", {
        resourceId: resource.id,
      });
    }

    const plans = await this.planOverwrites(resource.guild, overwrites);
    for (const plan of plans) {
      if (plan.remove) {
        await resource.permissionOverwrites.delete(plan.overwriteId, plan.reason);
        continue;
      }
      await resource.permissionOverwrites.edit(plan.overwriteId, plan.options, {
        reason: plan.reason,
      });
    }
    return plans.length;
  }

  /**
   * Strips permissions setup may never grant.
   *
   * `Administrator` is removed from both the allow and the deny list: setup never
   * grants it, and it must not attempt to revoke another administrator's power
   * either (section 21: never remove existing administrator permissions).
   */
  private sanitize(
    permissions: readonly PermissionResolvable[],
    overwrite: SetupPermissionOverwrite,
    label: string,
  ): readonly PermissionResolvable[] {
    const forbidden = permissions.filter((permission) =>
      FORBIDDEN_SETUP_PERMISSIONS.includes(PermissionsBitField.resolve(permission)),
    );
    if (forbidden.length === 0) {
      return permissions;
    }

    this.logger.warn("Refused to apply a forbidden permission in a setup overwrite", {
      target: label,
      permissions: forbidden.map(String),
      reason: overwrite.reason ?? "unspecified",
    });
    return permissions.filter((permission) => !forbidden.includes(permission));
  }

  /** Resolves a declarative target into a concrete overwrite ID. */
  private async resolveTarget(
    guild: Guild,
    overwrite: SetupPermissionOverwrite,
  ): Promise<{ id: string; label: string } | null> {
    switch (overwrite.target.kind) {
      case "everyone":
        return { id: guild.roles.everyone.id, label: "@everyone" };
      case "bot": {
        const me: GuildMember | null = guild.members.me ?? null;
        return me ? { id: me.id, label: `bot (${me.user.username})` } : null;
      }
      case "roleName": {
        const role = await this.findRoleByName(guild, overwrite.target.name);
        return role ? { id: role.id, label: `@${role.name}` } : null;
      }
      case "resourceRole":
        // Resource-key targets are resolved through the identity table, which is
        // not needed until a module owns a role. Reported rather than guessed.
        this.logger.debug("Resource-role target needs an identity lookup", {
          key: overwrite.target.key,
        });
        return null;
      default:
        return null;
    }
  }

  private async findRoleByName(guild: Guild, name: string): Promise<Role | null> {
    const normalized = name.trim().toLowerCase();
    const cached = guild.roles.cache.find((role) => role.name.trim().toLowerCase() === normalized);
    if (cached) {
      return cached;
    }
    try {
      const roles = await guild.roles.fetch();
      return roles.find((role) => role.name.trim().toLowerCase() === normalized) ?? null;
    } catch {
      return null;
    }
  }
}

/** @returns true when the resource supports permission overwrites. */
function isChannel(
  resource: CategoryChannel | TextChannel | Role,
): resource is CategoryChannel | TextChannel {
  return (
    "permissionOverwrites" in resource &&
    (resource.type === ChannelType.GuildText || resource.type === ChannelType.GuildCategory)
  );
}
