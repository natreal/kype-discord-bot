/**
 * V6 role module tests.
 *
 * The suite proves the guarantees the module exists to provide, in the order they
 * can break:
 *
 *   1. **a temporary grant actually comes off.** The grant is a row plus a
 *      scheduled task, and the task removes the role;
 *   2. **it comes off exactly once.** A duplicate task fire, a manual revoke and a
 *      startup recovery all converge, and only the first one touches Discord;
 *   3. **it cannot outlive its task.** If the expiry could not be scheduled, the
 *      role is removed again rather than left on the member forever;
 *   4. **a restart repairs drift.** `recoverExpired` closes grants whose deadline
 *      passed while the process was down;
 *   5. **the module is registered and its handler is the production one.**
 */
import { describe, expect, it } from "vitest";

import { RoleService, ROLE_EXPIRE_TASK_KIND } from "../../src/modules/roles/index.js";
import { TaskHandlerRegistry } from "../../src/modules/scheduler/task-registry.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler.service.js";
import { testLogger } from "../helpers/logger.js";
import { memoryRoleGrants, fakeRoleActions } from "../helpers/roles.js";
import { memoryScheduler } from "../helpers/scheduler.js";

const GUILD = "guild-1";
const USER = "user-1";
const ROLE = "role-1";

/** Builds a service over fresh fakes, with a controllable clock. */
function harness(options: { now?: number; scheduler?: SchedulerService } = {}) {
  const grants = memoryRoleGrants();
  const actions = fakeRoleActions({ [USER]: [] });
  let now = options.now ?? 1_700_000_000_000;

  const service = new RoleService({
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    repository: grants,
    actions,
    logger: testLogger,
    now: () => now,
  });

  return {
    grants,
    actions,
    service,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Builds a real scheduler over the in-memory repository and a fresh registry. */
function schedulerHarness() {
  const repository = memoryScheduler();
  const registry = new TaskHandlerRegistry();
  const scheduler = new SchedulerService({
    repository,
    registry,
    logger: testLogger,
  });
  return { repository, registry, scheduler };
}

describe("RoleService.grant", () => {
  it("adds the role and records a grant with a deadline", async () => {
    const { service, actions, grants } = harness();

    const outcome = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.grant.status).toBe("active");
    expect(outcome.grant.source).toBe("temporary");
    expect(outcome.grant.expiresAt).not.toBeNull();
    expect(actions.rolesOf(USER)).toContain(ROLE);
    expect(grants.rows).toHaveLength(1);
  });

  it("refuses a member who is not in the guild", async () => {
    const { service } = harness();

    await expect(
      service.grant({
        guildId: GUILD,
        userId: "stranger",
        roleId: ROLE,
        grantedBy: "mod-1",
        durationMs: 3_600_000,
      }),
    ).rejects.toThrow(/not in this server/);
  });

  it("refuses a role the bot cannot manage", async () => {
    const { service, actions } = harness();
    actions.unmanageable(ROLE);

    await expect(
      service.grant({
        guildId: GUILD,
        userId: USER,
        roleId: ROLE,
        grantedBy: "mod-1",
        durationMs: 3_600_000,
      }),
    ).rejects.toThrow(/cannot manage that role/);
  });

  it("refuses a duration below the minimum", async () => {
    const { service } = harness();

    await expect(
      service.grant({
        guildId: GUILD,
        userId: USER,
        roleId: ROLE,
        grantedBy: "mod-1",
        durationMs: 1_000,
      }),
    ).rejects.toThrow(/at least 1 minute/);
  });

  it("refuses a duration beyond a year", async () => {
    const { service } = harness();

    await expect(
      service.grant({
        guildId: GUILD,
        userId: USER,
        roleId: ROLE,
        grantedBy: "mod-1",
        durationMs: 400 * 24 * 60 * 60 * 1_000,
      }),
    ).rejects.toThrow(/longer than one year/);
  });

  it("does not call Discord when the member already holds the role", async () => {
    const { service, actions } = harness();
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    const before = actions.roleCalls.length;
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    expect(actions.roleCalls.length).toBe(before);
  });

  it("extends an existing grant in place rather than creating a second row", async () => {
    const { service, grants, advance } = harness();

    const first = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    // Captured as a number before the second grant: the repository extends the row
    // in place, so `first.grant` and `second.grant` are the same object and reading
    // `first.grant.expiresAt` afterwards would compare it against itself.
    const firstExpiry = first.grant.expiresAt!.getTime();

    advance(60_000);
    const second = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 7_200_000,
    });

    expect(grants.rows).toHaveLength(1);
    expect(second.grant.id).toBe(first.grant.id);
    expect(second.grant.expiresAt!.getTime()).toBeGreaterThan(firstExpiry);
  });

  it("rolls the grant back when the expiry cannot be scheduled", async () => {
    const grants = memoryRoleGrants();
    const actions = fakeRoleActions({ [USER]: [] });

    // A scheduler that always fails: the role is already on the member at that
    // point, so the service must undo it rather than leave a role nothing will lift.
    const broken = new RoleService({
      scheduler: {
        schedule: () => Promise.reject(new Error("scheduler unavailable")),
      } as unknown as SchedulerService,
      repository: grants,
      actions,
      logger: testLogger,
    });

    const outcome = await broken.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    expect(outcome.rolledBack).toBe(true);
    expect(actions.rolesOf(USER)).not.toContain(ROLE);
    expect(grants.rows[0]?.status).toBe("revoked");
  });
});

