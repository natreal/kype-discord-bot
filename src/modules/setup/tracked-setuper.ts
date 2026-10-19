/**
 * Tracked setup helpers mounted on a guild.
 *
 * Extends the V1 `DiscordSetuper` (unchanged, still used by the V1 modules) with
 * the V2 capabilities:
 *
 * - `resolveTrackedResource()` — resolves a resource through the identity table,
 *   so reuse works by Discord ID rather than by name, and a deleted resource is
 *   repaired instead of duplicated;
 * - `applyPermissionDiff()` — applies declarative overwrites through the
 *   permission service, never inline in a command.
 *
 * Inheriting the V1 methods keeps the existing modules working untouched.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
} from "discord.js";

import { DiscordApiError, ValidationError } from "../../utils/errors.js";
import type { Logger } from "../../services/logger/index.js";
import { MUTE_ROLE_NAME, diffMuteRole, type MuteRoleDifference } from "../moderation/mute-role.spec.js";
import { DiscordSetuper } from "../setuper.js";
import type {
  SetupPermissionOverwrite,
  SetupResourceDefinition,
  TrackedResolution,
} from "../setup.types.js";
import type { SetupResourceService } from "./setup-resource.service.js";
import type { SetupPermissionService } from "./setup-permission.service.js";

/**
 * Outcome of verifying a managed role's permissions.
 *
 * `notReconciled` distinguishes "this role has no specification" from "this role has
 * a specification and already matches it", so a caller can tell a genuine no-op from
 * a role it does not own.
 */
export interface RoleReconciliation {
  /** True when Discord was asked to change the role's permissions. */
  readonly changed: boolean;
  /** True when the role has no specification to verify against. */
  readonly notReconciled: boolean;
  /** Every requirement the role does not currently meet. */
  readonly differences: readonly MuteRoleDifference[];
  /** Denied permissions that the write restored, when a write happened. */
  readonly applied?: readonly string[];
  /** Explains a difference the bot could not correct, or a failed write. */
  readonly error?: string;
}

export interface TrackedSetuperOptions {
  readonly guild: Guild;
  readonly logger: Logger;
  readonly resources: SetupResourceService;
  readonly permissions: SetupPermissionService;
}

const DEFAULT_REASON = "Automatic server setup";

export class TrackedSetuper extends DiscordSetuper {
  private readonly resources: SetupResourceService;
  private readonly setupPermissions: SetupPermissionService;

  public constructor(options: TrackedSetuperOptions) {
    super(options.guild, options.logger);
    this.resources = options.resources;
    this.setupPermissions = options.permissions;
  }

  /**
   * Resolves a resource and records its Discord ID.
   *
   * @param parentId Discord ID of the parent category, when the resource lives
   *                 inside one. `null` places the resource at the guild root.
   */
  public resolveTrackedResource(
    definition: SetupResourceDefinition,
    parentId: string | null = null,
  ): Promise<TrackedResolution> {
    return this.resources.ensure(definition, parentId);
  }

  /**
   * Resolves a role definition and then places it correctly.
   *
   * Ordering is done *after* resolution, and for every origin, for one reason: a
   * freshly created role sits at position 1 (just above `@everyone`), a permission
   * overwrite does not move it, and a role edited by hand can be dragged anywhere.
   * Without this step a server can end up with `@Muted` above the bot's own role, and
   * `/mute` then fails with a permission error that looks like a bot bug. The move is
   * a no-op when the position is already correct, so the operation stays idempotent.
   */
  public async resolveTrackedRole(definition: SetupResourceDefinition): Promise<TrackedResolution<Role>> {
    const resolution = await this.resources.ensureRoleDefinition(definition);
    const placement = await this.placeRoleBelowBot(resolution.resource);
    const note = [placement.detail, placement.error].filter(Boolean).join(" — ");
    if (note === "") {
      return resolution;
    }
    return {
      ...resolution,
      // A move is a repair, so the resolution is reported as recovered rather than as
      // a plain reuse; `/setup validate` then shows the drift it corrected.
      ...(placement.detail === undefined ? {} : { origin: "recovered" as const }),
      detail: [resolution.detail, note].filter(Boolean).join(" — "),
    };
  }

