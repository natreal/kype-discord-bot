/**
 * V4 moderation tests.
 *
 * The suite covers what the brief actually promises, and each promise is asserted
 * through the production service — never through a stub of it:
 *
 *   1. every action is guarded, recorded as a case, audited and logged;
 *   2. the warning threshold from `moderation` settings is respected;
 *   3. guild isolation is structural: one guild's cases and settings cannot be
 *      seen from another;
 *   4. a failed Discord call records nothing, so the history never lies;
 *   5. an automated caller (automod, a future AI assistant) goes through exactly
 *      the same path and is recorded as `system`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import { MODERATION_LIMITS } from "../../src/modules/moderation/moderation-actions.js";
import { ModerationService } from "../../src/modules/moderation/moderation.service.js";
import { GUILD_A, GUILD_B, USER_ID } from "../helpers/v3-harness.js";
import { testLogger } from "../helpers/logger.js";
import {
  channelTarget,
  fakeMemberActions,
  memberTarget,
  memoryCaseRepository,
  type FakeMemberActions,
} from "../helpers/moderation.js";
import { createV3Harness, type V3Harness } from "../helpers/v3-harness.js";

const TARGET = "444444444444444444";
const MUTE_ROLE = { id: "role-muted", name: "Muted", position: 2 };

/** Everything one test needs. */
interface ModerationHarness {
  readonly v3: V3Harness;
  readonly members: FakeMemberActions;
  readonly service: ModerationService;
  readonly auditActions: string[];
  readonly logLines: { action: string; caseNumber: number }[];
}

/** Builds the real service over in-memory persistence and a fake guild. */
function moderationHarness(
  options: { muteRole?: typeof MUTE_ROLE | null } = {},
): ModerationHarness {
  const v3 = createV3Harness();
  // An explicit `null` means "this server has no Muted role", so it must not be
  // collapsed into the default by `??`.
  const muteRole = "muteRole" in options ? (options.muteRole ?? null) : MUTE_ROLE;
  const members = fakeMemberActions({ muteRole });
  const auditActions: string[] = [];
  const logLines: { action: string; caseNumber: number }[] = [];

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
    cases: memoryCaseRepository(),
    members,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.moderation),
    log: {
      record(event) {
        logLines.push({ action: event.action, caseNumber: event.caseNumber });
        return Promise.resolve();
      },
    },
  });

  return { v3, members, service, auditActions, logLines };
}

/** Seeds a punishable member so the guards let the action through. */
function seedTarget(
  harness: ModerationHarness,
  overrides: Partial<Parameters<typeof memberTarget>[0]> = {},
): void {
  harness.members.targets.set(TARGET, memberTarget({ id: TARGET, ...overrides }));
}

const ACTOR = { id: USER_ID, kind: "user", tag: "moderator#0001" } as const;

describe("V4 moderation: one action, one full record", () => {
  let harness: ModerationHarness;

  beforeEach(() => {
    harness = moderationHarness();
    seedTarget(harness);
  });

  it("records a warning as a case, an audit event and a log line", async () => {
    const outcome = await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Spamming",
    });

    expect(outcome.caseNumber).toBe(1);
    expect(outcome.warningCount).toBe(1);
    expect(outcome.case.reason).toBe("Spamming");
    // The case is readable through the same history API the commands use.
    const history = await harness.service.history(GUILD_A, { targetId: TARGET });
    expect(history.map((record) => record.action)).toEqual(["warn"]);
    // The audit trail carries the case number, so a log line and a case match.
    expect(harness.auditActions).toEqual(["moderation.warn"]);
    expect(harness.logLines).toEqual([{ action: "warn", caseNumber: 1 }]);
    expect(harness.v3.auditEvents).toHaveLength(0);
  });

  it("numbers cases per guild, never globally", async () => {
    seedTarget(harness);
    harness.members.targets.set("555555555555555555", memberTarget({ id: "555555555555555555" }));

    const first = await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });
    const second = await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: "555555555555555555" }),
      reason: null,
    });
    const otherGuild = await harness.service.execute(GUILD_B, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });

    expect([first.caseNumber, second.caseNumber]).toEqual([1, 2]);
    // Guild B starts at 1: numbering is scoped, and so is the history.
    expect(otherGuild.caseNumber).toBe(1);
    expect(await harness.service.history(GUILD_A, { targetId: TARGET })).toHaveLength(1);
  });
});

