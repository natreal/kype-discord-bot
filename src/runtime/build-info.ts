/**
 * Which commit the running bot was built from.
 *
 * The complaint this answers is "I deployed, but is the bot *actually* running the
 * new code?" A push, a scheduled deploy and a supervisor restart are three separate
 * events, and without a stamp there is no way to tell a successful rollout from a
 * restart of the previous build.
 *
 * The value is baked at build time by `scripts/write-build-info.mjs`, which runs as
 * part of `npm run build`. It lives in a JSON file rather than an env var on
 * purpose: an env var would be whatever the launcher happened to export, while this
 * file is regenerated only when the code is actually compiled.
 *
 * Reading is defensive by design — a missing or corrupt file (a dev run with `tsx`,
 * a partially cleaned tree) must report "unknown", never throw at startup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Shape written by the build script. */
export interface BuildInfo {
  /** Full commit SHA, or `"unknown"` outside a git checkout. */
  readonly commit: string;
  /** Commit subject, for a human-readable line. */
  readonly subject: string;
  /** ISO timestamp of the build. */
  readonly builtAt: string;
  /** Working tree state at build time (`true` when `git status` was dirty). */
  readonly dirty: boolean;
}

/** Name of the generated file, inside `src/generated` (and `dist/generated`). */
export const BUILD_INFO_FILE = "build-info.json";

/** Resolves `generated/build-info.json` next to this module (works in src and dist). */
export function buildInfoPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This module lives in `…/runtime/`, so `generated` is a sibling directory.
  return path.join(here, "..", "generated", BUILD_INFO_FILE);
}

/** The build stamp, or `null` when the file is absent or unreadable. */
export function readBuildInfo(file: string = buildInfoPath()): BuildInfo | null {
  try {
    if (!existsSync(file)) {
      return null;
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildInfo>;
    if (typeof raw.commit !== "string") {
      return null;
    }
    return {
      commit: raw.commit,
      subject: typeof raw.subject === "string" ? raw.subject : "",
      builtAt: typeof raw.builtAt === "string" ? raw.builtAt : "",
      dirty: raw.dirty === true,
    };
  } catch {
    return null;
  }
}

/**
 * Writes the build stamp. Called by the build script, and safe to call more than
 * once: it always overwrites with the values it is given.
 */
export function writeBuildInfo(info: BuildInfo, file: string = buildInfoPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

/** One-line rendering for `/ai status`, `/about` and diagnostics. */
export function formatBuildInfo(info: BuildInfo | null): string {
  if (!info) {
    return "unknown (no build stamp; run `npm run build`)";
  }
  const short = info.commit === "unknown" ? "unknown" : info.commit.slice(0, 7);
  const dirty = info.dirty ? " · uncommitted changes" : "";
  return `${short}${info.subject ? ` — ${info.subject}` : ""}${dirty}`;
}
