/**
 * Environment variable loading.
 *
 * `.env` is loaded exactly once, at process start, before anything else reads
 * `process.env`. Every other part of the application reads configuration from
 * the validated config layer in `src/config`, never from `process.env`.
 */
import { existsSync } from "node:fs";

import dotenv from "dotenv";

let loaded = false;

/**
 * Loads `.env` into `process.env` if the file exists.
 *
 * Real environment variables always win: dotenv never overwrites values that
 * are already present. That keeps container/CI configuration authoritative.
 */
export function loadEnvironmentFiles(cwd: string = process.cwd()): void {
  if (loaded) {
    return;
  }

  const envPath = process.env["ENV_FILE"] ?? `${cwd}/.env`;
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }

  loaded = true;
}

/** Test helper: allows `.env` to be re-read in a fresh test process. */
export function resetEnvironmentFilesForTesting(): void {
  loaded = false;
}
