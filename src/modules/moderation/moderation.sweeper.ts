/**
 * The expired-punishment sweeper.
 *
 * A mute, a timeout or a temporary ban is only genuinely temporary if something
 * takes it off when the deadline passes. `expiresAt` has been written on every
 * temporary case since V4 for exactly this, and this module is what finally acts on
 * it.
 *
 * It runs as a **recurring scheduler task** rather than an in-process timer, and
 * that choice is the whole design:
 *
 * - the schedule is a row, so a restart resumes the sweep instead of losing it;
 * - the task is observable (`/scheduler list`) and cancellable;
 * - two processes cannot both hold the timer and double-lift, because the
 *   scheduler's claim is a database compare-and-swap.
 *
 * The recurrence is fixed-interval on purpose. A cron expression would be a
 * parser, a timezone question and an unbounded validation surface, and "every N
 * seconds" is the only shape the sweep needs.
 */
import type { Logger } from "../../services/logger/index.js";
import type { SchedulerService } from "../scheduler/scheduler.service.js";
import type {
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerResult,
} from "../scheduler/scheduler.types.js";
import type { ModerationService } from "./moderation.service.js";

/** The task kind this module owns. */
export const MODERATION_SWEEP_TASK_KIND = "moderation.sweep";

/**
 * How often the sweep runs.
 *
 * One minute: the scheduler refuses a shorter recurrence (`MIN_RECURRENCE_SECONDS`),
 * and a punishment that is lifted up to a minute late is indistinguishable from one
 * lifted on time, while sweeping more often would query every guild's cases for no
 * benefit.
 */
export const MODERATION_SWEEP_INTERVAL_SECONDS = 60;

/** Resolves the guild-bound moderation service, or `null` when the bot has left. */
export type ModerationServiceResolver = (guildId: string) => ModerationService | null;

export interface ModerationSweeperDeps {
  readonly scheduler: SchedulerService;
  readonly resolve: ModerationServiceResolver;
  readonly logger: Logger;
  /** Override the recurrence, for tests. */
  readonly everySeconds?: number | undefined;
}

export class ModerationSweeper {
  private readonly scheduler: SchedulerService;
  private readonly resolve: ModerationServiceResolver;
  private readonly logger: Logger;
  private readonly everySeconds: number;

  public constructor(deps: ModerationSweeperDeps) {
    this.scheduler = deps.scheduler;
    this.resolve = deps.resolve;
    this.logger = deps.logger.child("moderation-sweep");
    this.everySeconds = deps.everySeconds ?? MODERATION_SWEEP_INTERVAL_SECONDS;
  }

  /**
   * Registers the handler. Called once at startup, before the scheduler starts, so
   * the first tick already finds it.
   */
  public handler(): TaskHandler {
    return {
      kind: MODERATION_SWEEP_TASK_KIND,
      description: "Lifts mutes, timeouts and temporary bans whose deadline has passed.",
      run: (context) => this.run(context),
    };
  }

  /**
   * Ensures exactly one sweep per guild is scheduled.
   *
   * Keyed on the guild with no expiry, so calling it on every boot is an upsert: a
   * second call reuses the existing task rather than stacking a second sweep.
   */
  public async ensureScheduled(guildId: string): Promise<void> {
    await this.scheduler.schedule({
      guildId,
      kind: MODERATION_SWEEP_TASK_KIND,
      // First run one interval out: a tick during startup would compete with the
      // recovery work that is already running there.
      delaySeconds: this.everySeconds,
      recurrence: { everySeconds: this.everySeconds },
      dedupeKey: `${MODERATION_SWEEP_TASK_KIND}:${guildId}`,
    });
  }

  private async run(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const service = this.resolve(context.task.guildId);
    if (!service) {
      // The bot is no longer in the guild. `skipped` rather than a failure: the task
      // row belongs to a guild that left, and the scheduler's recurrence would
      // otherwise retry it forever.
      this.logger.debug("Skipped sweep for an unavailable guild", {
        guildId: context.task.guildId,
      });
      return { outcome: "skipped", detail: "guild unavailable" };
    }

    const result = await service.liftExpired();
    this.logger.debug("Swept expired punishments", {
      guildId: context.task.guildId,
      ...result,
    });
    return {
      outcome: "done",
      detail: `examined ${result.examined}, lifted ${result.lifted}, closed ${result.closed}, failed ${result.failed}`,
    };
  }
}
