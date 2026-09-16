/**
 * Shared embed builders used by foundation commands.
 *
 * Keeping presentation in one place means a future localization pass only has to
 * touch this file plus the constants module.
 */
import { EmbedBuilder } from "discord.js";

import { BOT_NAME } from "../config/constants.js";

/** Standard success embed. */
export function infoEmbed(title: string, description?: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setTimestamp();
  if (description) {
    embed.setDescription(description);
  }
  return embed;
}

/** Standard warning/error embed shown to users. */
export function errorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

/** Embed with a consistent footer identifying the bot. */
export function brandedEmbed(title: string): EmbedBuilder {
  return infoEmbed(title).setFooter({ text: BOT_NAME });
}

/** Formats a duration in milliseconds as a compact human-readable string. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [
    days > 0 ? `${days}d` : undefined,
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
    `${seconds}s`,
  ].filter((part): part is string => part !== undefined);

  return parts.join(" ");
}

/** Formats a byte count as MB/GB. */
export function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_024 / 1_024;
  return megabytes >= 1_024 ? `${(megabytes / 1_024).toFixed(2)} GB` : `${megabytes.toFixed(1)} MB`;
}
