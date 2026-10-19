/**
 * The scheduler engine.
 *
 * One instance per process. It owns three things and nothing else:
 *
 * 1. **Claiming** — asking the repository for work that is due, in bounded
 *    batches, so a backlog cannot make one tick run forever.
 * 2. **Dispatching** — looking the task's `kind` up in the handler registry and
 *    invoking it. The service never knows what any particular task *does*.
 * 3. **Deciding the outcome** — after a handler runs, resolving the task's next
 *    state: complete, reschedule (recurrence), retry (transient failure) or
 *    abandon (attempts exhausted).
 *
 * Everything that could go wrong while running a handler is contained: one
 * failing task never stops the tick, never prevents the remaining claimed tasks
 * from running, and never escapes as an unhandled rejection. That property is why
 * a broken handler cannot take the bot's deferred work down with it.
 *
 * Concurrency: `tick()` is re-entrant-safe by a simple `ticking` flag. The flag is
 * not the correctness mechanism (the repository's conditional claim is); it just
 * stops a slow tick from overlapping with the next wake-up and doubling the load.
 *
 * **When it runs: on demand, never on a timer.** A `setInterval(…, 30_000)` poll —
 * the obvious implementation — keeps the machine the bot runs on awake forever,
 * because a process that wakes every thirty seconds never idles, whether or not
 * there is anything to do. Instead, after every batch the engine asks `nextDue()`
 * when the earliest pending task is due and arms exactly *one* wake-up for that
 * moment; work it schedules itself brings that wake-up forward. An idle bot
 * therefore does no database work at all between deadlines, while the deadlines
 * themselves are still met to the second. `idleIntervalMs` is the safety net: the
 * longest it will ever sleep, so a row inserted by something other than this
 * process is still noticed.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import { toError, ValidationError } from "../../utils/errors.js";
import type { ScheduledTaskRepository } from "./scheduler.repository.js";
import type {
  ScheduleTaskInput,
  ScheduledTaskRecord,
  SchedulerOptions,
  SchedulerTickResult,
  TaskRecurrence,
} from "./scheduler.types.js";
import { MIN_RECURRENCE_SECONDS, SCHEDULER_DEFAULTS } from "./scheduler.types.js";
import type { TaskHandlerRegistry } from "./task-registry.js";

/** Dependencies the engine needs. All are ports, so it is fully testable. */
export interface SchedulerServiceDeps {
  readonly repository: ScheduledTaskRepository;
  readonly registry: TaskHandlerRegistry;
  readonly logger: Logger;
  /** Optional: when supplied, an abandoned task is recorded for the guild. */
  readonly audit?: AuditEventService | undefined;
  readonly options?: SchedulerOptions | undefined;
}

/** Audit action recorded when a task fails for good. */
const AUDIT_ACTION_ABANDONED = "scheduler.task.abandoned";

export class SchedulerService {
  private readonly repository: ScheduledTaskRepository;
  private readonly registry: TaskHandlerRegistry;
  private readonly logger: Logger;
  private readonly audit: AuditEventService | undefined;
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly staleGraceMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelaySeconds: number;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private started = false;
  /** Epoch millis of the armed wake-up; `Infinity` while nothing is armed. */
  private nextWakeAt = Number.POSITIVE_INFINITY;

  public constructor(deps: SchedulerServiceDeps) {
    this.repository = deps.repository;
    this.registry = deps.registry;
    this.logger = deps.logger.child("scheduler");
    this.audit = deps.audit;
    const options = deps.options ?? {};
    this.intervalMs = options.intervalMs ?? SCHEDULER_DEFAULTS.intervalMs;
    // Floored so a nonsensical value cannot turn the idle sleep into a busy loop.
    this.idleIntervalMs = Math.max(
      options.idleIntervalMs ?? SCHEDULER_DEFAULTS.idleIntervalMs,
      MIN_WAIT_MS,
    );
    this.staleGraceMs = options.staleGraceMs ?? SCHEDULER_DEFAULTS.staleGraceMs;
    this.batchSize = options.batchSize ?? SCHEDULER_DEFAULTS.batchSize;
    this.maxAttempts = options.maxAttempts ?? SCHEDULER_DEFAULTS.maxAttempts;
    this.retryDelaySeconds = options.retryDelaySeconds ?? SCHEDULER_DEFAULTS.retryDelaySeconds;
  }

