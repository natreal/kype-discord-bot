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

/** A validated rename: either a value to store (`null` clears) or a message to show. */
export type RenameInput = { readonly name: string | null } | { readonly error: string };

/**
 * Validates a display-name input shared by `/roles` and `/staff`.
 *
 * Returns a value rather than throwing so a caller can reply with `errorEmbed` without
 * unwinding an interaction. `name` and `reset` are two spellings of one decision, so
 * "neither" and "both" are rejected instead of guessed at: silently preferring one
 * would make the other a no-op the operator cannot see.
 */
export function readRename(name: string | null, reset: boolean): RenameInput {
  const trimmed = name?.trim() ?? "";

  if (reset && trimmed.length > 0) {
    return { error: "Choose one: a name to set, or `reset` to restore the default." };
  }
  if (reset || trimmed.toLowerCase() === "reset") {
    return { name: null };
  }
  if (trimmed.length === 0) {
    return { error: "Give a name to set, or `reset` to restore the default." };
  }
  // A newline would break out of the single embed line that renders the name.
  if (/\n/.test(trimmed)) {
    return { error: "The name must be a single line." };
  }
  if (trimmed.startsWith("@")) {
    return { error: "Leave the `@` out — the name is a label, not a mention." };
  }
  return { name: trimmed };
}
