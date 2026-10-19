/**
 * V6 scheduler tests.
 *
 * The suite asserts the properties that make one shared engine trustworthy, which
 * are also the ones a second timer mechanism would quietly lose:
 *
 *   1. **a task is claimed exactly once.** Two ticks, or two workers, must never
 *      both run the same row — that is what the conditional claim buys, and it is
 *      the difference between "the temp role was removed" and "it was removed
 *      twice, once after the member already got it back".
 *   2. **failure is bounded and visible.** A handler that throws is retried, and a
 *      handler that always throws is abandoned with a recorded reason — never
 *      retried forever, never dropped in silence.
 *   3. **recurrence does not drift and does not burst.** The next occurrence is
 *      anchored on the previous due time, and a long outage does not produce a
 *      catch-up storm when the bot comes back.
 *   4. **an unregistered kind is a hard failure**, not a no-op: a task whose whole
 *      purpose was to undo something must say so.
 */
import { describe, expect, it, vi } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import { SchedulerService, TaskHandlerRegistry } from "../../src/modules/scheduler/index.js";
import {
  DuplicateTaskHandlerError,
  UnknownTaskKindError,
} from "../../src/modules/scheduler/task-registry.js";
import type { TaskHandler, TaskHandlerContext } from "../../src/modules/scheduler/index.js";
import { testLogger } from "../helpers/logger.js";
import { memoryScheduler } from "../helpers/scheduler.js";

const GUILD = "111111111111111111";
const KIND = "test.task";

/** A handler that records every invocation and succeeds. */
function recordingHandler(
  options: {
    readonly kind?: string;
    readonly runs?: TaskHandlerContext[];
    readonly failTimes?: number;
    readonly result?: { outcome: "done" | "skipped"; detail?: string };
  } = {},
): TaskHandler & { readonly calls: TaskHandlerContext[] } {
  const calls = options.runs ?? [];
  let remainingFailures = options.failTimes ?? 0;
  return {
    kind: options.kind ?? KIND,
    description: "test handler",
    calls,
    run(context) {
      calls.push(context);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(options.result);
    },
  };
}

/** Builds a service over the in-memory repository. */
function buildService(
  options: {
    readonly handlers?: readonly TaskHandler[];
    readonly audit?: AuditEventService;
    readonly maxAttempts?: number;
    readonly retryDelaySeconds?: number;
    readonly batchSize?: number;
    readonly repository?: ReturnType<typeof memoryScheduler>;
  } = {},
) {
  const repository = options.repository ?? memoryScheduler();
  const registry = new TaskHandlerRegistry();
  registry.registerAll(options.handlers ?? [recordingHandler()]);
  const service = new SchedulerService({
    repository,
    registry,
    logger: testLogger,
    audit: options.audit,
    options: {
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.retryDelaySeconds === undefined
        ? {}
        : { retryDelaySeconds: options.retryDelaySeconds }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    },
  });
  return { service, repository, registry };
}

/** An audit service that collects what was recorded. */
function memoryAudit(): {
  audit: AuditEventService;
  readonly events: { action: string; details: unknown }[];
} {
  const events: { action: string; details: unknown }[] = [];
  const audit = new AuditEventService(testLogger, {
    append(record) {
      events.push({ action: record.action, details: record.details });
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([]);
    },
  });
  return { audit, events };
}