  /** Registered kinds, for `/scheduler list` and diagnostics. */
  public get registeredKinds(): readonly string[] {
    return this.registry.kinds();
  }

  public get isRunning(): boolean {
    return this.started;
  }

  /**
   * Schedules work, replacing any pending task with the same dedupe key.
   *
   * Validation happens here rather than in the repository so a caller cannot
   * create a task that can never run: an unregistered kind, a due time in neither
   * form, or a recurrence below the minimum are all rejected before a row exists.
   */
  public async schedule(input: ScheduleTaskInput): Promise<ScheduledTaskRecord> {
    if (!this.registry.has(input.kind)) {
      // Fail closed: refusing to store the row is what keeps "a task exists but
      // nothing will ever run it" from being a reachable state.
      throw new ValidationError(
        `Unknown scheduled task kind "${input.kind}". Registered kinds: ${
          this.registry.kinds().join(", ") || "none"
        }.`,
        { kind: input.kind },
      );
    }

    const dueAt = resolveDueAt(input);
    const recurrence = this.validateRecurrence(input.recurrence ?? null);

    const task = await this.repository.upsert({
      guildId: input.guildId,
      kind: input.kind,
      dueAt,
      payload: input.payload ?? {},
      recurrence,
      dedupeKey: input.dedupeKey ?? null,
    });

    this.logger.debug("Scheduled task", {
      guildId: input.guildId,
      taskId: task.id,
      kind: task.kind,
      dueAt: task.dueAt.toISOString(),
      ...(task.dedupeKey === null ? {} : { dedupeKey: task.dedupeKey }),
    });
    // Work that falls due before the armed wake-up must not wait for it.
    this.wake(task.dueAt);
    return task;
  }

  /** Schedules many tasks in order, stopping at the first rejection. */
  public async scheduleAll(inputs: readonly ScheduleTaskInput[]): Promise<ScheduledTaskRecord[]> {
    const created: ScheduledTaskRecord[] = [];
    for (const input of inputs) {
      created.push(await this.schedule(input));
    }
    return created;
  }

  /** Cancels a task by id. Returns whether anything was cancelled. */
  public async cancel(taskId: string): Promise<boolean> {
    return this.repository.cancel(taskId);
  }

  /** Cancels the pending task with a dedupe key, if it exists. */
  public async cancelByKey(guildId: string, dedupeKey: string): Promise<boolean> {
    return this.repository.cancelByDedupeKey(guildId, dedupeKey);
  }

  public listPending(guildId: string, limit = 25): Promise<ScheduledTaskRecord[]> {
    return this.repository.listPending(guildId, limit);
  }

  public countByStatus(guildId: string): Promise<Record<string, number>> {
    return this.repository.countByStatus(guildId);
  }

