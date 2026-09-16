/**
 * Filesystem helpers.
 *
 * All paths are derived from the project root (resolved with `node:path`), never
 * from OS-specific strings. These helpers are the only place that touches `fs`
 * for module discovery, which keeps the loaders testable and portable.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FILE_RULES } from "../config/constants.js";

/** Absolute path to the project root (where `package.json` lives). */
export function projectRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd);
}

/** Absolute path to a folder inside the project root. */
export function fromProjectRoot(...segments: string[]): string {
  return path.join(projectRoot(), ...segments);
}

/**
 * Absolute path to the folder holding command and event modules.
 *
 * Development runs from TypeScript sources (`src`), while production runs the
 * compiled output (`dist`). Deriving the location from this file's own URL means
 * both layouts work without configuration or environment branching.
 *
 * `dist/utils/fs.js` -> `dist`, `src/utils/fs.ts` -> `src`.
 */
export function sourceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Absolute path to `commands/` (or `events/`) inside the module root. */
export function modulesDirectory(...segments: string[]): string {
  return path.join(sourceRoot(), ...segments);
}

/** Normalizes a path to forward slashes so logs look identical on every OS. */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/** @returns true when a filesystem entry is a directory. */
export async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns true when a file should be imported as an application module.
 * Dotfiles, `_`-prefixed files, tests, specs and declarations are skipped.
 */
export function isLoadableModuleFile(fileName: string): boolean {
  if (FILE_RULES.ignoredPrefixes.some((prefix) => fileName.startsWith(prefix))) {
    return false;
  }
  if (FILE_RULES.ignoredSuffixes.some((suffix) => fileName.endsWith(`${suffix}.ts`))) {
    return false;
  }
  if (FILE_RULES.ignoredSuffixes.some((suffix) => fileName.endsWith(`${suffix}.js`))) {
    return false;
  }
  return FILE_RULES.moduleExtensions.some((extension) => fileName.endsWith(extension));
}

/**
 * Recursively collects loadable module files below `directory`.
 *
 * @returns absolute file paths, sorted for deterministic load order.
 */
export async function collectModuleFiles(directory: string): Promise<string[]> {
  if (!(await isDirectory(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectModuleFiles(entryPath)));
    } else if (entry.isFile() && isLoadableModuleFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

/** Imports a module by absolute path using a file URL (Windows safe). */
export async function importModule<T>(filePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(filePath).href;
  return (await import(moduleUrl)) as T;
}

/** Derives a stable module identifier from a file path, relative to a base. */
export function moduleId(filePath: string, baseDirectory: string): string {
  const relative = path.relative(baseDirectory, filePath);
  return toPosixPath(relative).replace(/\.(ts|js)$/, "");
}
