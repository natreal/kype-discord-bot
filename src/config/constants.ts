/**
 * Shared, non-secret application constants.
 *
 * Magic strings live here so that modules, commands and services stay in sync.
 */

/** Bot identity used in user-facing embed footers and author names. */
export const BOT_NAME = "Discord Bot Platform";

/** Root folder that is recursively scanned for command and event files. */
export const PATHS = {
  /** Directory holding command modules, relative to the project root. */
  commands: "commands",
  /** Directory holding event modules, relative to the project root. */
  events: "events",
} as const;

/** Glob-free, cross-platform source file matching rules. */
export const FILE_RULES = {
  /** Extensions treated as loadable modules when scanning source folders. */
  moduleExtensions: [".ts", ".js"] as const,
  /** Test/spec/declaration files are never loaded as modules. */
  ignoredPrefixes: [".", "_"] as const,
  ignoredSuffixes: [".test", ".spec", ".d"] as const,
} as const;

/** Command categories, in the order they are shown by `/help`. */
export const COMMAND_CATEGORIES = [
  "core",
  "utility",
  "moderation",
  "security",
  "logging",
  "tickets",
  "ai",
] as const;

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/** Localized strings emitted by the foundation commands. */
export const COPY = {
  genericErrorTitle: "Something went wrong",
  genericErrorMessage:
    "The command could not be completed. The error has been logged and the team will look into it.",
  permissionDeniedTitle: "Permission denied",
  permissionDeniedMessage: "You do not have permission to use this command.",
  guildOnlyTitle: "Server only",
  guildOnlyMessage: "This command can only be used inside a server.",
} as const;
