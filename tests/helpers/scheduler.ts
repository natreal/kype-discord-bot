/**
 * In-memory collaborators for the V6 scheduler tests.
 *
 * The fake replaces *PostgreSQL only*: `SchedulerService`, `TaskHandlerRegistry`
 * and the handler contracts under test are the production ones, so the suite
 * exercises the code the bot actually runs.
 *
 * The one behaviour worth reading closely is `claimDue`. The real repository is
 * concurrency-safe by compare-and-swap; this fake is safe by being single-threaded
 * and by mutating the row *before* awaiting anything, which is what makes
 * "a second claim cannot see a task the first one took" hold here too. Modelling
 * that matters: if the fake returned the same task twice, a bug in the service's
 * outcome policy would be masked rather than caught.
 */
import type {
  ScheduledTaskRecord,
  ScheduledTaskRepository,
  ScheduledTaskStatus,
  TaskRecurrence,
} from "../../src/modules/scheduler/index.js";

/** Interface for the in-memory store, exposing internals for assertions. */
export interface MemorySchedulerRepository extends ScheduledTaskRepository {
  /** Every row, in creation order. Assertions read this directly. */
  readonly rows: ScheduledTaskRecord[];
  /** Test-only: set a row's status without going through the port. */
  forceStatus(id: string, status: ScheduledTaskStatus): void;
  /**
   * Test-only: backdate when a row was claimed, so `recoverStale` sees it as
   * stranded by a process that died.
   */
  backdateClaim(id: string, at: Date): void;
  /** Test-only: how many times a row was moved to its next occurrence. */
  readonly reschedules: number;
}

