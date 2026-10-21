/**
 * Runtime requests a running bot can make to its supervisor.
 *
 * The stop marker above is a *launcher* instruction: the supervisor watches it and,
 * when it appears, treats the bot's exit as intentional and exits too. That is the
 * right behaviour for `/stop` — the bot should stay down — and the wrong behaviour
 * for `/restart`, where the desired outcome is exactly what `/stop` suppresses.
 *
 * A restart therefore writes a *different* marker next to the stop one. The
 * supervisor deletes it before relaunching and then crashes through its normal
 * relaunch path, so a restart needs no daemon, no shell and no extra privilege: a
 * command running inside the bot asks the process that owns it to bring it back.
 *
 * Both markers live in the `.run` directory the launcher and the bot already share,
 * which keeps this working for the Windows supervisor, the macOS one and `npm run
 * bot:*` alike — the only assumption is that something is supervising the process.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { clearStopRequest } from "./stop-request.js";

/** Name of the restart marker inside the runtime directory. */
export const RESTART_REQUEST_FILE = "restart.request";

/** Exit code the bot uses when it is restarted on purpose. */
export const RESTART_EXIT_CODE = 76;

/** Absolute path of the restart marker for a project root (defaults to the cwd). */
export function restartRequestPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, ".run", RESTART_REQUEST_FILE);
}

/** Whether a restart has been requested for this project. */
export function isRestartRequested(projectRoot: string = process.cwd()): boolean {
  return existsSync(restartRequestPath(projectRoot));
}

/** Removes the restart marker, ignoring an already-absent file. */
export function clearRestartRequest(projectRoot: string = process.cwd()): void {
  try {
    unlinkSync(restartRequestPath(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export interface RestartRequestDetails {
  /** Who asked for the restart, for the log line the supervisor writes. */
  readonly requestedBy: string;
  /** Why, from the command's `reason` option. */
  readonly reason?: string;
}

/**
 * Asks the supervisor to bring the bot back after it exits.
 *
 * A pending *stop* marker is removed first: a stale one would make the supervisor
 * treat this deliberate exit as a stop request and stay down — the exact opposite
 * of what was asked for. The restart marker is written before the shutdown starts,
 * so an operator who restarts a bot that then fails to stop cleanly still gets the
 * restart they asked for.
 *
 * @returns the path of the marker, which the caller reports back to the operator.
 */
export function requestRestart(
  details: RestartRequestDetails,
  projectRoot: string = process.cwd(),
): string {
  const target = restartRequestPath(projectRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  clearStopRequest(projectRoot);
  const payload = {
    requestedBy: details.requestedBy,
    reason: details.reason ?? null,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

/** @returns true when this project has a supervision mechanism a restart can use. */
export function hasSupervisor(projectRoot: string = process.cwd()): boolean {
  const candidates = [
    // The Windows supervisor and `botctl.ps1`.
    path.join(projectRoot, "scripts", "windows", "supervisor.ps1"),
    // The macOS supervisor and `botctl.sh`.
    path.join(projectRoot, "scripts", "desktop", "supervisor.sh"),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}
export { isStopRequested, stopRequestPath } from "./stop-request.js";
