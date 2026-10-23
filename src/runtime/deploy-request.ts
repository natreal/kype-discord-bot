/**
 * A request from the bot that the host deploy itself.
 *
 * The bot cannot run `deploy.ps1` for two structural reasons: the script stops the
 * bot as its first mutating step (so the process running the command would kill
 * itself mid-interaction), and running `git merge` + `npm ci` from a Discord
 * command is a remote-code-execution surface no command should own. What the bot
 * *can* do is leave a note.
 *
 * The note is `.run/deploy.request`, written next to the stop and restart markers.
 * The scheduled `deploy.ps1` task — already ticking every minute, already owning
 * the deploy lock, the rollback and the health check — consumes it, bumps its retry
 * guard and deploys. The bot never executes anything; it asks the process that
 * already has the privilege and is already designed for the job.
 *
 * Deleting the marker is the consumer's job, exactly like the stop marker: the bot
 * writing and then deleting it would erase the request during the deploy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Name of the deploy marker inside the runtime directory. */
export const DEPLOY_REQUEST_FILE = "deploy.request";

/** Absolute path of the deploy marker for a project root. */
export function deployRequestPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, ".run", DEPLOY_REQUEST_FILE);
}

/** Who asked for the deploy, and why. Never includes a secret. */
export interface DeployRequestDetails {
  readonly requestedBy: string;
  readonly reason?: string;
}

/** Whether a deploy has been requested and not yet consumed. */
export function isDeployRequested(projectRoot: string = process.cwd()): boolean {
  return existsSync(deployRequestPath(projectRoot));
}

/**
 * Writes the deploy marker.
 *
 * @returns the marker path, which the caller reports back to the operator.
 */
export function requestDeploy(
  details: DeployRequestDetails,
  projectRoot: string = process.cwd(),
): string {
  const target = deployRequestPath(projectRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    requestedBy: details.requestedBy,
    reason: details.reason ?? null,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

/** Reads the pending request, or `null` when absent/corrupt. */
export function readDeployRequest(
  projectRoot: string = process.cwd(),
): { requestedBy: string; requestedAt: string } | null {
  try {
    const raw = JSON.parse(readFileSync(deployRequestPath(projectRoot), "utf8")) as {
      requestedBy?: unknown;
      requestedAt?: unknown;
    };
    return {
      requestedBy: typeof raw.requestedBy === "string" ? raw.requestedBy : "unknown",
      requestedAt: typeof raw.requestedAt === "string" ? raw.requestedAt : "",
    };
  } catch {
    return null;
  }
}