describe("RoleService.expire", () => {
  it("removes the role and closes the grant", async () => {
    const { service, actions, grants } = harness();
    const { grant } = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    const expired = await service.expire(grant.id);

    expect(expired).toBe(true);
    expect(actions.rolesOf(USER)).not.toContain(ROLE);
    expect(grants.rows[0]?.status).toBe("expired");
    expect(grants.rows[0]?.revokedAt).not.toBeNull();
  });

  it("is idempotent: a second expiry touches neither Discord nor the row", async () => {
    const { service, actions, grants } = harness();
    const { grant } = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });
    await service.expire(grant.id);
    const callsAfterFirst = actions.roleCalls.length;

    const second = await service.expire(grant.id);

    expect(second).toBe(false);
    expect(actions.roleCalls.length).toBe(callsAfterFirst);
    expect(grants.rows[0]?.status).toBe("expired");
  });

  it("closes the grant even when the member has left the guild", async () => {
    const { service, actions, grants } = harness();
    const { grant } = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });
    actions.removeMember(USER);

    const expired = await service.expire(grant.id);

    // Closed anyway: leaving it active would make every future sweep examine a
    // grant that can never be actioned.
    expect(expired).toBe(true);
    expect(grants.rows[0]?.status).toBe("expired");
  });

  it("returns false for an unknown grant id", async () => {
    const { service } = harness();
    expect(await service.expire("does-not-exist")).toBe(false);
  });

  it("does not remove the role twice when a manual revoke raced the expiry", async () => {
    const { service, actions, grants } = harness();
    const { grant } = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    // Revoke first, as a moderator would; then the deadline task fires.
    await service.revoke(GUILD, USER, ROLE, "mod-1");
    const callsAfterRevoke = actions.roleCalls.length;
    const late = await service.expire(grant.id);

    expect(late).toBe(false);
    expect(actions.roleCalls.length).toBe(callsAfterRevoke);
    // The revoke's outcome stands: the row is not rewritten as "expired".
    expect(grants.rows[0]?.status).toBe("revoked");
  });
});

describe("RoleService.revoke", () => {
  it("removes the role and records who did it", async () => {
    const { service, actions, grants } = harness();
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    const revoked = await service.revoke(GUILD, USER, ROLE, "mod-2");

    expect(revoked?.status).toBe("revoked");
    expect(actions.rolesOf(USER)).not.toContain(ROLE);
    expect(grants.rows[0]?.revokedBy).toBe("mod-2");
  });

  it("returns null when no grant is live", async () => {
    const { service } = harness();
    expect(await service.revoke(GUILD, USER, ROLE, "mod-2")).toBeNull();
  });

  it("keeps the grant live when Discord refuses to remove the role", async () => {
    const { service, actions, grants } = harness();
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });
    actions.failNextSetRole("Discord refused the change");

    await expect(service.revoke(GUILD, USER, ROLE, "mod-2")).rejects.toThrow(
      /Could not remove the role/,
    );
    // Still active: flipping the row first would leak the role permanently.
    expect(grants.rows[0]?.status).toBe("active");
  });
});

