/**
 * V6 expired-punishment sweeper tests.
 *
 * The sweeper is a scheduler handler, not an in-process timer, and the suite proves
 * what that buys plus what it must not break:
 *
 *   1. **an expired mute is lifted**, and it is lifted *through the normal
 *      moderation pipeline* — so it writes the same `unmute` case, audit event and
 *      log line a human unmute would;
 *   2. **it is lifted only once.** A second sweep finds nothing to do, because the
 *      first one wrote the reversal case the query filters on;
 *   3. **a permanent punishment is never swept**, and neither is one whose deadline
 *      is still ahead;
 *   4. **one unactionable member does not stop the sweep** for the others;
 *   5. **a case nothing can ever lift is retired once**, so a departed member costs a
 *      single write rather than a warning on every sweep, forever;
 *   6. **it is scheduled per guild, idempotently**, so a restart does not stack a
 *      second sweep.
 */
import { describe, expect, it } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import { ModerationService } from "../../src/modules/moderation/moderation.service.js";
import {
  ModerationSweeper,
  MODERATION_SWEEP_TASK_KIND,
} from "../../src/modules/moderation/moderation.sweeper.js";
import { TaskHandlerRegistry } from "../../src/modules/scheduler/task-registry.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler.service.js";
import { testLogger } from "../helpers/logger.js";
import { memoryScheduler } from "../helpers/scheduler.js";
import { fakeMemberActions, memberTarget, memoryCaseRepository } from "../helpers/moderation.js";
import { createV3Harness, GUILD_A } from "../helpers/v3-harness.js";

const TARGET = "444444444444444444";
const MUTE_ROLE = { id: "role-muted", name: "Muted", position: 2 };
/** Long enough ago that every deadline below is in the past. */
const PAST = new Date(Date.now() - 60 * 60 * 1_000);

interface SweeperHarness {
  readonly sweeper: ModerationSweeper;
  readonly scheduler: SchedulerService;
  readonly registry: TaskHandlerRegistry;
  readonly members: ReturnType<typeof fakeMemberActions>;
  readonly service: ModerationService;
  readonly cases: ReturnType<typeof memoryCaseRepository>;
  readonly auditActions: string[];
  readonly logLines: string[];
}

/** Builds the real service and sweeper over in-memory persistence. */
function sweeperHarness(): SweeperHarness {
  const v3 = createV3Harness();
  const members = fakeMemberActions({ muteRole: MUTE_ROLE });
  const auditActions: string[] = [];
  const logLines: string[] = [];
  const cases = memoryCaseRepository();

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([]);
    },
  });

  const service = new ModerationService({
    logger: testLogger,
    audit,
    cases,
    members,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.moderation),
    log: {
      record(event) {
        logLines.push(event.action);
        return Promise.resolve();
      },
    },
  });

  const registry = new TaskHandlerRegistry();
  const scheduler = new SchedulerService({
    repository: memoryScheduler(),
    registry,
    logger: testLogger,
  });

  const sweeper = new ModerationSweeper({
    scheduler,
    resolve: (guildId) => (guildId === GUILD_A ? service : null),
    logger: testLogger,
  });
  registry.register(sweeper.handler());

  return { sweeper, scheduler, registry, members, service, cases, auditActions, logLines };
}

/**
 * Records a temporary punishment directly, as `/mute` would have.
 *
 * Writing the case rather than executing the action keeps these tests about the
 * *sweeper*: the punishment itself is already covered by the V4 suite.
 */
async function seedPunishment(
  harness: SweeperHarness,
  action: "mute" | "timeout" | "ban",
  expiresAt: Date | null,
  guildId = GUILD_A,
): Promise<void> {
  await harness.cases.append({
    guildId,
    action,
    actor: { id: "mod-1", kind: "user", tag: "moderator#0001" },
    target: memberTarget({ id: TARGET, tag: "target#0001" }),
    reason: "test punishment",
    durationMs: expiresAt ? 3_600_000 : null,
    expiresAt,
    before: null,
    after: null,
    details: {},
    relatedCaseNumber: null,
  });
}

/**
 * Builds a member target with the mute role, so reversal guards let it through.
 */
function seedTarget(harness: SweeperHarness): void {
  harness.members.targets.set(
    TARGET,
    memberTarget({ id: TARGET, tag: "target#0001", muted: true }),
  );
  harness.members.roles.set(TARGET, new Set([MUTE_ROLE.id]));
}

/**
 * Records a temporary mute whose target has since left the guild.
 *
 * This is the case the sweeper can *never* action, and the one real bots accumulate:
 * before it was retired, a single departed member made the bot write a warning and
 * two database round trips on every sweep — every minute, forever.
 */
async function seedDepartedPunishment(harness: SweeperHarness): Promise<void> {
  await harness.cases.append({
    guildId: GUILD_A,
    action: "mute",
    actor: { id: "mod-1", kind: "user", tag: "moderator#0001" },
    target: memberTarget({ id: "999999999999999999", tag: "gone#0001" }),
    reason: "left the server",
    durationMs: 3_600_000,
    expiresAt: new Date(PAST.getTime() - 1_000),
    before: null,
    after: null,
    details: {},
    relatedCaseNumber: null,
  });
}