describe("scheduling", () => {
  it("stores a task that is not yet due and leaves it alone", async () => {
    const { service, repository } = buildService();

    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() + 60_000) });
    const result = await service.tick();

    expect(result.claimed).toBe(0);
    expect(repository.rows[0]?.status).toBe("pending");
  });

  it("rejects an unknown kind instead of storing a task nothing can run", async () => {
    const { service, repository } = buildService();

    await expect(
      service.schedule({ guildId: GUILD, kind: "nobody.owns.this", dueAt: new Date() }),
    ).rejects.toThrow(/Unknown scheduled task kind/);
    expect(repository.rows).toHaveLength(0);
  });

  it("requires a due time in one of its two forms", async () => {
    const { service } = buildService();

    await expect(service.schedule({ guildId: GUILD, kind: KIND })).rejects.toThrow(
      /needs either `dueAt` or `delaySeconds`/,
    );
  });

  it("rejects a recurrence below the minimum interval", async () => {
    const { service } = buildService();

    await expect(
      service.schedule({
        guildId: GUILD,
        kind: KIND,
        dueAt: new Date(),
        recurrence: { everySeconds: 5 },
      }),
    ).rejects.toThrow(/at least every 60 seconds/);
  });

  it("replaces a pending task with the same dedupe key rather than duplicating it", async () => {
    const { service, repository } = buildService();

    const first = await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() + 10_000),
      dedupeKey: "role-expire:member-1",
    });
    const second = await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() + 600_000),
      dedupeKey: "role-expire:member-1",
    });

    expect(repository.rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.dueAt.getTime()).toBeGreaterThan(first.dueAt.getTime());
  });
});

describe("claiming", () => {
  it("claims a due task exactly once across two ticks", async () => {
    const handler = recordingHandler();
    const { service, repository } = buildService({ handlers: [handler] });

    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });

    const first = await service.tick();
    const second = await service.tick();

    expect(first.claimed).toBe(1);
    expect(first.succeeded).toBe(1);
    // A second tick must see nothing: the row is `done`, and a redundant run would
    // undo work the first run already completed.
    expect(second.claimed).toBe(0);
    expect(handler.calls).toHaveLength(1);
    expect(repository.rows[0]?.status).toBe("done");
  });

  it("does not let a task be claimed by two overlapping ticks", async () => {
    const repository = memoryScheduler();
    const handler = recordingHandler();
    const { service } = buildService({ handlers: [handler], repository });

    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });

    const [first, second] = await Promise.all([service.tick(), service.tick()]);

    // The service's `ticking` flag makes the second call a no-op; between the two,
    // the task runs once. Anything else would be a double execution.
    expect(handler.calls).toHaveLength(1);
    expect(first.claimed + second.claimed).toBe(1);
  });

  it("bounds a tick to the configured batch size", async () => {
    const handler = recordingHandler();
    const { service } = buildService({ handlers: [handler], batchSize: 2 });

    for (let index = 0; index < 5; index += 1) {
      await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });
    }

    const result = await service.tick();

    expect(result.claimed).toBe(2);
    expect(handler.calls).toHaveLength(2);
  });

  it("runs the handler with a logger and the task's payload", async () => {
    const handler = recordingHandler();
    const { service } = buildService({ handlers: [handler] });

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 1000),
      payload: { memberId: "42" },
    });
    await service.tick();

    const context = handler.calls[0];
    expect(context?.task.payload).toEqual({ memberId: "42" });
    expect(context?.logger).toBeDefined();
  });
});

