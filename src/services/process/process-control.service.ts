/**
 * Process control for `/stop` and `/restart`.
 *
 * Two very different things are asked for by an operator typing these, and the
 * service keeps them apart instead of pretending they are one "reboot" button:
 *
 * - **stop** — release the Discord connection and the database pool, then exit.
 *   Real work is lost if this is wrong (a shutdown that skips `client.destroy()`
 *   leaves a zombie session), so it always goes through the same orderly path the
 *   launcher's SIGTERM uses.
 * - **restart** — do exactly that, *and* leave a marker behind that tells the
 *   supervisor this exit was intentional and the process must come back.
 *
 * The lifecycle callbacks are injected, not imported: the bootstrap owns the signal
 * handlers and the exit path, and a command must not be able to leave the process in
 * a state the bootstrap does not know about. Everything is observable through the
 * returned record, so a caller can report what it actually asked for rather than
 * assuming it worked.
 */
import { hostname } from "node:os";

import type { Logger } from "../logger/index.js";
import {
  hasSupervisor,
  requestRestart,
  RESTART_EXIT_CODE,
  type RestartRequestDetails,
} from "../../runtime/restart-request.js";

/** What can be done to the process. */
export type ProcessAction = "stop" | "restart";

/** Who asked, and why — recorded in the log line an operator can search for. */
export interface ProcessActionRequest {
  readonly actorId: string;
  readonly actorTag: string;
  readonly guildId: string;
  readonly guildName: string;
  readonly reason?: string | undefined;
}

/**
 * What the bot can say about the process it is running in.
 *
 * Reported honestly, because the alternative — claiming a restart when nothing is
 * supervising the process — produces a bot that stops and never comes back, with a
 * reply in Discord saying it is restarting.
 */
export interface ProcessStatus {
  /** True when a supervisor script is present in this installation. */
  readonly supervised: boolean;
  /** True when the process was started by one of the desktop launchers. */
  readonly launcherManaged: boolean;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
  readonly uptimeMs: number;
  readonly nodeVersion: string;
}

/** How long the reply is given to reach Discord before the process exits. */
export const DEFAULT_SHUTDOWN_DELAY_MS = 1_500;

export interface ProcessControlOptions {
  readonly logger: Logger;
  /** Epoch milliseconds of process start, for uptime reporting. */
  readonly startedAt: number;
  /** The orderly shutdown the bootstrap owns (the SIGTERM path). */
  readonly shutdown: (reason: string) => Promise<void>;
  /** Terminates the process with an exit code. Injected so tests never exit. */
  readonly exit: (code: number) => void;
  /** Writes the restart marker. Defaults to the real `.run` marker. */
  readonly writeRestartRequest?: ((details: RestartRequestDetails) => string) | undefined;
  /** Project root containing `.run` and `scripts`. Defaults to `process.cwd()`. */
  readonly projectRoot?: string | undefined;
  /** Grace period before shutdown starts, so the reply is delivered first. */
  readonly shutdownDelayMs?: number | undefined;
  /** Injected sleep, so tests do not wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Whether a supervisor exists. Defaults to probing `scripts/`. */
  readonly supervised?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

/** What a stop or restart actually did. */
export interface ProcessActionOutcome {
  readonly action: ProcessAction;
  /**
   * True when the request can be honoured: a stop always can, a restart only when
   * something is supervising the process.
   */
  readonly ok: boolean;
  /** Path of the restart marker, when one was written. */
  readonly markerPath?: string;
  /** Why the request was refused, when it was. */
  readonly reason?: string;
}

export class ProcessControlService {
  private readonly options: ProcessControlOptions;
  private readonly logger: Logger;
  private requested = false;

  public constructor(options: ProcessControlOptions) {
    this.options = options;
    this.logger = options.logger.child("process");
  }

  /** @returns the process facts a command may safely show to an operator. */
  public status(): ProcessStatus {
    const now = this.options.now?.() ?? Date.now();
    return {
      supervised: this.isSupervised(),
      launcherManaged: Boolean(process.env.BOT_SUPERVISED ?? process.env.BOT_LAUNCHER),
      pid: process.pid,
      host: hostname(),
      startedAt: this.options.startedAt,
      uptimeMs: now - this.options.startedAt,
      nodeVersion: process.version,
    };
  }

  /**
   * Stops the bot gracefully.
   *
   * Idempotent on purpose: two operators pressing the button at the same time must
   * not produce two shutdowns racing for the same database pool.
   */
  public stop(request: ProcessActionRequest): Promise<ProcessActionOutcome> {
    if (this.requested) {
      return Promise.resolve({
        action: "stop",
        ok: false,
        reason: "A shutdown is already in progress.",
      });
    }
    this.requested = true;
    this.logger.warn("Stop requested from Discord", {
      actor: request.actorTag,
      actorId: request.actorId,
      guild: request.guildName,
      guildId: request.guildId,
      reason: request.reason ?? null,
    });
    this.scheduleExit("stop", "discord-command", 0);
    return Promise.resolve({ action: "stop", ok: true });
  }

  /**
   * Restarts the bot: writes the restart marker, then shuts down.
   *
   * Refused when nothing supervises the process, because the honest outcome of a
   * restart without a supervisor is "stopped forever". The check is the presence of
   * the launcher scripts on disk, which is what the operator installed.
   */
  public restart(request: ProcessActionRequest): Promise<ProcessActionOutcome> {
    if (this.requested) {
      return Promise.resolve({
        action: "restart",
        ok: false,
        reason: "A shutdown is already in progress.",
      });
    }
    if (!this.isSupervised()) {
      return Promise.resolve({
        action: "restart",
        ok: false,
        reason:
          "No supervisor found: this bot was started without the desktop launcher, so a restart would leave it offline. Use `/stop` and start it again with `npm run bot:start`.",
      });
    }

    this.requested = true;
    const details: RestartRequestDetails = {
      requestedBy: `${request.actorTag} (${request.actorId})`,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    };
    const write = this.options.writeRestartRequest ?? ((payload) => requestRestart(payload));
    const markerPath = write(details);

    this.logger.warn("Restart requested from Discord", {
      actor: request.actorTag,
      actorId: request.actorId,
      guild: request.guildName,
      guildId: request.guildId,
      reason: request.reason ?? null,
      marker: markerPath,
    });
    this.scheduleExit("restart", "discord-command", RESTART_EXIT_CODE);
    return Promise.resolve({ action: "restart", ok: true, markerPath });
  }

  /** Runs the orderly shutdown after the grace period, then exits. */
  private scheduleExit(action: ProcessAction, reason: string, code: number): void {
    const sleep = this.options.sleep ?? delay;
    const grace = this.options.shutdownDelayMs ?? DEFAULT_SHUTDOWN_DELAY_MS;

    void (async () => {
      // The reply is sent by the caller; without this pause the process would exit
      // before Discord has flushed the interaction response, and the operator would
      // see "The application did not respond" for an action that actually worked.
      if (grace > 0) {
        await sleep(grace);
      }
      try {
        await this.options.shutdown(action === "restart" ? "restart" : reason);
      } catch (error) {
        this.logger.error("Shutdown failed; exiting anyway", error, { action });
      }
      this.options.exit(code);
    })();
  }

  /** @returns true when something is supervising this process. */
  private isSupervised(): boolean {
    return this.options.supervised ?? hasSupervisor(this.options.projectRoot ?? process.cwd());
  }
}

/** @returns a promise resolved after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
