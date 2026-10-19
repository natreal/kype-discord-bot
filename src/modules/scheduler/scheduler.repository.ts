/**
 * Scheduler persistence port and its Prisma implementation.
 *
 * The service depends on this port rather than on Prisma directly, exactly as the
 * config layer does, so the scheduler's rules (claiming, retrying, recurrence,
 * abandonment) are testable against an in-memory store. Without that split, the
 * interesting logic — what happens to a task that fails twice and then succeeds —
 * would only be reachable through a database.
 *
 * The one operation with real semantics is `claimDue`. It must be *atomic* with
 * respect to concurrent workers: two bots sharing a database must never both run
 * the same task. The Prisma implementation does that with a conditional update
 * loop (claim by id, but only while the row is still `pending`), which is a
 * compare-and-swap and therefore safe with two instances and no distributed lock.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError, toJson, toNullableJson } from "../../services/database/index.js";
import type {
  ScheduledTaskRecord,
  ScheduledTaskStatus,
  TaskRecurrence,
} from "./scheduler.types.js";

export interface ScheduledTaskRepository {
  /**
   * Atomically transitions up to `limit` tasks whose `dueAt` has passed from
   * `pending` to `running`, and returns them. Concurrency-safe: a task is
   * returned to at most one caller.
   */
  claimDue(now: Date, limit: number): Promise<ScheduledTaskRecord[]>;

  /**
   * @returns the earliest deadline among the pending tasks, or `null` when none is
   * scheduled at all.
   *
   * This is what makes the engine demand-driven instead of poll-driven: it sleeps
   * until this instant rather than re-reading the queue on a timer. A deadline that
   * has already passed is returned too, so a task that is due *now* can never be
   * slept past.
   */
  nextDue(): Promise<Date | null>;

  /** Inserts a task, or replaces the pending task with the same dedupe key. */
  upsert(input: {
    guildId: string;
    kind: string;
    dueAt: Date;
    payload: unknown;
    recurrence: TaskRecurrence | null;
    dedupeKey: string | null;
  }): Promise<ScheduledTaskRecord>;

  /** Records a successful run, clearing the error and stopping the task. */
  complete(id: string, at: Date): Promise<void>;

  /** Records a successful run of a recurring task and schedules the next one. */
  reschedule(id: string, dueAt: Date): Promise<void>;

  /** Records a failed attempt, keeping the task pending for a retry. */
  recordFailure(id: string, error: string, retryAt: Date): Promise<void>;

  /** Marks a task `failed` after its attempts are exhausted. */
  abandon(id: string, error: string, at: Date): Promise<void>;

  /** Cancels a task. Returns whether a task was actually cancelled. */
  cancel(id: string): Promise<boolean>;

  /** Cancels the pending task with a dedupe key. Returns whether one existed. */
  cancelByDedupeKey(guildId: string, dedupeKey: string): Promise<boolean>;

  find(id: string): Promise<ScheduledTaskRecord | null>;

  /** Pending tasks for a guild, soonest first. */
  listPending(guildId: string, limit: number): Promise<ScheduledTaskRecord[]>;

  /** Number of tasks per status, for `/scheduler status`. */
  countByStatus(guildId: string): Promise<Record<string, number>>;

  /**
   * Returns tasks stuck in `running` (a worker died mid-task) to `pending`, so a
   * crash does not permanently strand the work. Returns how many were recovered.
   *
   * `olderThan` is the cutoff a stranded task must predate: a task claimed
   * moments ago by a healthy worker in the same process is not stranded, and
   * returning it to `pending` would let it run twice.
   */
  recoverStale(olderThan: Date): Promise<number>;
}

/** Shape of a `scheduled_tasks` row as Prisma returns it. */
interface ScheduledTaskRow {
  id: string;
  guildId: string;
  kind: string;
  dueAt: Date;
  payload: unknown;
  status: string;
  recurrence: unknown;
  dedupeKey: string | null;
  attempts: number;
  lastError: string | null;
}

