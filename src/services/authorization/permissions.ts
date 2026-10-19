/**
 * Structured permission identifiers (V3).
 *
 * Permissions are values from a closed registry, never free-form strings. That
 * gives three guarantees the V2 catalog could not:
 * - a typo is a load-time error instead of a silently-unsatisfiable check;
 * - a command can declare `Permission.ServerSetup` and get autocompletion and
 *   rename-safety;
 * - role→permission mappings can only reference known identifiers, so a class can
 *   never grant "nothing" by accident.
 *
 * The V2 `BOT_PERMISSIONS` catalog is preserved and *extended* by these
 * identifiers rather than replaced: `isBotPermission` still governs the legacy
 * names, and `toBotPermission` bridges the two so existing commands and the
 * Discord-permission mapping keep working untouched.
 */
import {
  BOT_PERMISSIONS,
  isBotPermission,
  type BotPermission,
} from "../permissions/permissions.js";

/** Every granular permission the platform understands. */
export const PERMISSIONS = [
  // Platform
  "server.setup",
  "server.settings",
  "server.diagnostics",

  // Logging
  "logs.view",
  "logs.configure",

  // Moderation
  "moderation.view",
  "moderation.warn",
  "moderation.mute",
  "moderation.timeout",
  "moderation.kick",
  "moderation.ban",
  "moderation.unban",
  "moderation.purge",

  // Security
  "security.view",
  "security.lockdown",
  "security.configure",

  // Tickets
  "tickets.view",
  "tickets.manage",

  // AI
  "ai.use",
  "ai.configure",

  // Analytics
  "analytics.view",

  // Core
  "core.use",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** @returns true when `value` is a known permission identifier. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/**
 * Legacy V2 bot permission ↔ V3 permission identifier.
 *
 * The mapping is intentionally partial in one direction: V3 adds identifiers
 * (`server.diagnostics`) that have no V2 equivalent, and V2 keeps identifiers
 * (`automation.manage`) that no V3 permission claims yet. Anything unmapped maps
 * to `null` rather than to a guess.
 */
const LEGACY_TO_PERMISSION: Readonly<Partial<Record<BotPermission, Permission>>> = {
  "core.use": "core.use",
  "core.settings": "server.settings",
  "moderation.view": "moderation.view",
  "moderation.warn": "moderation.warn",
  "moderation.timeout": "moderation.timeout",
  "moderation.kick": "moderation.kick",
  "moderation.ban": "moderation.ban",
  "moderation.unban": "moderation.unban",
  "moderation.mute": "moderation.mute",
  "moderation.purge": "moderation.purge",
  "security.view": "security.view",
  "security.lockdown": "security.lockdown",
  "security.configure": "security.configure",
  "logging.configure": "logs.configure",
  "ai.use": "ai.use",
  "ai.configure": "ai.configure",
  "tickets.view": "tickets.view",
  "tickets.manage": "tickets.manage",
  "analytics.view": "analytics.view",
  "setup.run": "server.setup",
};

const PERMISSION_TO_LEGACY: Readonly<Partial<Record<Permission, BotPermission>>> = {
  "core.use": "core.use",
  "server.settings": "core.settings",
  "server.setup": "setup.run",
  "server.diagnostics": "core.settings",
  "logs.configure": "logging.configure",
  "logs.view": "core.settings",
  "analytics.view": "analytics.view",
};

/**
 * @returns the V3 identifier for a legacy bot permission, or `null`.
 *
 * `Permission` is a subset of `BotPermission` for the overlapping names, so the
 * result is also directly usable wherever a `BotPermission` is expected.
 */
export function toPermission(value: string): Permission | null {
  if (isPermission(value)) {
    return value;
  }
  if (isBotPermission(value)) {
    return LEGACY_TO_PERMISSION[value] ?? null;
  }
  return null;
}

/**
 * @returns the legacy bot permission for a V3 identifier, when one exists.
 *
 * Used to keep the Discord-permission mapping (`BOT_PERMISSION_MAP`) and the
 * command-level `botPermissions` declarations authoritative.
 */
export function toBotPermission(permission: Permission): BotPermission | null {
  if (isBotPermission(permission)) {
    return permission;
  }
  return PERMISSION_TO_LEGACY[permission] ?? null;
}

/**
 * Validates a list of identifiers.
 *
 * @returns the unknown identifiers, so a caller can reject a role mapping that
 * references a permission this build does not implement.
 */
export function unknownPermissions(values: readonly string[]): string[] {
  return values.filter((value) => !isPermission(value));
}

/** @returns the identifiers grouped by module prefix, for `/help` and `/settings`. */
export function permissionsByModule(): Readonly<Record<string, readonly Permission[]>> {
  const grouped: Record<string, Permission[]> = {};
  for (const permission of PERMISSIONS) {
    const [module = "core"] = permission.split(".");
    (grouped[module] ??= []).push(permission);
  }
  return grouped;
}

/** Every legacy bot permission name, re-exported for compatibility checks. */
export const LEGACY_BOT_PERMISSIONS: readonly BotPermission[] = BOT_PERMISSIONS;