/** Builds an isolated in-memory repository. One per test. */
export function memoryScheduler(): MemorySchedulerRepository {
  const rows: ScheduledTaskRecord[] = [];
  /**
   * When each row was last claimed, keyed by id.
   *
   * The real repository stamps `updatedAt` on the claim and `recoverStale` filters
   * on *that*, not on `dueAt`. Keeping the same distinction here matters: a task
   * that was claimed a second ago is not stranded merely because its due time is
   * in the past, and a fake that conflated the two would make the recovery test
   * pass while the production query did nothing.
   */
  const claimedAt = new Map<string, Date>();
  let counter = 0;
  let reschedules = 0;

  const find = (id: string): ScheduledTaskRecord | undefined => rows.find((row) => row.id === id);

  const store: MemorySchedulerRepository = {
    rows,

    get reschedules(): number {
      return reschedules;
    },

    forceStatus(id, status) {
      const row = find(id);
      if (row) {
        (row as { status: ScheduledTaskStatus }).status = status;
      }
      // Claiming stamps the time; anything else clears it, so a row forced back to
      // `pending` is not treated as a candidate for recovery.
      if (status === "running") {
        claimedAt.set(id, new Date());
      } else {
        claimedAt.delete(id);
      }
    },

    /** Test-only: backdate a claim so `recoverStale` sees it as stranded. */
    backdateClaim(id: string, at: Date): void {
      claimedAt.set(id, at);
    },

    claimDue(nowArg, limit) {
      const due = rows
        .filter((row) => row.status === "pending" && row.dueAt.getTime() <= nowArg.getTime())
        .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
        .slice(0, limit);

      // Marked `running` before returning, mirroring the conditional update: a
      // second call in the same tick sees nothing left to claim.
      for (const row of due) {
        (row as { status: ScheduledTaskStatus }).status = "running";
        claimedAt.set(row.id, new Date(nowArg.getTime()));
      }
      return Promise.resolve(due.map((row) => ({ ...row })));
    },

    nextDue() {
      // Mirrors the production read: the earliest deadline among the pending rows,
      // even one that has already passed, so a due task can never be slept past.
      const pending = rows.filter((row) => row.status === "pending");
      const next = pending.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())[0];
      return Promise.resolve(next ? next.dueAt : null);
    },

    upsert(input: {
      guildId: string;
      kind: string;
      dueAt: Date;
      payload: unknown;
      recurrence: TaskRecurrence | null;
      dedupeKey: string | null;
    }) {
      // The real repository replaces a pending task with the same dedupe key;
      // that is what makes "extend this temp role" an upsert rather than a leak.
      if (input.dedupeKey !== null) {
        const existing = rows.find(
          (row) =>
            row.guildId === input.guildId &&
            row.dedupeKey === input.dedupeKey &&
            (row.status === "pending" || row.status === "running"),
        );
        if (existing) {
          (existing as { dueAt: Date }).dueAt = input.dueAt;
          (existing as { payload: unknown }).payload = input.payload;
          (existing as { recurrence: TaskRecurrence | null }).recurrence = input.recurrence;
          (existing as { status: ScheduledTaskStatus }).status = "pending";
          (existing as { attempts: number }).attempts = 0;
          (existing as { lastError: string | null }).lastError = null;
          return Promise.resolve({ ...existing });
        }
      }

      counter += 1;
      const record: ScheduledTaskRecord = {
        id: `task-${counter}`,
        guildId: input.guildId,
        kind: input.kind,
        dueAt: input.dueAt,
        payload: input.payload,
        status: "pending",
        recurrence: input.recurrence,
        dedupeKey: input.dedupeKey,
        attempts: 0,
        lastError: null,
      };
      rows.push(record);
      return Promise.resolve({ ...record });
    },

    complete(id) {
      const row = find(id);
      if (row) {
        (row as { status: ScheduledTaskStatus }).status = "done";
        (row as { lastError: string | null }).lastError = null;
      }
      return Promise.resolve();
    },

    reschedule(id, dueAt) {
      const row = find(id);
      if (row) {
        (row as { status: ScheduledTaskStatus }).status = "pending";
        (row as { dueAt: Date }).dueAt = dueAt;
        (row as { attempts: number }).attempts = 0;
        (row as { lastError: string | null }).lastError = null;
        reschedules += 1;
      }
      return Promise.resolve();
    },

    recordFailure(id, error, retryAt) {
      const row = find(id);
      if (row) {
        (row as { status: ScheduledTaskStatus }).status = "pending";
        (row as { attempts: number }).attempts += 1;
        (row as { lastError: string | null }).lastError = error;
        (row as { dueAt: Date }).dueAt = retryAt;
      }
      return Promise.resolve();
    },

    abandon(id, error) {
      const row = find(id);
      if (row) {
        (row as { status: ScheduledTaskStatus }).status = "failed";
        (row as { attempts: number }).attempts += 1;
        (row as { lastError: string | null }).lastError = error;
      }
      return Promise.resolve();
    },

    cancel(id) {
      const row = find(id);
      if (!row || (row.status !== "pending" && row.status !== "running")) {
        return Promise.resolve(false);
      }
      (row as { status: ScheduledTaskStatus }).status = "cancelled";
      return Promise.resolve(true);
    },

    cancelByDedupeKey(guildId, dedupeKey) {
      const row = rows.find(
        (candidate) =>
          candidate.guildId === guildId &&
          candidate.dedupeKey === dedupeKey &&
          (candidate.status === "pending" || candidate.status === "running"),
      );
      if (!row) {
        return Promise.resolve(false);
      }
      (row as { status: ScheduledTaskStatus }).status = "cancelled";
      return Promise.resolve(true);
    },

    find(id) {
      const row = find(id);
      return Promise.resolve(row ? { ...row } : null);
    },

    listPending(guildId, limit) {
      return Promise.resolve(
        rows
          .filter((row) => row.guildId === guildId && row.status === "pending")
          .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
          .slice(0, limit)
          .map((row) => ({ ...row })),
      );
    },

    countByStatus(guildId) {
      const counts: Record<string, number> = {};
      for (const row of rows) {
        if (row.guildId !== guildId) {
          continue;
        }
        counts[row.status] = (counts[row.status] ?? 0) + 1;
      }
      return Promise.resolve(counts);
    },

    recoverStale(olderThan) {
      // Filters on *when the row was claimed*, mirroring the production query's
      // `updatedAt` cutoff. A task claimed a moment ago is still in flight, not
      // stranded, however old its due time is.
      const stale = rows.filter((row) => {
        if (row.status !== "running") {
          return false;
        }
        const claimed = claimedAt.get(row.id);
        return claimed !== undefined && claimed.getTime() < olderThan.getTime();
      });
      for (const row of stale) {
        (row as { status: ScheduledTaskStatus }).status = "pending";
        claimedAt.delete(row.id);
      }
      return Promise.resolve(stale.length);
    },
  };

  return store;
}

/** A task record with sensible defaults, for registry and handler tests. */
export function taskRecord(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: "task-1",
    guildId: "111111111111111111",
    kind: "test.task",
    dueAt: new Date("2026-01-01T00:00:00.000Z"),
    payload: {},
    status: "pending",
    recurrence: null,
    dedupeKey: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}
