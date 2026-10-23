/**
 * Role → permission mapping store.
 *
 * Resolves the *effective* permission classes for a guild by combining the
 * built-ins (`permission-classes.ts`) with the guild's own rows, and by resolving
 * a member's Discord roles to classes.
 *
 * Two rules keep this safe and predictable:
 * - a class only grants granular permissions, never Discord permissions: this
 *   layer cannot escalate beyond what Discord already allows;
 * - class resolution is per guild and per member, with no caching, so a role
 *   change takes effect on the next command rather than after a restart.
 *
 * Unknown stored permission identifiers are dropped *and reported* rather than
 * silently ignored, so a stale row cannot become a permanent mystery denial.
 */
import type { Logger } from "../logger/index.js";
import type {
  PermissionClassRepository,
  PermissionClassRow,
  RoleClassBinding,
} from "./permission-class.repository.js";
import {
  BUILT_IN_PERMISSION_CLASSES,
  type PermissionClassDefinition,
} from "./permission-classes.js";
import { isPermission, type Permission } from "./permissions.js";
import { ValidationError } from "../../utils/errors.js";

/** Facts about a member used to resolve implied classes. */
export interface MemberClassFacts {
  readonly owner: boolean;
  readonly administrator: boolean;
  /** True for the compiled-in owner account. */
  readonly god: boolean;
}

export interface PermissionClassStoreOptions {
  readonly logger: Logger;
  readonly repository: PermissionClassRepository;
}

export class PermissionClassStore {
  private readonly logger: Logger;
  private readonly repository: PermissionClassRepository;

  public constructor(options: PermissionClassStoreOptions) {
    this.logger = options.logger.child("permission-classes");
    this.repository = options.repository;
  }

  /**
   * @returns every class that applies to a member: role bindings plus the
   * classes implied by being the guild owner, an administrator, or the owner
   * account. Highest priority first.
   */
  public async effectiveClasses(
    guildId: string,
    roleIds: readonly string[],
    facts: MemberClassFacts,
  ): Promise<readonly PermissionClassDefinition[]> {
    const [classes, bindings] = await Promise.all([this.list(guildId), this.listBindings(guildId)]);

    const byKey = new Map(classes.map((definition) => [definition.key, definition]));
    const matched = new Set<string>();
    for (const binding of bindings) {
      if (roleIds.includes(binding.roleId) && byKey.has(binding.classKey)) {
        matched.add(binding.classKey);
      }
    }

    const effective = new Map<string, PermissionClassDefinition>();
    for (const key of matched) {
      const definition = byKey.get(key);
      if (definition) {
        effective.set(key, definition);
      }
    }
    for (const definition of implied(byKey, facts)) {
      effective.set(definition.key, definition);
    }

    return [...effective.values()].sort((left, right) => right.priority - left.priority);
  }

  /**
   * @returns only the classes implied by Discord's own authorization.
   *
   * Separate from `effectiveClasses` so diagnostics can report "this member is an
   * administrator" distinctly from "this member holds the Moderator class".
   */
  public async impliedClasses(
    guildId: string,
    facts: { owner: boolean; administrator: boolean },
  ): Promise<readonly PermissionClassDefinition[]> {
    const classes = await this.list(guildId);
    const byKey = new Map(classes.map((definition) => [definition.key, definition]));
    return implied(byKey, { ...facts, god: false });
  }

  /** @returns the classes God Access implies (every built-in). */
  public godClasses(): readonly PermissionClassDefinition[] {
    return BUILT_IN_PERMISSION_CLASSES.map((definition) => ({
      ...definition,
      permissions: [...definition.permissions],
    }));
  }

  /** @returns the guild's effective class definitions, highest priority first. */
  public async list(guildId: string): Promise<readonly PermissionClassDefinition[]> {
    let stored: PermissionClassRow[] = [];
    try {
      stored = await this.repository.listClasses(guildId);
    } catch (error) {
      // A database hiccup must not remove authorization: fall back to built-ins
      // and say so, rather than denying (or granting) blindly.
      this.logger.warn("Failed to read permission classes; using built-ins only", {
        guildId,
        error: String(error),
      });
    }

    const classes = new Map<string, PermissionClassDefinition>();
    for (const definition of BUILT_IN_PERMISSION_CLASSES) {
      classes.set(definition.key, { ...definition, permissions: [...definition.permissions] });
    }

    for (const row of stored) {
      const permissions = row.permissions.filter(isPermission);
      const dropped = row.permissions.filter((value) => !isPermission(value));
      if (dropped.length > 0) {
        this.logger.warn("Stored permission class references unknown permissions", {
          guildId,
          classKey: row.key,
          dropped,
        });
      }
      const builtIn = classes.get(row.key);
      classes.set(row.key, {
        key: row.key,
        name: row.name,
        // The override travels with the stored row, but `name` still wins for
        // resolution so a rename stays purely cosmetic.
        ...(row.displayName === null ? {} : { displayName: row.displayName }),
        description: builtIn?.description ?? "Custom permission class.",
        permissions,
        // A stored row can override a built-in's permissions, but a built-in can
        // never lose its built-in status: the operator must be able to reset it.
        builtIn: builtIn !== undefined || row.builtIn,
        priority: row.priority,
        ...(builtIn?.implied === true ? { implied: true } : {}),
      });
    }

    return [...classes.values()].sort((left, right) => right.priority - left.priority);
  }