  /**
   * Moves a role below the bot's highest role when it sits at or above it.
   *
   * Discord requires a bot's highest role to be strictly above any role it assigns,
   * so a too-high role makes `/mute` fail even though everything else is correct.
   * Failure to move is reported rather than thrown: the role still exists and still
   * denies the right permissions, and an operator may be deliberately keeping it
   * there.
   */
  private async placeRoleBelowBot(
    role: Role,
  ): Promise<{ detail?: string; error?: string }> {
    const me = this.guild.members.me;
    if (!me) {
      return {};
    }
    const botPosition = me.roles.highest.position;
    if (role.position < botPosition) {
      return {};
    }

    // `botPosition - 1` is always a valid, unoccupied position: it is the slot
    // directly beneath the bot's highest role, and any role that was there is shifted
    // up by Discord rather than overwritten.
    const target = Math.max(1, botPosition - 1);
    try {
      await role.setPosition(target, { reason: DEFAULT_REASON });
      return {
        detail: `moved \`@${role.name}\` from position ${role.position} to ${target}, below the bot's role`,
      };
    } catch (error) {
      return {
        error: `\`@${role.name}\` sits at or above the bot's role and could not be moved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Verifies a managed role's permissions against its declared specification and
   * corrects them when they differ.
   *
   * `ensureRole` is idempotent about *identity* — it finds the role and returns it —
   * but it has never been idempotent about *permissions*: an existing role was
   * returned untouched, so a role created once (or edited by hand later) kept
   * whatever permissions it had. That is how a server ends up with a `Muted` role
   * that permits Send Messages while every command reports success.
   *
   * Only the mute role has a specification, so this returns `notReconciled: true` for
   * any other role rather than inventing rules for it. Discord's two hard constraints
   * are handled here: the target bitfield is computed against the guild's real
   * `@everyone` value, and `diffMuteRole` reports — rather than silently ignores —
   * any bit the bot is not allowed to write.
   */
  public async reconcileRolePermissions(role: Role): Promise<RoleReconciliation> {
    if (role.name.trim().toLowerCase() !== MUTE_ROLE_NAME) {
      return { changed: false, notReconciled: true, differences: [] };
    }

    const me = role.guild.members.me;
    if (!me) {
      return {
        changed: false,
        notReconciled: false,
        differences: [],
        error: "The bot's own membership could not be read, so its permissions are unknown.",
      };
    }

    const diff = diffMuteRole(
      {
        id: role.id,
        name: role.name,
        // `BigInt(...)` at every boundary, not merely where the types say `bigint`:
        // discord.js types `permissions.bitfield` as `number | bigint` and hands back a
        // `number` for a small bitfield, while the specification's math is bigint-only.
        // Mixing them throws `TypeError: Cannot mix BigInt and other types`, which would
        // make verification of an ordinary role fail outright.
        permissionBitfield: BigInt(role.permissions.bitfield),
        position: role.position,
        botHighestPosition: me.roles.highest.position,
      },
      BigInt(role.guild.roles.everyone.permissions.bitfield),
      BigInt(me.permissions.bitfield),
    );

    if (!diff.permissionChangeNeeded) {
      // Permission-unwritable differences are reported by the caller but must not
      // trigger a write: Discord rejects a bitfield containing a bit the bot lacks,
      // so the update would fail for a role that is otherwise fine.
      return {
        changed: false,
        notReconciled: false,
        differences: diff.differences,
        ...(diff.differences.length === 0
          ? {}
          : { error: diff.differences.map((entry) => entry.detail).join(" ") }),
      };
    }

    try {
      // Constructed from a bigint, never from an array: discord.js resolves an array
      // member through `resolve()`, which coerces a bigint to its decimal string and
      // silently resolves it to the wrong permission.
      await role.setPermissions(new PermissionsBitField(diff.targetBitfield), DEFAULT_REASON);
    } catch (error) {
      return {
        changed: false,
        notReconciled: false,
        differences: diff.differences,
        error: `The Muted role's permissions could not be updated: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      changed: true,
      notReconciled: false,
      differences: diff.differences,
      ...(diff.missingDenies.length === 0 ? {} : { applied: diff.missingDenies }),
    };
  }

  /** @returns the stored Discord ID for a resource key, or `null`. */
  public resolveKey(key: string): Promise<string | null> {
    return this.resources.resolve(key);
  }

  /**
   * Applies declarative permission overwrites to an already-resolved channel.
   *
   * @returns the number of overwrites that were written or removed.
   */
  public async applyPermissionDiff(
    resource: CategoryChannel | TextChannel | Role,
    overwrites: readonly SetupPermissionOverwrite[],
  ): Promise<number> {
    if (!isOverwritable(resource)) {
      // Roles use a different authorization model; V2 creates no managed role yet,
      // and silently doing nothing is correct until one exists.
      return 0;
    }
    const channel = resource;

    const plans = await this.setupPermissions.planOverwrites(channel.guild, overwrites);
    let applied = 0;

    for (const plan of plans) {
      try {
        if (plan.remove) {
          await channel.permissionOverwrites.delete(plan.overwriteId, DEFAULT_REASON);
          applied += 1;
          continue;
        }
        await channel.permissionOverwrites.edit(plan.overwriteId, plan.options, {
          reason: plan.reason,
        });
        applied += 1;
      } catch (error) {
        // A failure on one overwrite aborts this step loudly: silently skipping a
        // permission rule could leave a channel readable by the wrong audience.
        throw new DiscordApiError(`Failed to apply a permission overwrite on ${channel.id}`, {
          cause: error,
          code: "PERMISSION_OVERWRITE_FAILED",
          metadata: { resourceId: channel.id, overwriteId: plan.overwriteId },
        });
      }
    }

    return applied;
  }

  /**
   * Creates the channel described by a registry entry.
   *
   * Channel creation stays in the Setuper so the resource service only deals with
   * identity, and so `DiscordSetuper` remains the single place that talks to the
   * channel API.
   */
  public async createFromDefinition(
    definition: SetupResourceDefinition,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel> {
    switch (definition.type) {
      case "CATEGORY": {
        const { resource } = await this.ensureCategory({
          name: definition.name,
          reason: DEFAULT_REASON,
        });
        return resource;
      }
      case "TEXT_CHANNEL": {
        const { resource } = await this.ensureTextChannel({
          name: definition.name,
          parentId,
          ...(definition.topic === undefined ? {} : { topic: definition.topic }),
          reason: DEFAULT_REASON,
        });
        return resource;
      }
      case "VOICE_CHANNEL":
        return this.createVoiceChannel(definition.name, parentId);
      default:
        throw new ValidationError(`Cannot create a channel for resource type ${definition.type}`, {
          key: definition.key,
        });
    }
  }

  /** Creates a managed role declared by the registry. */
  public async createRoleFromDefinition(definition: SetupResourceDefinition): Promise<Role> {
    const { resource } = await this.ensureRole({
      name: definition.name,
      permissions: definition.rolePermissions ?? [],
      hoist: false,
      mentionable: false,
      reason: definition.reason ?? DEFAULT_REASON,
    });
    return resource;
  }
  private async createVoiceChannel(name: string, parentId: string | null): Promise<TextChannel> {
    try {
      const channel = await this.guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        ...(parentId === null ? {} : { parent: parentId }),
        reason: DEFAULT_REASON,
      });
      return channel as unknown as TextChannel;
    } catch (error) {
      throw new DiscordApiError(`Failed to create voice channel ${name}`, {
        cause: error,
        code: "CHANNEL_CREATE_FAILED",
      });
    }
  }
}

/**
 * Permissions the setup system must never grant to a resource it creates.
 *
 * Kept as named exports rather than inlined so the permission service and the
 * tests share one definition of "excessive".
 */
export const FORBIDDEN_SETUP_PERMISSION_NAMES: readonly string[] = ["Administrator"];

export const FORBIDDEN_SETUP_PERMISSIONS: readonly bigint[] = [PermissionFlagsBits.Administrator];

/** @returns true when the resource supports permission overwrites. */
function isOverwritable(
  resource: CategoryChannel | TextChannel | Role,
): resource is CategoryChannel | TextChannel {
  return (
    "permissionOverwrites" in resource &&
    (resource.type === ChannelType.GuildText || resource.type === ChannelType.GuildCategory)
  );
}