export class PrismaScheduledTaskRepository implements ScheduledTaskRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async claimDue(now: Date, limit: number): Promise<ScheduledTaskRecord[]> {
    try {
      // Select first, then claim each row conditionally. The conditional update is
      // the concurrency control: `updateMany` with `status: "pending"` in the
      // filter succeeds for exactly one worker, and `count === 1` proves we won it.
      // A second worker that selected the same row loses the race and gets 0.
      const candidates = await this.prisma.scheduledTask.findMany({
        where: { status: "pending", dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: limit,
      });

      const claimed: ScheduledTaskRecord[] = [];
      for (const candidate of candidates) {
        const result = await this.prisma.scheduledTask.updateMany({
          where: { id: candidate.id, status: "pending" },
          data: { status: "running" },
        });
        if (result.count === 1) {
          claimed.push(toRecord({ ...candidate, status: "running" }));
        }
      }
      return claimed;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.claimDue");
    }
  }

  public async nextDue(): Promise<Date | null> {
    try {
      // `(status, dueAt)` is indexed, so this is an index-only read of a single
      // row: the engine can ask "when is the next thing due?" cheaply enough to do
      // it after every batch instead of guessing on a timer.
      const row = await this.prisma.scheduledTask.findFirst({
        where: { status: "pending" },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true },
      });
      return row?.dueAt ?? null;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.nextDue");
    }
  }

  public async upsert(input: {
    guildId: string;
    kind: string;
    dueAt: Date;
    payload: unknown;
    recurrence: TaskRecurrence | null;
    dedupeKey: string | null;
  }): Promise<ScheduledTaskRecord> {
    try {
      const data = {
        kind: input.kind,
        dueAt: input.dueAt,
        payload: toJson(input.payload ?? {}),
        // `toNullableJson` (not `toJson`) because "no recurrence" must be SQL NULL:
        // the clear-on-complete paths below write `null`, and a reader that finds
        // the JSON literal `null` instead of SQL NULL would have to treat both as
        // "no recurrence" — one representation is cheaper to reason about.
        recurrence: toNullableJson(input.recurrence),
        status: "pending",
        attempts: 0,
        lastError: null,
        completedAt: null,
      };

      // Without a dedupe key a task is always new: two reminders for the same
      // moment are two tasks, not one.
      if (input.dedupeKey === null) {
        const row = await this.prisma.scheduledTask.create({
          data: { ...data, guildId: input.guildId, dedupeKey: null },
        });
        return toRecord(row);
      }

      // The unique `(guildId, dedupeKey)` index is what makes this an upsert: a
      // feature that re-schedules the same work updates the existing row, so
      // "extend the temp role by another hour" cannot accumulate tasks.
      const row = await this.prisma.scheduledTask.upsert({
        where: {
          guildId_dedupeKey: { guildId: input.guildId, dedupeKey: input.dedupeKey },
        },
        update: data,
        create: { ...data, guildId: input.guildId, dedupeKey: input.dedupeKey },
      });
      return toRecord(row);
    } catch (error) {
      throw toDatabaseError(error, "scheduler.upsert");
    }
  }

  public async complete(id: string, at: Date): Promise<void> {
    await this.update(
      id,
      {
        status: "done",
        completedAt: at,
        lastError: null,
        // Clearing the recurrence is what stops the tick loop: a finished one-shot
        // task must not be rescheduled by the next tick's `task.recurrence` check.
        recurrence: toNullableJson(null),
      },
      "scheduler.complete",
    );
  }

  public async reschedule(id: string, dueAt: Date): Promise<void> {
    // `attempts` resets on a successful run: the counter measures consecutive
    // failures of the current due time, so one bad night does not permanently
    // disable a healthy recurring task.
    await this.update(
      id,
      { status: "pending", dueAt, attempts: 0, lastError: null },
      "scheduler.reschedule",
    );
  }

  public async recordFailure(id: string, error: string, retryAt: Date): Promise<void> {
    try {
      await this.prisma.scheduledTask.update({
        where: { id },
        data: {
          status: "pending",
          dueAt: retryAt,
          attempts: { increment: 1 },
          lastError: error,
        },
      });
    } catch (cause) {
      throw toDatabaseError(cause, "scheduler.recordFailure");
    }
  }

  public async abandon(id: string, error: string, at: Date): Promise<void> {
    await this.update(
      id,
      {
        status: "failed",
        lastError: error,
        completedAt: at,
        // A recurring task that exhausted its retries must stop recurring: the
        // failure is permanent, and `recurrence` is what the tick loop reads to
        // decide whether to schedule a next run.
        recurrence: toNullableJson(null),
      },
      "scheduler.abandon",
    );
  }

  public async cancel(id: string): Promise<boolean> {
    try {
      // Cancelling only applies to work that has not finished. A `done` task is
      // history, and rewriting it to `cancelled` would falsify the record.
      const result = await this.prisma.scheduledTask.updateMany({
        where: { id, status: { in: ["pending", "running"] } },
        data: { status: "cancelled", completedAt: new Date(), recurrence: toNullableJson(null) },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.cancel");
    }
  }

  public async cancelByDedupeKey(guildId: string, dedupeKey: string): Promise<boolean> {
    try {
      const result = await this.prisma.scheduledTask.updateMany({
        where: { guildId, dedupeKey, status: { in: ["pending", "running"] } },
        data: { status: "cancelled", completedAt: new Date(), recurrence: toNullableJson(null) },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.cancelByDedupeKey");
    }
  }

  public async find(id: string): Promise<ScheduledTaskRecord | null> {
    try {
      const row = await this.prisma.scheduledTask.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.find");
    }
  }

  public async listPending(guildId: string, limit: number): Promise<ScheduledTaskRecord[]> {
    try {
      const rows = await this.prisma.scheduledTask.findMany({
        where: { guildId, status: "pending" },
        orderBy: { dueAt: "asc" },
        take: limit,
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "scheduler.listPending");
    }
  }

  public async countByStatus(guildId: string): Promise<Record<string, number>> {
    try {
      const rows = await this.prisma.scheduledTask.groupBy({
        by: ["status"],
        where: { guildId },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = row._count._all;
      }
      return counts;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.countByStatus");
    }
  }

  public async recoverStale(olderThan: Date): Promise<number> {
    try {
      // A live worker holds a claimed task for the duration of one tick, so any row
      // still `running` after the grace window belongs to a process that died. The
      // work is returned to `pending` rather than failed: the task itself was never
      // judged, it was only interrupted.
      const result = await this.prisma.scheduledTask.updateMany({
        where: {
          status: "running",
          OR: [{ completedAt: null }, { completedAt: { lte: olderThan } }],
        },
        data: { status: "pending" },
      });
      return result.count;
    } catch (error) {
      throw toDatabaseError(error, "scheduler.recoverStale");
    }
  }

  /** Shared single-row update with a labelled error. */
  private async update(id: string, data: Record<string, unknown>, scope: string): Promise<void> {
    try {
      await this.prisma.scheduledTask.update({ where: { id }, data: data as never });
    } catch (error) {
      throw toDatabaseError(error, scope);
    }
  }
}

/** Normalizes a row, rejecting an unrecognized status rather than trusting it. */
function toRecord(row: ScheduledTaskRow): ScheduledTaskRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind,
    dueAt: row.dueAt,
    payload: row.payload,
    status: toStatus(row.status),
    recurrence: toRecurrence(row.recurrence),
    dedupeKey: row.dedupeKey,
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

function toStatus(value: string): ScheduledTaskStatus {
  switch (value) {
    case "pending":
    case "running":
    case "done":
    case "failed":
    case "cancelled":
      return value;
    default:
      // A status the code does not know cannot be acted on safely; `failed` makes
      // the row visible in `/scheduler status` instead of it looping forever.
      return "failed";
  }
}

/** Parses the stored recurrence, ignoring anything that is not a positive interval. */
function toRecurrence(value: unknown): TaskRecurrence | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const everySeconds = (value as { everySeconds?: unknown }).everySeconds;
  if (typeof everySeconds !== "number" || !Number.isFinite(everySeconds) || everySeconds <= 0) {
    return null;
  }
  return { everySeconds };
}