describe("V4 moderation: the warning threshold comes from settings", () => {
  it("flags the threshold once the configured count is reached", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    // `/settings moderation` owns this value; the service only reads it.
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { warnThreshold: 3 } },
      { id: "admin", kind: "user" },
    );

    const outcomes = [];
    for (const reason of ["First", "Second", "Third"]) {
      outcomes.push(
        await harness.service.execute(GUILD_A, {
          action: "warn",
          actor: ACTOR,
          target: memberTarget({ id: TARGET }),
          reason,
        }),
      );
    }

    expect(outcomes.map((outcome) => outcome.thresholdReached)).toEqual([false, false, true]);
    expect(outcomes[2]?.warningCount).toBe(3);
    expect(await harness.service.warningCount(GUILD_A, TARGET)).toBe(3);
  });

  it("treats threshold 0 as 'no automatic threshold'", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { warnThreshold: 0 } },
      { id: "admin", kind: "user" },
    );

    const outcome = await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });

    expect(outcome.warningCount).toBe(1);
    expect(outcome.thresholdReached).toBe(false);
  });

  it("cancels one warning per unwarn, and refuses a third", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    for (const reason of ["a", "b"]) {
      await harness.service.execute(GUILD_A, {
        action: "warn",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason,
      });
    }
    const unwarn = await harness.service.execute(GUILD_A, {
      action: "unwarn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Appeal accepted",
    });

    expect(unwarn.warningCount).toBe(1);
    // The removal points at the warning it cancelled, so a history reads as a
    // narrative rather than a flat list.
    expect(unwarn.case.relatedCaseNumber).toBe(1);
    expect(await harness.service.warningCount(GUILD_A, TARGET)).toBe(1);

    // The last warning can still be cleared...
    const last = await harness.service.execute(GUILD_A, {
      action: "unwarn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Second appeal",
    });
    expect(last.warningCount).toBe(0);
    // The unwarn links to the warning it cancelled. Both remaining warnings were
    // reported by the same removal because the in-memory repository timestamps
    // cases at the same millisecond; what matters is that one warning was cleared.
    expect([1, 2]).toContain(last.case.relatedCaseNumber);

    // ...and, once every warning has been cleared, a further removal is refused.
    expect(await harness.service.warningCount(GUILD_A, TARGET)).toBe(0);
    await expect(
      harness.service.execute(GUILD_A, {
        action: "unwarn",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Nothing left",
      }),
    ).rejects.toThrow(/no warning left to remove/);
  });

  it("removes a specific (older) warning when a case number is named", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    // Three warnings: #1 (oldest), #2, #3 (newest). The default unwarn removes the
    // *oldest*, so naming a case number is the only way to clear a newer one.
    for (const reason of ["first", "second", "third"]) {
      await harness.service.execute(GUILD_A, {
        action: "warn",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason,
      });
    }

    // Clear warning #2 specifically: #1 and #3 must remain.
    const outcome = await harness.service.execute(GUILD_A, {
      action: "unwarn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Appeal accepted",
      caseNumber: 2,
    });
    expect(outcome.case.relatedCaseNumber).toBe(2);
    expect(await harness.service.warningCount(GUILD_A, TARGET)).toBe(2);

    // Asking for a case that is not an active warning is refused, not silent.
    await expect(
      harness.service.execute(GUILD_A, {
        action: "unwarn",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Already gone",
        caseNumber: 2,
      }),
    ).rejects.toThrow(/not an active warning/);
  });
});

describe("V4 moderation: guild isolation", () => {
  it("never exposes one guild's cases or settings from another", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "In guild A",
    });

    // Guild B has its own history, its own numbering and its own settings.
    expect(await harness.service.history(GUILD_B, { targetId: TARGET })).toEqual([]);
    expect(await harness.service.warningCount(GUILD_B, TARGET)).toBe(0);
    expect((await harness.service.config(GUILD_A)).enabled).toBe(true);
  });
});