  /**
   * Runs one batch of due work and reports what happened.
   *
   * Public so a test can drive it deterministically, and so startup can drain a
   * backlog once without waiting for the first interval.
   */
  public async tick(now: Date = new Date()): Promise<SchedulerTickResult> {
    // A tick that is already running must not be joined: the batches are disjoint
    // by construction, so a second concurrent tick adds no throughput and only
    // doubles the API pressure.
    if (this.ticking) {
      return EMPTY_TICK;
    }
    this.ticking = true;

    try {
      const due = await this.repository.claimDue(now, this.batchSize);
      if (due.length === 0) {
        return EMPTY_TICK;
      }

      let succeeded = 0;
      let skipped = 0;
      let failed = 0;
      let abandoned = 0;

      // Sequential, not `Promise.all`: a burst of simultaneous Discord writes is
      // exactly how a bot walks into a global rate limit, and one task's outcome
      // should never depend on another's timing.
      for (const task of due) {
        const outcome = await this.runTask(task, now);
        switch (outcome) {
          case "done":
            succeeded += 1;
            break;
          case "skipped":
            skipped += 1;
            break;
          case "abandoned":
            abandoned += 1;
            failed += 1;
            break;
          case "failed":
            failed += 1;
            break;
        }
      }

      this.logger.debug("Scheduler tick complete", {
        claimed: due.length,
        succeeded,
        skipped,
        failed,
        abandoned,
      });

      return { claimed: due.length, succeeded, skipped, failed, abandoned };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Starts the engine and recovers work stranded by a previous crash.
   *
   * Recovery runs first so a task that was mid-flight when the process died is
   * not invisible until someone notices by hand.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      const grace = new Date(Date.now() - this.staleGraceMs);
      const recovered = await this.repository.recoverStale(grace);
      if (recovered > 0) {
        this.logger.warn("Recovered tasks left running by a previous process", { recovered });
      }
    } catch (error) {
      // Recovery failing must not stop the bot from starting: the cycle below
      // still runs new work, and the failure is logged with its cause.
      this.logger.error("Failed to recover stale scheduled tasks", error);
    }

    this.logger.info("Scheduler started", {
      // Deliberately not called `intervalMs`: there is no interval any more, and an
      // operator reading this line should see the cadence the engine actually has.
      idleIntervalMs: this.idleIntervalMs,
      fallbackIntervalMs: this.intervalMs,
      staleGraceMs: this.staleGraceMs,
      batchSize: this.batchSize,
      kinds: this.registry.kinds(),
    });

    // Drain whatever is already due rather than waiting for the armed wake-up.
    void this.cycle();
  }

