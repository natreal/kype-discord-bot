/**
 * Maps named bot permissions onto Discord permissions.
 *
 * Keeping the mapping in one place means a module can be written against
 * `moderation.ban` today and switch to custom role overrides later without
 * touching its logic.
 *
 * `botPermissionsForDiscord` is intentionally *wider* than the strict catalog
 * mapping: running automatic setup needs management rights for every resource it
 * touches, not just `ManageGuild`. Commands that declare `setup.run` therefore get
 * the complete, accurate requirement instead of a partial one.
 */
import { PermissionFlagsBits, type PermissionResolvable } from "discord.js";

import type { BotPermission } from "./permissions.js";

const MAP: Readonly<Partial<Record<BotPermission, readonly PermissionResolvable[]>>> = {
  "core.use": [],
  "core.settings": [PermissionFlagsBits.ManageGuild],
  "moderation.view": [PermissionFlagsBits.ModerateMembers],
  "moderation.warn": [PermissionFlagsBits.ModerateMembers],
  "moderation.mute": [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageRoles],
  "moderation.timeout": [PermissionFlagsBits.ModerateMembers],
  "moderation.kick": [PermissionFlagsBits.KickMembers],
  "moderation.ban": [PermissionFlagsBits.BanMembers],
  "moderation.unban": [PermissionFlagsBits.BanMembers],
  "moderation.purge": [PermissionFlagsBits.ManageMessages],
  "security.view": [PermissionFlagsBits.ModerateMembers],
  "security.lockdown": [PermissionFlagsBits.ManageChannels],
  "security.configure": [PermissionFlagsBits.ManageGuild],
  "logging.configure": [PermissionFlagsBits.ManageGuild],
  "ai.use": [],
  "ai.configure": [PermissionFlagsBits.ManageGuild],
  "tickets.view": [],
  "tickets.manage": [PermissionFlagsBits.ManageChannels],
  "automation.manage": [PermissionFlagsBits.ManageGuild],
  "analytics.view": [PermissionFlagsBits.ManageGuild],
  "setup.run": [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ],
};

/** Additional Discord permissions implied by a bot permission. */
const ADDITIONAL: Readonly<Partial<Record<BotPermission, readonly PermissionResolvable[]>>> = {};

/** @returns the Discord permissions implied by the given bot permissions. */
export function botPermissionsForDiscord(
  permissions: readonly BotPermission[],
): readonly PermissionResolvable[] {
  const resolved = new Set<PermissionResolvable>();
  for (const permission of permissions) {
    for (const discordPermission of MAP[permission] ?? []) {
      resolved.add(discordPermission);
    }
    for (const discordPermission of ADDITIONAL[permission] ?? []) {
      resolved.add(discordPermission);
    }
  }
  return [...resolved];
}

export { MAP as BOT_PERMISSION_MAP };