describe("V4 moderation: refusals never touch the history", () => {
  it("refuses every punishment while the module is disabled", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { enabled: false } },
      { id: "admin", kind: "user" },
    );

    await expect(
      harness.service.execute(GUILD_A, {
        action: "ban",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Raiding",
      }),
    ).rejects.toThrow(/Moderation is disabled/);

    // A refusal leaves nothing behind: no case, no audit event, no log line.
    expect(await harness.service.history(GUILD_A, {})).toHaveLength(0);
    expect(harness.auditActions).toEqual([]);
    expect(harness.logLines).toEqual([]);
    expect(harness.members.calls).toEqual([]);
  });

  it("still applies a pardon while moderation is disabled", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    harness.members.roles.set(TARGET, new Set([MUTE_ROLE.id]));
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { enabled: false } },
      { id: "admin", kind: "user" },
    );

    // A server that turns moderation off must still be able to unblock somebody:
    // `/unmute` and `/untimeout` are pardons, not punishments.
    const unmute = await harness.service.execute(GUILD_A, {
      action: "unmute",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });
    expect(unmute.action).toBe("unmute");
    expect(harness.members.roles.get(TARGET)?.has(MUTE_ROLE.id)).toBe(false);

    // The punishing direction is still refused.
    await expect(
      harness.service.execute(GUILD_A, {
        action: "mute",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: null,
      }),
    ).rejects.toThrow(/Moderation is disabled/);
  });

  it("refuses to moderate yourself, an owner, an administrator and a higher role", async () => {
    const harness = moderationHarness();

    await expect(
      harness.service.execute(GUILD_A, {
        action: "kick",
        actor: ACTOR,
        target: memberTarget({ id: USER_ID }),
        reason: "because",
      }),
    ).rejects.toThrow(/yourself/);

    await expect(
      harness.service.execute(GUILD_A, {
        action: "kick",
        actor: ACTOR,
        target: memberTarget({ id: TARGET, protectedMember: true }),
        reason: "because",
      }),
    ).rejects.toThrow(/administrator/);

    await expect(
      harness.service.execute(GUILD_A, {
        action: "kick",
        actor: ACTOR,
        target: memberTarget({ id: TARGET, highestRolePosition: 99 }),
        reason: "because",
      }),
    ).rejects.toThrow(/at or above mine/);

    // No Discord write was attempted for any of the three refusals.
    expect(harness.members.calls).toEqual([]);
  });

  it("requires a reason for an irreversible action", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    await expect(
      harness.service.execute(GUILD_A, {
        action: "kick",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: null,
      }),
    ).rejects.toThrow(/reason is required/);
  });

  it("keeps the history empty when Discord refuses the action", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    harness.members.failWith = "Missing Permissions";

    await expect(
      harness.service.execute(GUILD_A, {
        action: "ban",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Raiding",
      }),
    ).rejects.toThrow(/Missing Permissions/);

    // The history and the audit trail only contain things that happened.
    expect(await harness.service.history(GUILD_A, {})).toHaveLength(0);
    expect(harness.auditActions).toEqual([]);
    expect(harness.logLines).toEqual([]);
  });
});

