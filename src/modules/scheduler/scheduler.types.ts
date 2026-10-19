/**
 * Scheduler contracts.
 *
 * Every feature that needs something to happen later goes through this module:
 * temporary roles expiring, temporary channels closing, reminders firing, and the
 * automation engine's delayed actions. That is a deliberate constraint, not a
 * convenience — a second timer mechanism would mean a second set of failure
 * modes (not surviving a restart, not being observable, not being cancellable),
 * and the brief requires the deferred work to be one system.
 *
 * The design is a *task table plus a handler registry*:
 *
 *   - `ScheduledTask` (Prisma) is the durable truth: what is due, for which
 *     guild, with which payload, and how many times it has been tried.
 *   - `TaskHandler` is the *behaviour*: how one `kind` of task is executed. A
 *     handler knows nothing about schedules, retries or recurrence; it either
 *     resolves or throws.
 *   - `SchedulerService` is the *engine*: it claims due tasks, invokes the
 *     handler for their kind, and decides what happens next (retry, reschedule,
 *     complete, abandon).
 *
 * Consequences that matter:
 * - Adding a feature that needs deferred work means registering a handler, not
 *   editing the scheduler. `role.expire` and `channel.expire` are just two
 *   entries in the same map.
 * - A handler that throws is not lost: the task stays with `attempts`
 *   incremented and a `lastError`, so a transient Discord failure self-heals and
 *   a permanent one is visible instead of silent.
 */
import type { Logger } from "../../services/logger/index.js";

/** Statuses a task can be in. Mirrors the `status` column. */
export const SCHEDULED_TASK_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

/**
 * Recurrence rule for a repeating task.
 *
 * Fixed-interval only, on purpose. A cron expression is a parser, a timezone
 * question and an unbounded validation surface; every recurring task V6 needs
 * ("sweep every N seconds") is an interval, and an interval cannot be written
 * wrong in a way that silently never fires.
 */
export interface TaskRecurrence {
  /** Interval between runs, in seconds. Must be at least `MIN_RECURRENCE_SECONDS`. */
  readonly everySeconds: number;
}

/** The smallest interval a recurring task may declare (one minute). */
export const MIN_RECURRENCE_SECONDS = 60;

/** A stored task, normalized for the handlers and the service. */
export interface ScheduledTaskRecord {
  readonly id: string;
  readonly guildId: string;
  readonly kind: string;
  readonly dueAt: Date;
  /** Handler-specific payload. Handlers validate it before use. */
  readonly payload: unknown;
  readonly status: ScheduledTaskStatus;
  readonly recurrence: TaskRecurrence | null;
  readonly dedupeKey: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

/**
 * What a handler is given.
 *
 * The handler receives the task *and* a logger already scoped with the guild and
 * task id, so it never has to build context and every log line it emits is
 * attributable to the task that caused it.
 */
export interface TaskHandlerContext {
  readonly task: ScheduledTaskRecord;
  readonly logger: Logger;
}

/**
 * What a handler may return.
 *
 * Returning nothing means "succeeded". A handler that discovers the work is no
 * longer applicable (the member left the guild, the channel was already deleted)
 * must return `skipped` rather than throwing, so the difference between
 * "intentionally nothing to do" and "something went wrong" is preserved in the
 * task's outcome and in the audit trail.
 */
export interface TaskHandlerResult {
  readonly outcome: "done" | "skipped";
  /** Optional detail for the log line, e.g. `already-absent`. */
  readonly detail?: string;
}

/** One registered task kind. */
export interface TaskHandler {
  /** The `kind` string this handler owns, e.g. `role.expire`. */
  readonly kind: string;
  /** Short description, used by `/scheduler list` and diagnostics. */
  readonly description: string;
  /**
   * Executes the task. Throwing means "failed and may be retried"; the service
   * decides whether it still will be.
   */
  run(context: TaskHandlerContext): Promise<TaskHandlerResult | void>;
}

/** Options accepted when scheduling a task. */
export interface ScheduleTaskInput {
  readonly guildId: string;
  readonly kind: string;
  /** Absolute due time, or a delay in seconds from now. */
  readonly dueAt?: Date;
  readonly delaySeconds?: number;
  readonly payload?: unknown;
  /** Fixed-interval recurrence, for tasks that repeat forever. */
  readonly recurrence?: TaskRecurrence | null;
  /**
   * Identity that makes the task replaceable rather than duplicated. Scheduling
   * with the same key again updates the existing task in place, which is what
   * makes "extend this temp role's expiry" an upsert instead of a leak.
   */
  readonly dedupeKey?: string | null;
}

/** Outcome of one `tick()` call, for logging and tests. */
export interface SchedulerTickResult {
  /** Tasks that were claimed in this tick. */
  readonly claimed: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
  /** Tasks that exhausted their attempts and were abandoned. */
  readonly abandoned: number;
}

/** Tuning knobs. Defaults are the intended production values. */
export interface SchedulerOptions {
  /**
   * Fallback cadence, in milliseconds.
   *
   * *Not* the steady-state cadence: the engine is demand-driven, it sleeps until
   * the earliest pending task is due and re-arms early when the process schedules
   * something sooner. This value is only the wait used when the next deadline
   * cannot be read, so a failed lookup retries instead of stopping the engine.
   */
  readonly intervalMs?: number;
  /**
   * How long the engine may sleep when nothing is due, in milliseconds.
   *
   * The cap on every sleep, and the whole sleep when the queue is empty. It exists
   * because a bot that polls on a timer keeps the machine it runs on busy for no
   * reason: with the default, an idle bot wakes once every fifteen minutes instead
   * of once every thirty seconds, and it does no work at all in between. Lower it
   * only if tasks can be inserted into `scheduled_tasks` by something other than
   * this process — work this engine schedules itself wakes it immediately.
   */
  readonly idleIntervalMs?: number;
  /**
   * How long a task may stay `running` before a later boot treats it as stranded.
   *
   * Measured from the *claim*, not from the sleep: a task claimed moments before a
   * crash is recovered, while one a healthy worker is still running is left alone.
   */
  readonly staleGraceMs?: number;
  /** How many due tasks one tick will claim. Bounds a tick's cost. */
  readonly batchSize?: number;
  /** Attempts before a task is abandoned. */
  readonly maxAttempts?: number;
  /** How long after a failure the retry becomes due, in seconds. */
  readonly retryDelaySeconds?: number;
}

/** Defaults, exported so the tests and the docs cannot drift from the code. */
export const SCHEDULER_DEFAULTS = {
  intervalMs: 30_000,
  idleIntervalMs: 15 * 60_000,
  staleGraceMs: 2 * 60_000,
  batchSize: 25,
  maxAttempts: 3,
  retryDelaySeconds: 60,
} as const;
