/**
 * Invite-link generation.
 *
 * A pre-configured invite removes the most common installation failure: the
 * operator ticks the wrong boxes in Discord's OAuth2 URL generator. The link is
 * derived from the same permission profile the code uses, so the two cannot drift.
 */
import { PermissionsBitField } from "discord.js";

import {
  permissionsForProfile,
  type InstallProfile,
} from "../services/permissions/permission-profiles.js";

/** Discord's OAuth2 scopes required for a bot that registers commands. */
export const REQUIRED_SCOPES = ["bot", "applications.commands"] as const;

export interface InviteLinkOptions {
  /** Application (client) ID. */
  readonly clientId: string;
  /** Permission profile to request. Defaults to `recommended`. */
  readonly profile?: InstallProfile;
  /** Optionally pre-select a guild, so Discord skips the server picker. */
  readonly guildId?: string | undefined;
  /** Disables the "Administrator" elevation prompt. */
  readonly disableGuildSelect?: boolean;
}

/**
 * Builds the OAuth2 invite URL for the bot.
 *
 * @example
 * ```ts
 * buildInviteLink({ clientId: "123456789012345678" });
 * // https://discord.com/oauth2/authorize?client_id=...&permissions=...&scope=bot+applications.commands
 * ```
 */
export function buildInviteLink(options: InviteLinkOptions): string {
  const permissions = new PermissionsBitField(
    permissionsForProfile(options.profile ?? "recommended"),
  );

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("permissions", permissions.bitfield.toString());
  url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));

  if (options.guildId) {
    url.searchParams.set("guild_id", options.guildId);
    url.searchParams.set("disable_guild_select", String(options.disableGuildSelect ?? true));
  }

  return url.toString();
}

/** @returns the decimal permission value for a profile (for docs and logs). */
export function profilePermissionValue(profile: InstallProfile): string {
  return new PermissionsBitField(permissionsForProfile(profile)).bitfield.toString();
}