describe("failure policy", () => {
  it("retries a transient failure and succeeds on the next attempt", async () => {
    const handler = recordingHandler({ failTimes: 1 });
    const { service, repository } = buildService({
      handlers: [handler],
      maxAttempts: 3,
      retryDelaySeconds: 0,
    });

    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });

    const first = await service.tick();
    expect(first.failed).toBe(1);
    expect(repository.rows[0]?.status).toBe("pending");
    expect(repository.rows[0]?.attempts).toBe(1);
    expect(repository.rows[0]?.lastError).toBe("boom");

    const second = await service.tick(new Date(Date.now() + 1000));
    expect(second.succeeded).toBe(1);
    expect(repository.rows[0]?.status).toBe("done");
  });

  it("abandons a task that keeps failing and records why", async () => {
    const handler = recordingHandler({ failTimes: 5 });
    const { audit, events } = memoryAudit();
    const { service, repository } = buildService({
      handlers: [handler],
      audit,
      maxAttempts: 3,
      retryDelaySeconds: 0,
    });

    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });

    // Three ticks, each advancing the retry deadline by the (zero) retry delay.
    await service.tick(new Date(Date.now() + 1));
    await service.tick(new Date(Date.now() + 2));
    const last = await service.tick(new Date(Date.now() + 3));

    expect(last.abandoned).toBe(1);
    expect(repository.rows[0]?.status).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("scheduler.task.abandoned");
    expect(events[0]?.details).toMatchObject({ kind: KIND, attempts: 3 });
  });

  it("abandons a task whose kind has no handler, without burning retries", async () => {
    const repository = memoryScheduler();
    // Scheduled by a service that knows the kind, then run by one that does not —
    // the state a rolled-back deployment leaves behind.
    const owner = buildService({ handlers: [recordingHandler()], repository });
    await owner.service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 1000),
    });

    const impostor = buildService({
      handlers: [recordingHandler({ kind: "other.kind" })],
      repository,
    });
    const result = await impostor.service.tick();

    expect(result.abandoned).toBe(1);
    expect(repository.rows[0]?.status).toBe("failed");
    expect(repository.rows[0]?.lastError).toMatch(/No handler registered/);
  });

  it("keeps going after one task fails", async () => {
    const repository = memoryScheduler();
    const failing: TaskHandler = {
      kind: "test.fail",
      description: "always fails",
      run() {
        return Promise.reject(new Error("nope"));
      },
    };
    const succeeding = recordingHandler({ kind: KIND });
    const { service } = buildService({ handlers: [failing, succeeding], repository });

    await service.schedule({
      guildId: GUILD,
      kind: "test.fail",
      dueAt: new Date(Date.now() - 2000),
    });
    await service.schedule({ guildId: GUILD, kind: KIND, dueAt: new Date(Date.now() - 1000) });

    const result = await service.tick();

    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(succeeding.calls).toHaveLength(1);
  });
});

describe("recurrence", () => {
  it("reschedules a recurring task instead of completing it", async () => {
    const handler = recordingHandler();
    const { service, repository } = buildService({ handlers: [handler] });

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 1000),
      recurrence: { everySeconds: 60 },
    });

    await service.tick();

    const row = repository.rows[0];
    expect(row?.status).toBe("pending");
    expect(repository.reschedules).toBe(1);
    expect(row?.dueAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("anchors the next occurrence on the previous due time, not on `now`", async () => {
    const handler = recordingHandler();
    const { service, repository } = buildService({ handlers: [handler] });
    // Due now-ish: `dueAt + 1h` is comfortably in the future, so the anti-burst rule
    // does not engage and this test isolates the *anchoring*.
    const dueAt = new Date(Date.now() - 1_000);

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt,
      recurrence: { everySeconds: 3600 },
    });

    // Claimed 10 minutes late. Anchoring on the due time means the next run is one
    // hour after the *intended* time; anchoring on `now` would push it 10 minutes
    // later, and every late tick would compound the error.
    const now = new Date(dueAt.getTime() + 600_000);
    await service.tick(now);

    const expected = new Date(dueAt.getTime() + 3_600_000);
    expect(repository.rows[0]?.dueAt.getTime()).toBe(expected.getTime());
    expect(repository.rows[0]?.dueAt.getTime()).not.toBe(now.getTime() + 3_600_000);
  });

  it("does not burst to catch up after a long outage", async () => {
    const handler = recordingHandler();
    const { service, repository } = buildService({ handlers: [handler] });
    const dueAt = new Date("2026-01-01T00:00:00.000Z");

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt,
      recurrence: { everySeconds: 3600 },
    });

    // The bot was offline for two days. One run, and the next occurrence is in the
    // future — never a loop of missed firings.
    await service.tick(new Date("2026-01-03T00:00:00.000Z"));

    const next = repository.rows[0]?.dueAt;
    expect(repository.reschedules).toBe(1);
    expect(next && next.getTime()).toBeGreaterThan(Date.now());
  });

  it("advances the recurrence of a task whose handler reported `skipped`", async () => {
    const handler = recordingHandler({ result: { outcome: "skipped", detail: "already-gone" } });
    const { service, repository } = buildService({ handlers: [handler] });

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 1000),
      recurrence: { everySeconds: 60 },
    });

    const result = await service.tick();

    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(repository.rows[0]?.status).toBe("pending");
  });
});

