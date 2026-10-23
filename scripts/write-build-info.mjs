#!/usr/bin/env node
/**
 * Stamps the build with the commit it came from.
 *
 * Runs as the last step of `npm run build`, so `dist/generated/build-info.json`
 * describes the code that was just compiled. Written in plain Node (no deps, no
 * git library) because it must never be the reason a build fails: any failure —
 * no git, no repo, a detached tree — degrades to `"unknown"` and exits 0.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Two destinations on purpose. `src/generated` is build *input* (and git-ignored),
// while `dist/generated` is what Node actually loads. `tsc --build` is incremental
// and copies nothing but `.ts`, so a JSON written after the compile would exist in
// source and never reach `dist` -- and the runtime would report "unbuilt" on a
// perfectly good build. Writing both removes the ordering dependency entirely.
const targets = [
  path.join(projectRoot, "src", "generated", "build-info.json"),
  path.join(projectRoot, "dist", "generated", "build-info.json"),
];

/** @param {...string} args */
function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

const commit = git("rev-parse", "HEAD") || "unknown";
const subject = commit === "unknown" ? "" : git("log", "-1", "--pretty=%s", "HEAD").slice(0, 200);
const dirty = commit !== "unknown" && git("status", "--porcelain").length > 0;

const info = {
  commit,
  subject,
  builtAt: new Date().toISOString(),
  dirty,
};

const payload = `${JSON.stringify(info, null, 2)}\n`;
for (const target of targets) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, payload, "utf8");
}
process.stdout.write(
  `build-info: ${commit.slice(0, 7)}${dirty ? " (dirty)" : ""} -> ${path.relative(projectRoot, targets[1])}\n`,
);
