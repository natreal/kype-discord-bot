/**
 * Automatic command loader.
 *
 * Commands are discovered from `src/commands/**`. Nested folders become
 * categories, so a new command is added by creating a file — never by editing
 * the bootstrap.
 *
 * Expected shape of a command file:
 *
 * ```ts
 * export default defineSlashCommand({
 *   meta: { name: "ping", description: "...", category: "core" },
 *   data: new SlashCommandBuilder().setName("ping").setDescription("..."),
 *   botPermissions: ["core.use"],
 *   execute: async (interaction, context) => { ... },
 * });
 * ```
 */

import type { Logger } from "../services/logger/index.js";
import { ValidationError } from "../utils/errors.js";
import { collectModuleFiles, importModule, moduleId } from "../utils/fs.js";
import type { Command } from "./command.types.js";
import type { CommandRegistry } from "./command.registry.js";

/** Result of a load pass, including files that failed to load. */
export interface CommandLoadReport {
  readonly commands: Command[];
  readonly skipped: string[];
  readonly failures: { moduleId: string; error: unknown }[];
}

export interface CommandLoaderOptions {
  /** Absolute path to the commands directory. Defaults to `<cwd>/src/commands`. */
  readonly directory: string;
  readonly logger: Logger;
}

/** Recursively loads every command module under the configured directory. */
export async function loadCommands(options: CommandLoaderOptions): Promise<CommandLoadReport> {
  const logger = options.logger.child("loader:commands");
  const files = await collectModuleFiles(options.directory);

  const commands: Command[] = [];
  const failures: { moduleId: string; error: unknown }[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const id = moduleId(file, options.directory);

    // Folder-level helpers such as `_shared.ts` are not commands.
    if (isInfrastructureFile(id)) {
      skipped.push(id);
      continue;
    }

    try {
      const moduleExports = await importModule<Record<string, unknown>>(file);
      const command = resolveCommandExport(moduleExports, id);

      if (command === null) {
        // A module without a command export is infrastructure, not an error.
        skipped.push(id);
        logger.debug("Skipped module without a command export", { moduleId: id });
        continue;
      }

      const expectedCategory = id.split("/")[0];

      if (command.category !== expectedCategory) {
        throw new ValidationError(
          `Command "${command.name}" declares category "${command.category}" but lives in "${expectedCategory}". ` +
            `Move the file or update the category so permissions and /help stay consistent.`,
          { moduleId: id },
        );
      }

      commands.push(command);
      logger.debug("Loaded command", { command: command.name, moduleId: id });
    } catch (error) {
      failures.push({ moduleId: id, error });
      logger.error(`Failed to load command from ${id}`, error);
    }
  }

  ensureUniqueNames(commands.map((command) => command.name));

  return { commands, skipped, failures };
}

/** Loads commands and registers them, throwing if any file failed to load. */
export async function loadAndRegisterCommands(
  registry: CommandRegistry,
  options: CommandLoaderOptions,
): Promise<CommandLoadReport> {
  const report = await loadCommands(options);
  registry.registerAll(report.commands);

  if (report.failures.length > 0) {
    const failed = report.failures.map((failure) => failure.moduleId).join(", ");
    throw new ValidationError(`Some command modules failed to load: ${failed}`);
  }

  return report;
}

/**
 * Resolves a command from a module namespace.
 *
 * @returns the command, or `null` when the module exports no command at all
 * (which means it is a helper module, not a malformed command).
 * @throws ValidationError when an export looks like a command but is malformed.
 */
function resolveCommandExport(moduleExports: Record<string, unknown>, id: string): Command | null {
  const candidates = [moduleExports["default"], ...Object.values(moduleExports)].filter(
    (value) => value !== undefined,
  );

  const command = candidates.find(isCommand);
  if (command) {
    return command;
  }

  // A `default` export that is not a command is an authoring mistake; anything
  // else is treated as infrastructure (types, helpers, constants).
  if (moduleExports["default"] !== undefined) {
    throw new ValidationError(`Command module ${id} has an invalid default export`, {
      moduleId: id,
    });
  }

  return null;
}

/** Structural validation of a loaded command object. */
export function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Command> & { execute?: unknown; data?: unknown };
  return (
    typeof candidate.name === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.execute === "function" &&
    typeof candidate.data === "object" &&
    candidate.data !== null
  );
}

function ensureUniqueNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new ValidationError(`Duplicate command name detected during discovery: ${name}`);
    }
    seen.add(name);
  }
}

/**
 * Modules that belong to the loader itself, never to discovery.
 *
 * Everything else without a command export is treated as infrastructure too, so
 * this list only needs the files in the commands root that must never be loaded.
 */
const INFRASTRUCTURE_FILES = [
  "index",
  "command.loader",
  "command.registry",
  "command.types",
  "context",
  "define",
];

function isInfrastructureFile(id: string): boolean {
  // Only files directly inside `src/commands` can be infrastructure; nested
  // files always live in a category folder and are checked by their exports.
  if (id.includes("/")) {
    return false;
  }
  return INFRASTRUCTURE_FILES.includes(id);
}