describe("task handler registry", () => {
  it("refuses to register two handlers for the same kind", () => {
    const registry = new TaskHandlerRegistry();
    registry.register(recordingHandler());

    expect(() => registry.register(recordingHandler())).toThrow(DuplicateTaskHandlerError);
  });

  it("throws a named error for an unregistered kind", () => {
    const registry = new TaskHandlerRegistry();
    registry.register(recordingHandler());

    expect(() => registry.resolve("missing.kind")).toThrow(UnknownTaskKindError);
    expect(registry.find("missing.kind")).toBeNull();
  });

  it("lists kinds in a stable, sorted order", () => {
    const registry = new TaskHandlerRegistry();
    registry.registerAll([
      recordingHandler({ kind: "role.expire" }),
      recordingHandler({ kind: "channel.expire" }),
    ]);

    expect(registry.kinds()).toEqual(["channel.expire", "role.expire"]);
    expect(registry.list().map((handler) => handler.kind)).toEqual([
      "channel.expire",
      "role.expire",
    ]);
  });
});

describe("lifecycle", () => {
  it("recovers a task stranded by a previous process on start", async () => {
    const repository = memoryScheduler();
    const handler = recordingHandler();
    const { service } = buildService({ handlers: [handler], repository });

    const task = await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 60_000),
    });
    // `running` alone is not stranded: a healthy worker claims and runs within the
    // same interval. What makes it stranded is that the claim is older than the
    // recovery grace period, which is what backdating models here.
    repository.forceStatus(task.id, "running");
    repository.backdateClaim(task.id, new Date(Date.now() - 10 * 60_000));

    await service.start();
    // Recovery returns it to `pending`, and the initial drain tick then runs it —
    // the point is that the work is finished rather than left stuck forever.
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.stop();

    expect(handler.calls).toHaveLength(1);
    expect(repository.rows[0]?.status).toBe("done");
  });

  it("leaves a task claimed moments ago alone, so recovery cannot double-run it", async () => {
    const repository = memoryScheduler();
    const handler = recordingHandler();
    const { service } = buildService({ handlers: [handler], repository });

    const task = await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 60_000),
    });
    repository.forceStatus(task.id, "running");

    await service.start();
    service.stop();

    expect(repository.rows[0]?.status).toBe("running");
  });

  it("is idempotent: starting twice leaves one engine", async () => {
    vi.useFakeTimers();
    try {
      const repository = memoryScheduler();
      const { service } = buildService({ repository });
      const claims = vi.spyOn(repository, "claimDue");

      await service.start();
      await service.start();
      await vi.advanceTimersByTimeAsync(0);

      // One drain tick for two `start()` calls: the second is a no-op.
      expect(claims).toHaveBeenCalledTimes(1);
      expect(service.isRunning).toBe(true);

      service.stop();
      expect(service.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does no work at all while nothing is due", async () => {
    vi.useFakeTimers();
    try {
      const repository = memoryScheduler();
      const { service } = buildService({ repository });
      const claims = vi.spyOn(repository, "claimDue");

      await service.start();
      await vi.advanceTimersByTimeAsync(0);
      // The one batch that drains whatever was already due at startup.
      expect(claims).toHaveBeenCalledTimes(1);

      // Ten minutes of wall clock. An engine that polled every thirty seconds would
      // have claimed twenty more times, and that polling is exactly what keeps the
      // machine the bot runs on from ever being idle.
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(claims).toHaveBeenCalledTimes(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a task when its deadline arrives, not on a fixed cadence", async () => {
    vi.useFakeTimers();
    try {
      const repository = memoryScheduler();
      const handler = recordingHandler();
      const { service } = buildService({ handlers: [handler], repository });

      await service.schedule({ guildId: GUILD, kind: KIND, delaySeconds: 5 * 60 });
      await service.start();
      await vi.advanceTimersByTimeAsync(0);

      // Not due yet, so nothing ran and nothing was polled for: the engine sleeps
      // until the deadline it read from the queue.
      expect(handler.calls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(handler.calls).toHaveLength(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings its wake-up forward when something is scheduled sooner", async () => {
    vi.useFakeTimers();
    try {
      const repository = memoryScheduler();
      const handler = recordingHandler();
      const { service } = buildService({ handlers: [handler], repository });

      await service.start();
      await vi.advanceTimersByTimeAsync(0);

      // Idle, so the engine is asleep on the long idle cadence. Work due in one
      // second must not wait for it: scheduling wakes the engine.
      await service.schedule({ guildId: GUILD, kind: KIND, delaySeconds: 1 });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(handler.calls).toHaveLength(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps running deferred work after a tick that failed", async () => {
    vi.useFakeTimers();
    try {
      const repository = memoryScheduler();
      const handler = recordingHandler();
      const { service } = buildService({ handlers: [handler], repository });
      // One failing claim, then normal service: an engine that stopped arming after
      // an error would silently stop running work that was promised.
      const claimDue = vi
        .spyOn(repository, "claimDue")
        .mockRejectedValueOnce(new Error("database is down"));

      await service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler.calls).toHaveLength(0);

      await service.schedule({ guildId: GUILD, kind: KIND, delaySeconds: 30 });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(handler.calls).toHaveLength(1);
      claimDue.mockRestore();
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancellation", () => {
  it("cancels a pending task by id so it never runs", async () => {
    const handler = recordingHandler();
    const { service, repository } = buildService({ handlers: [handler] });

    const task = await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() - 1000),
    });
    expect(await service.cancel(task.id)).toBe(true);

    const result = await service.tick();

    expect(result.claimed).toBe(0);
    expect(handler.calls).toHaveLength(0);
    expect(repository.rows[0]?.status).toBe("cancelled");
  });

  it("cancels by dedupe key", async () => {
    const { service, repository } = buildService();

    await service.schedule({
      guildId: GUILD,
      kind: KIND,
      dueAt: new Date(Date.now() + 60_000),
      dedupeKey: "reminder:1",
    });

    expect(await service.cancelByKey(GUILD, "reminder:1")).toBe(true);
    expect(repository.rows[0]?.status).toBe("cancelled");
    // A second cancel is a no-op, not a second transition.
    expect(await service.cancelByKey(GUILD, "reminder:1")).toBe(false);
  });
});

describe("scheduler module", () => {
  it("is always enabled and owns no Discord resources", async () => {
    const { schedulerModule, SCHEDULER_RESOURCES } =
      await import("../../src/modules/scheduler/scheduler.module.js");

    expect(schedulerModule.name).toBe("scheduler");
    expect(schedulerModule.description).toContain("temporary roles");
    expect(Object.keys(SCHEDULER_RESOURCES)).toHaveLength(0);
  });

  it("is registered alongside the feature modules", async () => {
    const { botModules, findModule } = await import("../../src/modules/registry.js");

    expect(findModule("scheduler")).toBeDefined();
    // It schedules work *for* the other modules, so it must be present whenever
    // they are.
    expect(botModules.some((module) => module.name === "scheduler")).toBe(true);
  });

  it("plans no setup actions, so setup reports it as enabled with nothing to do", async () => {
    const { schedulerModule } = await import("../../src/modules/scheduler/scheduler.module.js");

    expect(schedulerModule.plan?.length ?? (-1 as unknown as number)).toBe(0);
  });
});