  /** Stops the engine. Work already claimed finishes; nothing new is armed. */
  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextWakeAt = Number.POSITIVE_INFINITY;
    this.started = false;
    this.logger.info("Scheduler stopped");
  }

  /**
   * Runs one batch of due work, then sleeps until the next deadline.
   *
   * Every path through here ends in `arm(...)`, including the failing one: an
   * engine that stopped arming after an error would silently stop running deferred
   * work, which is the one thing this module exists to prevent.
   */
  private async cycle(): Promise<void> {
    try {
      const result = await this.tick();
      if (result.claimed >= this.batchSize) {
        // A full batch means more work may already be due: drain it instead of
        // sleeping, so a backlog costs one wake-up rather than one per batch.
        this.arm(MIN_WAIT_MS);
        return;
      }
      this.arm(await this.delayUntilNextDue());
    } catch (error) {
      this.logger.error("Scheduler tick failed", error);
      this.arm(this.intervalMs);
    }
  }

  /** @returns how long to sleep, floored so a just-passed deadline re-ticks. */
  private async delayUntilNextDue(): Promise<number> {
    let next: Date | null;
    try {
      next = await this.repository.nextDue();
    } catch (error) {
      // An unreadable schedule is a reason to look again sooner, not to stop.
      this.logger.warn("Could not read the next scheduled task", {
        reason: toError(error).message,
      });
      return this.intervalMs;
    }
    if (next === null) {
      // Nothing is scheduled at all. That is the ordinary state of a healthy bot,
      // and the reason it does nothing whatsoever in between deadlines.
      return this.idleIntervalMs;
    }
    // The floor keeps a deadline that has just passed from becoming a busy loop;
    // the cap means a row inserted by something other than this process — or a
    // system clock that jumped — is still noticed.
    return Math.min(Math.max(next.getTime() - Date.now(), MIN_WAIT_MS), this.idleIntervalMs);
  }

  /** Arms the single wake-up, replacing whatever was armed before it. */
  private arm(delayMs: number): void {
    if (!this.started) {
      // A cycle that finishes after `stop()` must not resurrect the timer.
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = Math.max(delayMs, 0);
    this.nextWakeAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      void this.cycle();
    }, delay);
    // The wake-up must never hold the process open: the bot's lifetime is the
    // Discord client's, not the scheduler's.
    this.timer.unref?.();
  }

  /**
   * Brings the wake-up forward when work is scheduled that falls due sooner.
   *
   * Only an *earlier* deadline re-arms: doing it for every later one would turn a
   * burst of scheduling into a burst of ticks, and the engine recomputes the
   * deadline after its next batch anyway.
   */
  private wake(dueAt: Date): void {
    if (!this.started || dueAt.getTime() >= this.nextWakeAt) {
      return;
    }
    this.arm(MIN_WAIT_MS);
  }

  /**
   * Executes one claimed task and applies the outcome policy.
   *
   * Returns the outcome so `tick()` can count it. Never throws: a handler failure
   * is a task failure, and a persistence failure while recording it is logged and
   * swallowed, because there is no useful recovery and the alternative is an
   * unhandled rejection inside a timer.
   */
  private async runTask(
    task: ScheduledTaskRecord,
    now: Date,
  ): Promise<"done" | "skipped" | "failed" | "abandoned"> {
    // `LogContext` carries guild/user/channel only, so the task identity goes into
    // the metadata of each line instead of trying to extend a shared type.
    const logger = this.logger.withContext({ guildId: task.guildId });
    const taskMeta = { taskId: task.id, kind: task.kind };

    const handler = this.registry.find(task.kind);
    if (!handler) {
      // Claimed a task no module handles. This is not ignorable: the task's whole
      // point was to undo something, so it must be reported, not quietly dropped.
      logger.error("Scheduled task has no handler", {
        ...taskMeta,
        registered: this.registry.kinds(),
      });
      await this.failTask(task, `No handler registered for kind "${task.kind}"`, now, true);
      return "abandoned";
    }

    try {
      const result = await handler.run({ task, logger });
      const outcome = result?.outcome ?? "done";
      const detail = result?.detail;

      logger.debug("Scheduled task executed", {
        ...taskMeta,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });

      // A recurring task is never "done": success means "schedule the next run".
      // A task that reported `skipped` still counts as a successful execution, so
      // its recurrence advances rather than stalling.
      //
      // Anchored on the task's own due time, not on `now`: `now` is the tick's
      // clock, and using it would make every late tick push the next occurrence
      // further out. A daily task would then creep forward by however long each
      // run took, without bound.
      if (task.recurrence) {
        await this.repository.reschedule(task.id, nextDueAt(task.recurrence, task.dueAt));
      } else {
        await this.repository.complete(task.id, now);
      }
      return outcome;
    } catch (error) {
      const message = toError(error).message;
      logger.error("Scheduled task failed", error, { attempts: task.attempts + 1 });
      const abandoned = await this.failTask(task, message, now, false);
      return abandoned ? "abandoned" : "failed";
    }
  }

  /**
   * Applies the failure policy and reports whether the task was abandoned.
   *
   * The policy is "retry a few times, then stop and say so". Retrying forever
   * would mean one permanently impossible task (a role that was deleted) burning a
   * Discord call every interval indefinitely; stopping silently would mean the
   * intended effect never happened and nobody knew.
   */
  private async failTask(
    task: ScheduledTaskRecord,
    message: string,
    now: Date,
    handlerMissing: boolean,
  ): Promise<boolean> {
    const attemptsAfterThis = task.attempts + 1;
    // An unregistered kind can never succeed, so it is abandoned immediately
    // rather than burning three retries on a certainty.
    const exhausted = handlerMissing || attemptsAfterThis >= this.maxAttempts;

    try {
      if (exhausted) {
        await this.repository.abandon(task.id, message, now);
        this.logger.error("Abandoning scheduled task", {
          guildId: task.guildId,
          taskId: task.id,
          kind: task.kind,
          attempts: attemptsAfterThis,
          reason: message,
        });
        await this.recordAbandoned(task, message, attemptsAfterThis);
        return true;
      }

      const retryAt = new Date(now.getTime() + this.retryDelaySeconds * 1000);
      await this.repository.recordFailure(task.id, message, retryAt);
      this.logger.warn("Scheduled task will be retried", {
        guildId: task.guildId,
        taskId: task.id,
        kind: task.kind,
        attempts: attemptsAfterThis,
        retryAt: retryAt.toISOString(),
      });
      return false;
    } catch (error) {
      // Recording the failure failed too. The task stays `running`, which the next
      // start's stale recovery returns to `pending` — and the original failure is
      // preserved in the log line above, which is the part that matters.
      this.logger.error("Failed to record a scheduled task failure", error, {
        guildId: task.guildId,
        taskId: task.id,
      });
      return false;
    }
  }

  /** Records an abandoned task in the audit trail, when one is wired up. */
  private async recordAbandoned(
    task: ScheduledTaskRecord,
    reason: string,
    attempts: number,
  ): Promise<void> {
    if (!this.audit) {
      return;
    }
    try {
      await this.audit.record({
        guildId: task.guildId,
        actorId: "system:scheduler",
        // A failed task was performed by the system, not by a person: `system`
        // keeps the audit honest about who is actually responsible.
        actorKind: "system",
        action: AUDIT_ACTION_ABANDONED,
        targetId: task.id,
        // The scheduler is infrastructure, not a moderator: recording it under the
        // system category keeps `/history` and the moderation audit readable.
        category: "system",
        outcome: "failure",
        severity: "warn",
        details: {
          kind: task.kind,
          reason,
          attempts,
          ...(task.dedupeKey === null ? {} : { dedupeKey: task.dedupeKey }),
        },
      });
    } catch (error) {
      this.logger.warn("Failed to audit an abandoned scheduled task", {
        taskId: task.id,
        reason: toError(error).message,
      });
    }
  }

  /** Rejects a recurrence below the minimum, or a non-positive interval. */
  private validateRecurrence(recurrence: TaskRecurrence | null): TaskRecurrence | null {
    if (recurrence === null) {
      return null;
    }
    if (
      !Number.isFinite(recurrence.everySeconds) ||
      recurrence.everySeconds < MIN_RECURRENCE_SECONDS
    ) {
      throw new ValidationError(
        `A recurring task must repeat at least every ${MIN_RECURRENCE_SECONDS} seconds.`,
        { everySeconds: recurrence.everySeconds },
      );
    }
    return { everySeconds: recurrence.everySeconds };
  }
}

