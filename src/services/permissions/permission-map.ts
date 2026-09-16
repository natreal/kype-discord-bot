/**
 * Maps named bot permissions onto Discord permissions.
 *
 * Keeping the mapping in one place means a module can be written against
 * `moderation.ban` today and switch to custom role overrides later without
 * touching its logic.
 */
import { PermissionFlagsBits, type PermissionResolvable } from "discord.js";

import type { BotPermission } from "./permissions.js";

const MAP: Readonly<Partial<Record<BotPermission, readonly PermissionResolvable[]>>> = {
  "core.use": [],
  "core.settings": [PermissionFlagsBits.ManageGuild],
  "moderation.view": [PermissionFlagsBits.ModerateMembers],
  "moderation.warn": [PermissionFlagsBits.ModerateMembers],
  "moderation.timeout": [PermissionFlagsBits.ModerateMembers],
  "moderation.kick": [PermissionFlagsBits.KickMembers],
  "moderation.ban": [PermissionFlagsBits.BanMembers],
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
  "setup.run": [PermissionFlagsBits.ManageGuild],
};

/** @returns the Discord permissions implied by the given bot permissions. */
export function botPermissionsForDiscord(
  permissions: readonly BotPermission[],
): readonly PermissionResolvable[] {
  const resolved = new Set<PermissionResolvable>();
  for (const permission of permissions) {
    for (const discordPermission of MAP[permission] ?? []) {
      resolved.add(discordPermission);
    }
  }
  return [...resolved];
}

export { MAP as BOT_PERMISSION_MAP };
