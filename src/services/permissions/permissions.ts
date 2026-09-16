/**
 * Bot permission catalog.
 *
 * Two layers exist by design:
 * 1. Discord permissions (`use` requirements on commands) — the authorization
 *    layer that exists today.
 * 2. Bot permissions (`moderation.ban`, `security.lockdown`, ...) — a
 *    namespaced catalog used by future role-override configuration.
 *
 * `PermissionService.can()` evaluates both layers, so modules can be written
 * against bot permissions today and enforce Discord permissions immediately.
 */

/** Namespaced bot permissions, grouped by module. */
export const BOT_PERMISSIONS = [
  "core.use",
  "core.settings",
  "moderation.view",
  "moderation.warn",
  "moderation.timeout",
  "moderation.kick",
  "moderation.ban",
  "moderation.purge",
  "security.view",
  "security.lockdown",
  "security.configure",
  "logging.configure",
  "ai.use",
  "ai.configure",
  "tickets.view",
  "tickets.manage",
  "automation.manage",
  "analytics.view",
  "setup.run",
] as const;

export type BotPermission = (typeof BOT_PERMISSIONS)[number];

const BOT_PERMISSION_SET: ReadonlySet<string> = new Set(BOT_PERMISSIONS);

/** @returns true when `value` is a known bot permission. */
export function isBotPermission(value: string): value is BotPermission {
  return BOT_PERMISSION_SET.has(value);
}

/** Thrown (and caught by callers) when an unknown permission name is used. */
export const UNKNOWN_PERMISSION = "[unknown]" as const;
