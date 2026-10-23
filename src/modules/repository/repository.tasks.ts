/**
 * The `repository.refresh` scheduled task (V9).
 *
 * The hourly notification is a **scheduler task**, not an in-process timer, for the
 * same reasons the punishment sweeper is: the schedule is a row, so a restart
 * resumes it instead of losing it; it is observable and cancellable; and two
 * processes cannot both fire it, because the scheduler's claim is a database
 * compare-and-swap.
 *
 * Recurrence is fixed-interval on purpose, and the interval comes from
 * configuration (`GITHUB_POLL_INTERVAL_MINUTES`) rather than from the job: the
 * scheduler only knows fixed intervals, and "every N minutes" is the only shape
 * this job needs. The default is one hour, which is also the granularity at which
 * AnyPS5's own CI republishes its statistics.
 */
import type { SchedulerService } from "../scheduler/scheduler.service.js";
import type { TaskHandler, TaskHandlerContext, TaskHandlerResult } from "../scheduler/scheduler.types.js";
import type { RepositoryMonitorService } from "./repository.service.js";

/** The task kind this module owns. */
export const REPOSITORY_REFRESH_TASK_KIND = "repository.refresh";
/** The scheduler refuses anything below a minute; one hour is the documented default. */
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
export const MIN_REFRESH_INTERVAL_MINUTES = 1;

export interface RepositoryRefreshHandlerOptions {
  readonly scheduler: SchedulerService;
  readonly monitor: RepositoryMonitorService;
  /** Minutes between runs, already clamped by configuration. */
  readonly intervalMinutes: number;
  /** Logged once when the task is first scheduled. */
  readonly intervalSource?: string | undefined;
  /**
   * The guild the process-wide job is filed under.
   *
   * Injected rather than read from `process.env`: `scheduled_tasks.guildId` is a
   * foreign key, so the value must be a guild the bot is actually in, and only the
   * caller knows that. Returns `null` when the bot is in no guild, in which case
   * nothing is scheduled.
   */
  readonly resolveGuildId: () => string | null;
}

/** Builds the handler and the "make sure it is scheduled" function. */
export class RepositoryRefresher {
  private readonly scheduler: SchedulerService;
  private readonly monitor: RepositoryMonitorService;
  private readonly resolveGuildId: () => string | null;
  private readonly intervalSeconds: number;

  public constructor(options: RepositoryRefreshHandlerOptions) {
    this.scheduler = options.scheduler;
    this.monitor = options.monitor;
    this.resolveGuildId = options.resolveGuildId;
    this.intervalSeconds =
      Math.max(Math.trunc(options.intervalMinutes), MIN_REFRESH_INTERVAL_MINUTES) * 60;
  }

  /** Registers the handler. Called once at startup, before the scheduler starts. */
  public handler(): TaskHandler {
    return {
      kind: REPOSITORY_REFRESH_TASK_KIND,
      description: `Records an AnyPS5 snapshot and announces what changed (every ${this.intervalSeconds / 60}m).`,
      run: (context) => this.run(context),
    };
  }

  /**
   * Ensures exactly one refresh is scheduled.
   *
   * Keyed on the repository with no expiry, so calling it on every boot is an
   * upsert: a restart reuses the existing row instead of stacking a second job.
   *
   * @param delaySeconds how long to wait before the first run. Startup passes a
   * small value so the first snapshot is taken soon after boot rather than an hour
   * later; the recorded history then has no hour-long hole after every restart.
   * @returns false when the bot is in no guild, so nothing could be filed.
   */
  public async ensureScheduled(delaySeconds?: number): Promise<boolean> {
    const guildId = this.resolveGuildId();
    if (guildId === null) {
      return false;
    }
    const record = await this.monitor.ensureWatched();
    await this.scheduler.schedule({
      guildId,
      kind: REPOSITORY_REFRESH_TASK_KIND,
      delaySeconds: delaySeconds ?? this.intervalSeconds,
      recurrence: { everySeconds: this.intervalSeconds },
      dedupeKey: `${REPOSITORY_REFRESH_TASK_KIND}:${record.id}`,
      payload: { repositoryId: record.id },
    });
    return true;
  }

  /** Cancels the scheduled refresh, for an operator turning the feature off. */
  public async cancel(): Promise<boolean> {
    const guildId = this.resolveGuildId();
    if (guildId === null) {
      return false;
    }
    const record = await this.monitor.ensureWatched();
    return this.scheduler.cancelByKey(guildId, `${REPOSITORY_REFRESH_TASK_KIND}:${record.id}`);
  }

  private async run(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const report = await this.monitor.refresh();
    context.logger.debug("Repository refreshed", { ...report, capturedAt: report.capturedAt.toISOString() });
    return {
      outcome: "done",
      detail: [
        report.baseline ? "baseline" : `${report.announced} event(s)`,
        report.librariesPercent === null ? "no progress data" : `libraries ${report.librariesPercent}%`,
        report.failures.length === 0 ? "all sources ok" : `failed: ${report.failures.join(",")}`,
      ].join(", "),
    };
  }
}


/**
 * The guild a process-wide job is filed under.
 *
 * `scheduled_tasks.guildId` is a foreign key, so a job that belongs to no server
 * cannot use a real ID: filing it under whichever guild happened to boot first
 * would make it vanish when that guild left, and it cannot be `NULL` without a
 * migration plus a looser claim query.
 *
 * The consequence, accepted deliberately: the hourly job needs at least one guild
 * to exist. `startRepositoryMonitor` therefore only schedules it when the bot is in
 * a server, and `/github` says so plainly instead of pretending the monitor is
 * running.
 *
 * A monitor is a deployment concern rather than a per-server setting, so a single
 * row is the right cardinality however many servers the bot serves.
 *
 * The IDs come from the caller through {@link RepositoryRefreshHandlerOptions.resolveGuildId}:
 * reading them from the environment produced `"0"`, which the foreign key rejects.
 */