  /** @returns the role bindings of a guild. */
  public listBindings(guildId: string): Promise<RoleClassBinding[]> {
    return this.repository.listBindings(guildId);
  }

  /** Binds a Discord role to a permission class. Idempotent. */
  public async bindRole(guildId: string, roleId: string, classKey: string): Promise<void> {
    await this.repository.bindRole(guildId, roleId, classKey);
    this.logger.info("Role bound to permission class", { guildId, roleId, classKey });
  }

  /** Removes a role binding. Idempotent. */
  public async unbindRole(guildId: string, roleId: string, classKey: string): Promise<void> {
    await this.repository.unbindRole(guildId, roleId, classKey);
    this.logger.info("Role unbound from permission class", { guildId, roleId, classKey });
  }

  /**
   * Renames a power level for the whole guild, or clears the override with `null`.
   *
   * Resolves the class first so the repository can create a row for a built-in that has
   * never been stored. A rename still cannot change what the class grants: only
   * `displayName` is written, and the permission list is carried along untouched.
   *
   * @throws `ValidationError` when the guild has no such class.
   */
  public async setClassDisplayName(
    guildId: string,
    key: string,
    displayName: string | null,
  ): Promise<void> {
    const definition = (await this.list(guildId)).find((entry) => entry.key === key);
    if (!definition) {
      throw new ValidationError(`Unknown power level \`${key}\`.`, { key, guildId });
    }
    await this.repository.setClassDisplayName({
      guildId,
      key: definition.key,
      name: definition.name,
      displayName,
      permissions: definition.permissions,
      builtIn: definition.builtIn,
      priority: definition.priority,
    });
    this.logger.info("Permission class display name set", { guildId, key, displayName });
  }

  /** Renames how one role appears, or clears the label with `null`. */
  public async setBindingLabel(
    guildId: string,
    roleId: string,
    label: string | null,
  ): Promise<void> {
    await this.repository.setBindingLabel(guildId, roleId, label);
    this.logger.info("Role binding label set", { guildId, roleId, label });
  }

  /**
   * @returns every role in the guild that is bound to a class granting *any* of the
   * given permissions, de-duplicated.
   *
   * This is what turns a role binding into concrete Discord access: the ticket module
   * uses it to open ticket channels to admins (`administrator`, `bot-manager`) and to
   * the `support` class without requiring the Discord `Administrator` permission, so a
   * server can hand out ticket access through the role → class → permission model
   * instead of hardcoding a single staff role.
   */
  public async roleIdsGranting(
    guildId: string,
    permissions: readonly Permission[],
  ): Promise<string[]> {
    const [classes, bindings] = await Promise.all([this.list(guildId), this.listBindings(guildId)]);

    const wanted = new Set(permissions);
    const classGrants = new Set<string>();
    for (const definition of classes) {
      if (definition.permissions.some((permission) => wanted.has(permission))) {
        classGrants.add(definition.key);
      }
    }

    const roleIds = new Set<string>();
    for (const binding of bindings) {
      if (classGrants.has(binding.classKey)) {
        roleIds.add(binding.roleId);
      }
    }

    return [...roleIds];
  }
}

/** @returns the classes implied by Discord authorization rather than a role. */
function implied(
  byKey: ReadonlyMap<string, PermissionClassDefinition>,
  facts: { owner: boolean; administrator: boolean; god: boolean },
): PermissionClassDefinition[] {
  const result: PermissionClassDefinition[] = [];
  if (facts.god || facts.owner) {
    const owner = byKey.get("owner");
    if (owner) {
      result.push(owner);
    }
  }
  if (facts.god || facts.administrator) {
    const administrator = byKey.get("administrator");
    if (administrator) {
      result.push(administrator);
    }
  }
  return result;
}
