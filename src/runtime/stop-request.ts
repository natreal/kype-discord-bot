/**
 * Cooperative shutdown requests.
 *
 * Windows has no way to deliver `SIGTERM` to a detached console process, so a
 * deployment that wants the bot to close its Discord connection and its database
 * pool cannot simply "kill" it. Instead the launcher writes a small marker file
 * (`.run/stop.request`) and this watcher turns it into the same orderly shutdown
 * path that a `SIGTERM` would trigger.
 *
 * The file is deliberately *not* deleted by the bot: the supervisor reads it
 * after the child exits to decide between "the bot crashed, restart it" and
 * "someone asked it to stop, exit too". The launcher (or the supervisor) owns
 * removing it, and both remove a stale file before the next start.
 */
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

/** Name of the marker file inside the runtime directory. */
export const STOP_REQUEST_FILE = "stop.request";

/** Absolute path of the stop marker for a project root (defaults to the cwd). */
export function stopRequestPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, ".run", STOP_REQUEST_FILE);
}

/** Whether a graceful stop has been requested for this project. */
export function isStopRequested(projectRoot: string = process.cwd()): boolean {
  return existsSync(stopRequestPath(projectRoot));
}

/** Removes the marker, ignoring an already-absent file. */
export function clearStopRequest(projectRoot: string = process.cwd()): void {
  try {
    unlinkSync(stopRequestPath(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export interface StopRequestWatcherOptions {
  /** Invoked once, the first time the marker is seen. */
  onStop: () => void;
  /** Project root containing the `.run` directory. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Poll interval in milliseconds. Defaults to one second. */
  intervalMs?: number;
}

export interface StopRequestWatcher {
  /** Stops polling (does not remove the marker). */
  stop(): void;
}

/**
 * Watches for the stop marker and calls `onStop` at most once.
 *
 * The interval is unref'd so that it never keeps a process alive on its own: the
 * Discord gateway is what keeps the bot running, and a bot that has already
 * failed to start must still be able to exit.
 */
export function watchStopRequest(options: StopRequestWatcherOptions): StopRequestWatcher {
  const projectRoot = options.projectRoot ?? process.cwd();
  const intervalMs = options.intervalMs ?? 1_000;
  let fired = false;

  const timer = setInterval(() => {
    if (fired || !isStopRequested(projectRoot)) {
      return;
    }
    fired = true;
    options.onStop();
  }, intervalMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
