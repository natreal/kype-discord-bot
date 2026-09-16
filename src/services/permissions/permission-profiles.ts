/**
 * The bot's Discord permission model.
 *
 * The project intentionally supports two installation profiles:
 *
 * 1. `recommended` — least privilege. Every feature works, including anti-nuke,
 *    using granular permissions. Preferred for servers the operator does not own.
 * 2. `administrator` — the operator's explicit choice. Anti-nuke genuinely needs
 *    broad permissions (it must be able to undo a mass-delete), and a single
 *    permission keeps onboarding simple.
 *
 * Both profiles are declared here so the invite link, the startup self-check and
 * the permission diagnostics all agree on one source of truth.
 */
import { PermissionFlagsBits, type PermissionResolvable } from "discord.js";

/** Named installation profiles. */
export const INSTALL_PROFILES = ["recommended", "administrator"] as const;

export type InstallProfile = (typeof INSTALL_PROFILES)[number];

/**
 * Granular permissions covering every current and planned feature.
 *
 * `ViewAuditLog` is mandatory for anti-nuke: without it the bot cannot know who
 * performed an action, which makes nuke detection impossible.
 */
export const RECOMMENDED_PERMISSIONS: readonly PermissionResolvable[] = [
  // Core operation
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalStickers,

  // Server configuration and automatic setup
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,

  // Moderation
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,

  // Security (anti-raid / anti-nuke)
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.CreateInstantInvite,

  // Notifications and future voice module
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

/** The `Administrator` shortcut, requested only when the operator asks for it. */
export const ADMINISTRATOR_PERMISSIONS: readonly PermissionResolvable[] = [
  PermissionFlagsBits.Administrator,
];

/** @returns the permissions to request for the given installation profile. */
export function permissionsForProfile(profile: InstallProfile): readonly PermissionResolvable[] {
  return profile === "administrator" ? ADMINISTRATOR_PERMISSIONS : RECOMMENDED_PERMISSIONS;
}

/**
 * Permissions whose absence breaks a whole feature area.
 *
 * Used by the startup self-check to tell the server owner *what* is missing
 * instead of failing silently when Discord rejects an action.
 */
export const CRITICAL_PERMISSIONS: readonly PermissionResolvable[] = [
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
];

/** A human-readable label for a permission bitfield value. */
export function describePermissions(permissions: readonly PermissionResolvable[]): string[] {
  return permissions.map((permission) => String(permission));
}