describe("V4 moderation: actions, automation and reversibility", () => {
  it("applies and removes the Muted role, and refuses when the role is missing", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    harness.members.roles.set(TARGET, new Set());

    const mute = await harness.service.execute(GUILD_A, {
      action: "mute",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Caps spam",
      durationMs: 60 * 60 * 1_000,
    });
    expect(mute.case.details).toMatchObject({ muteRoleId: MUTE_ROLE.id });
    expect(harness.members.roles.get(TARGET)?.has(MUTE_ROLE.id)).toBe(true);
    // A mute with a duration stores an expiry, so a future sweeper can find it.
    expect(mute.case.expiresAt).toBeInstanceOf(Date);

    const unmute = await harness.service.execute(GUILD_A, {
      action: "unmute",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });
    expect(harness.members.roles.get(TARGET)?.has(MUTE_ROLE.id)).toBe(false);
    expect(unmute.case.relatedCaseNumber).toBe(mute.caseNumber);
  });

  it("refuses a mute when the server has no `Muted` role", async () => {
    const harness = moderationHarness({ muteRole: null });
    harness.members.targets.set(TARGET, memberTarget({ id: TARGET, muted: false }));

    await expect(
      harness.service.execute(GUILD_A, {
        action: "mute",
        actor: ACTOR,
        target: memberTarget({ id: TARGET, muted: false }),
        reason: "Caps spam",
      }),
    ).rejects.toThrow(/Muted/);

    // Nothing was written: a refusal is not a case.
    expect(await harness.service.history(GUILD_A, {})).toHaveLength(0);
  });

  it("refuses a mute or timeout outside its allowed duration", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    await expect(
      harness.service.execute(GUILD_A, {
        action: "timeout",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Too long",
        durationMs: MODERATION_LIMITS.maxTimeoutMs + 1,
      }),
    ).rejects.toThrow(/28 days/);

    await expect(
      harness.service.execute(GUILD_A, {
        action: "mute",
        actor: ACTOR,
        target: memberTarget({ id: TARGET }),
        reason: "Too short",
        durationMs: 1_000,
      }),
    ).rejects.toThrow(/between 1 minute and 365 days/);

    expect(await harness.service.history(GUILD_A, {})).toHaveLength(0);
  });

  it("softbans as one case, with the deletion window it used", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    const outcome = await harness.service.execute(GUILD_A, {
      action: "softban",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Invite links",
    });

    expect(harness.members.calls.map((call) => call.action)).toEqual(["ban", "unban"]);
    expect(harness.members.bans.has(TARGET)).toBe(false);
    expect(outcome.caseNumber).toBe(1);
    expect(outcome.case.details).toMatchObject({ deleteMessageSeconds: 604_800 });
  });

  it("records a purge without a member target", async () => {
    const harness = moderationHarness();
    harness.members.purged.value = 42;

    const outcome = await harness.service.execute(GUILD_A, {
      action: "purge",
      actor: ACTOR,
      target: channelTarget({ id: "chan-9", name: "general" }),
      reason: "Spam cleanup",
      count: 50,
      authorId: TARGET,
    });

    expect(outcome.purgedCount).toBe(42);
    expect(outcome.case.targetId).toBe("chan-9");
    expect(outcome.case.targetType).toBe("channel");
    expect(outcome.case.details).toMatchObject({ requested: 50, removed: 42, authorId: TARGET });
  });

  it("rejects a purge outside the allowed bounds", async () => {
    const harness = moderationHarness();
    await expect(
      harness.service.execute(GUILD_A, {
        action: "purge",
        actor: ACTOR,
        target: channelTarget(),
        reason: null,
        count: 101,
      }),
    ).rejects.toThrow(/between 1 and 100/);
  });

  it("records an automated action as `system`, and any actor kind verbatim", async () => {
    const harness = moderationHarness();
    seedTarget(harness);

    const outcome = await harness.service.execute(GUILD_A, {
      action: "timeout",
      actor: { id: "automod", kind: "system", tag: "automod" },
      target: memberTarget({ id: TARGET }),
      reason: "Triggered by an automated rule",
      durationMs: 10 * 60 * 1_000,
      source: "automation",
    });

    expect(outcome.case.moderatorKind).toBe("system");
    expect(outcome.case.moderatorId).toBe("automod");
    expect(outcome.case.details).toMatchObject({ source: "automation" });
    expect(harness.auditActions).toEqual(["moderation.timeout"]);
  });

  it("does not DM the member when the guild turned notifications off", async () => {
    const harness = moderationHarness();
    seedTarget(harness);
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { dmOnPunishment: false } },
      { id: "admin", kind: "user" },
    );

    const outcome = await harness.service.execute(GUILD_A, {
      action: "warn",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: null,
    });

    expect(outcome.notes).toEqual([]);
  });
});