describe("ModerationSweeper", () => {
  it("lifts an expired mute through the normal moderation pipeline", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", PAST);

    const result = await harness.service.liftExpired();

    expect(result).toEqual({ examined: 1, lifted: 1, closed: 0, failed: 0 });
    // The role is off the member...
    expect(harness.members.roles.get(TARGET)?.has(MUTE_ROLE.id)).toBe(false);
    // ...and the reversal is a real `unmute` case, not a silent side effect.
    const history = await harness.cases.list(GUILD_A, { targetId: TARGET });
    expect(history.some((record) => record.action === "unmute")).toBe(true);
    // The same audit action and log line a human unmute would produce.
    expect(harness.auditActions).toContain("moderation.unmute");
    expect(harness.logLines).toContain("unmute");
  });

  it("records the reversal as automated, not as a human action", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", PAST);

    await harness.service.liftExpired();

    const history = await harness.cases.list(GUILD_A, { targetId: TARGET });
    const reversal = history.find((record) => record.action === "unmute");
    expect(reversal?.moderatorKind).toBe("system");
    expect(reversal?.moderatorId).toBe("system:sweeper");
  });

  it("lifts a punishment only once, however often it sweeps", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", PAST);

    const first = await harness.service.liftExpired();
    const second = await harness.service.liftExpired();

    expect(first.lifted).toBe(1);
    // The reversal case written by the first sweep is exactly what makes the second
    // a no-op: without that filter the member would be "unmuted" forever.
    expect(second.examined).toBe(0);
    expect(second.lifted).toBe(0);
  });

  it("never sweeps a punishment whose deadline is still ahead", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", new Date(Date.now() + 3_600_000));

    const result = await harness.service.liftExpired();

    expect(result.lifted).toBe(0);
    expect(harness.members.roles.get(TARGET)?.has(MUTE_ROLE.id)).toBe(true);
  });

  it("never sweeps a permanent punishment", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", null);

    expect((await harness.service.liftExpired()).lifted).toBe(0);
  });

  it("continues to the next case when one member can no longer be actioned", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", PAST);
    // A case naming a member who is not in the guild, due *before* the real one, so
    // it is examined first and must not abort the sweep.
    await seedDepartedPunishment(harness);

    const result = await harness.service.liftExpired();

    expect(result.examined).toBe(2);
    expect(result.lifted).toBe(1);
    // Retired rather than failed: there is nothing left to lift, and counting it as a
    // failure is what made one departed member produce a warning on every sweep.
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("retires a case it can never lift, so later sweeps stop examining it", async () => {
    const harness = sweeperHarness();
    await seedDepartedPunishment(harness);

    const first = await harness.service.liftExpired();
    const second = await harness.service.liftExpired();

    expect(first).toEqual({ examined: 1, lifted: 0, closed: 1, failed: 0 });
    // The property that matters for a bot left running 24/7: a departed member costs
    // *one* log line and *one* write, instead of a warning and two database round
    // trips on every sweep for the rest of the bot's life.
    expect(second).toEqual({ examined: 0, lifted: 0, closed: 0, failed: 0 });
  });

  it("keeps the retired case readable, with why and when it was closed", async () => {
    const harness = sweeperHarness();
    await seedDepartedPunishment(harness);

    await harness.service.liftExpired();

    const record = harness.cases.cases[0];
    // The deadline is cleared because it *is* the sweep's predicate; the case itself
    // survives as the history entry it always was.
    expect(record?.expiresAt).toBeNull();
    expect(record?.action).toBe("mute");
    expect(record?.reason).toBe("left the server");
    const details = record?.details as { sweep?: { reason?: string; expiresAt?: string } };
    expect(details.sweep?.reason).toBe("the member is no longer in this server");
    // Both facts a reader would otherwise lose: the original deadline, and that this
    // was the sweeper's decision rather than a human's.
    expect(details.sweep?.expiresAt).toBe(new Date(PAST.getTime() - 1_000).toISOString());
  });
});

describe("ModerationSweeper scheduling", () => {
  it("schedules one recurring sweep per guild", async () => {
    const harness = sweeperHarness();

    await harness.sweeper.ensureScheduled(GUILD_A);

    const pending = await harness.scheduler.listPending(GUILD_A);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe(MODERATION_SWEEP_TASK_KIND);
    expect(pending[0]?.recurrence).toEqual({ everySeconds: 60 });
  });

  it("is idempotent: a second call reuses the existing task", async () => {
    const harness = sweeperHarness();

    await harness.sweeper.ensureScheduled(GUILD_A);
    await harness.sweeper.ensureScheduled(GUILD_A);

    // One row, because the dedupe key is the guild: a restart must not stack sweeps.
    expect(await harness.scheduler.listPending(GUILD_A)).toHaveLength(1);
  });

  it("reports a sweep for a guild the bot has left as skipped", async () => {
    const harness = sweeperHarness();

    const outcome = await harness.sweeper.handler().run({
      task: {
        id: "t1",
        guildId: "guild-gone",
        kind: MODERATION_SWEEP_TASK_KIND,
        dueAt: new Date(0),
        payload: {},
        status: "running",
        recurrence: { everySeconds: 60 },
        dedupeKey: null,
        attempts: 0,
        lastError: null,
      },
      logger: testLogger,
    });

    // `skipped`, not a failure: the guild left, so there is nothing to retry.
    expect(outcome).toEqual({ outcome: "skipped", detail: "guild unavailable" });
  });

  it("reports how much work a sweep did", async () => {
    const harness = sweeperHarness();
    seedTarget(harness);
    await seedPunishment(harness, "mute", PAST);

    const outcome = await harness.sweeper.handler().run({
      task: {
        id: "t1",
        guildId: GUILD_A,
        kind: MODERATION_SWEEP_TASK_KIND,
        dueAt: new Date(0),
        payload: {},
        status: "running",
        recurrence: { everySeconds: 60 },
        dedupeKey: null,
        attempts: 0,
        lastError: null,
      },
      logger: testLogger,
    });

    expect(outcome).toEqual({
      outcome: "done",
      detail: "examined 1, lifted 1, closed 0, failed 0",
    });
  });
});