/**
 * The shortest wait the engine will arm.
 *
 * Low enough that a deadline which has just passed is picked up on the next tick,
 * high enough that a stale deadline cannot turn the loop into a busy spin.
 */
const MIN_WAIT_MS = 250;

/** A tick with nothing to do. Frozen so a caller cannot mutate the shared value. */
const EMPTY_TICK: SchedulerTickResult = Object.freeze({
  claimed: 0,
  succeeded: 0,
  skipped: 0,
  failed: 0,
  abandoned: 0,
});

/** Resolves the due time from either an absolute date or a delay, requiring one. */
function resolveDueAt(input: ScheduleTaskInput): Date {
  if (input.dueAt) {
    if (Number.isNaN(input.dueAt.getTime())) {
      throw new ValidationError("A scheduled task needs a valid due time.");
    }
    return input.dueAt;
  }
  if (input.delaySeconds !== undefined) {
    if (!Number.isFinite(input.delaySeconds) || input.delaySeconds < 0) {
      throw new ValidationError("A scheduled task delay must be a non-negative number of seconds.");
    }
    return new Date(Date.now() + input.delaySeconds * 1000);
  }
  throw new ValidationError("A scheduled task needs either `dueAt` or `delaySeconds`.");
}

/**
 * The next due time for a recurring task.
 *
 * Anchored on the *previous due time* rather than on `now`: advancing from `from`
 * keeps a 24h task at the same wall-clock time even if a tick ran late, whereas
 * `now + interval` would drift later by however long each tick took. If the
 * computed time is already past (a long outage), it is pushed to the next future
 * occurrence, so a task cannot fire in a burst to catch up on downtime.
 */
function nextDueAt(recurrence: TaskRecurrence, from: Date): Date {
  const intervalMs = recurrence.everySeconds * 1000;
  const candidate = new Date(from.getTime() + intervalMs);
  const now = Date.now();
  if (candidate.getTime() > now) {
    return candidate;
  }
  const missed = Math.ceil((now - candidate.getTime()) / intervalMs);
  return new Date(candidate.getTime() + missed * intervalMs);
}