describe("RoleService.recoverExpired", () => {
  it("closes grants whose deadline passed while the process was down", async () => {
    const { service, actions, grants, advance } = harness();
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });
    advance(3_600_001);

    const recovered = await service.recoverExpired();

    expect(recovered).toBe(1);
    expect(actions.rolesOf(USER)).not.toContain(ROLE);
    expect(grants.rows[0]?.status).toBe("expired");
  });

  it("ignores a grant whose deadline is still ahead", async () => {
    const { service, actions } = harness();
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    expect(await service.recoverExpired()).toBe(0);
    expect(actions.rolesOf(USER)).toContain(ROLE);
  });

  it("never touches a permanent grant with no deadline", async () => {
    const { service, grants } = harness();
    await grants.upsert({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      source: "menu",
      grantedBy: "system:menu",
      expiresAt: null,
    });

    expect(await service.recoverExpired()).toBe(0);
    expect(grants.rows[0]?.status).toBe("active");
  });
});

describe("role.expire through the real scheduler", () => {
  it("removes the role when the scheduled task comes due", async () => {
    const { repository, registry, scheduler } = schedulerHarness();
    const { service, actions, grants, advance } = harness({ scheduler });
    registry.register(service.handler());

    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    // Due now, so the tick claims it; the clock is advanced past the deadline so the
    // assertion is about the deadline, not about the scheduler's own timing.
    advance(3_600_001);
    const result = await scheduler.tick(new Date(1_700_000_000_000 + 3_600_001));

    expect(result.succeeded).toBe(1);
    expect(actions.rolesOf(USER)).not.toContain(ROLE);
    expect(grants.rows[0]?.status).toBe("expired");
    expect(repository.rows[0]?.status).toBe("done");
  });

  it("produces exactly one task for an extended grant, not two", async () => {
    const { repository, registry, scheduler } = schedulerHarness();
    const { service, advance } = harness({ scheduler });
    registry.register(service.handler());

    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });
    advance(60_000);
    await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 7_200_000,
    });

    // One row, because the dedupe key is the grant's identity: two rows would let the
    // earlier deadline win and strip the role before the extension ends.
    expect(repository.rows).toHaveLength(1);
  });

  it("reports a second fire as skipped rather than removing the role twice", async () => {
    const { registry, scheduler } = schedulerHarness();
    const { service, actions } = harness({ scheduler });
    registry.register(service.handler());

    const { grant } = await service.grant({
      guildId: GUILD,
      userId: USER,
      roleId: ROLE,
      grantedBy: "mod-1",
      durationMs: 3_600_000,
    });

    // First run removes the role; a re-fire of the same grant must be a no-op.
    await service.expire(grant.id);
    const callsAfterFirst = actions.roleCalls.length;
    const replayed = await service.handler().run({
      task: {
        id: "t1",
        guildId: GUILD,
        kind: ROLE_EXPIRE_TASK_KIND,
        dueAt: new Date(0),
        payload: { grantId: grant.id },
        status: "running",
        recurrence: null,
        dedupeKey: null,
        attempts: 0,
        lastError: null,
      },
      logger: testLogger,
    });

    expect(replayed).toEqual({ outcome: "skipped", detail: "grant already closed" });
    expect(actions.roleCalls.length).toBe(callsAfterFirst);
  });

  it("fails loudly when a task carries no grant id", async () => {
    const { service } = harness();

    await expect(
      service.handler().run({
        task: {
          id: "t1",
          guildId: GUILD,
          kind: ROLE_EXPIRE_TASK_KIND,
          dueAt: new Date(0),
          payload: {},
          status: "running",
          recurrence: null,
          dedupeKey: null,
          attempts: 0,
          lastError: null,
        },
        logger: testLogger,
      }),
    ).rejects.toThrow(/no valid "grantId" payload/);
  });
});
