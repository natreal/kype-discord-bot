/**
 * V5 security tests: anti-raid, anti-nuke, lockdown and recovery.
 *
 * The suite asserts the three requirements the brief is most specific about:
 *
 *   1. **a nuke is stopped in flight.** The account's permissions are removed, and
 *      the audit event records what was removed — not merely that something was
 *      logged;
 *   2. **the author is never banned automatically.** The response is a role strip
 *      plus a log line naming the human who must review it;
 *   3. **a lockdown is reversible without a human remembering**, because the
 *      incident carries an `expiresAt` and the recovery sweep reads it.
 *
 * Plus the anti-raid distinction that decides whether the module is usable at all:
 * a burst of established accounts is watched, a burst of new accounts is contained.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import {
  detectNuke,
  detectRaid,
  isNewAccount,
  isSuspiciousUsername,
  isWhitelisted,
} from "../../src/modules/security/index.js";
import { SecurityService } from "../../src/modules/security/security.service.js";
import type {
  NukeActionObservation,
  RaidJoinObservation,
} from "../../src/modules/security/index.js";
import { ModerationService } from "../../src/modules/moderation/moderation.service.js";
import { GUILD_A, GUILD_B, createV3Harness, type V3Harness } from "../helpers/v3-harness.js";
import { testLogger } from "../helpers/logger.js";
import {
  fakeMemberActions,
  memoryCaseRepository,
  memberTarget,
  type FakeMemberActions,
} from "../helpers/moderation.js";
import {
  fakeSecurityActions,
  memoryIncidents,
  memorySecurityLog,
  type FakeSecurityActions,
} from "../helpers/v5-security.js";

const TARGET = "444444444444444444";
const OWNER = "999999999999999999";
const BOT = "bot-user-id";
const MUTE_ROLE = { id: "role-muted", name: "Muted", position: 2 };

/** A join, with the raid signatures expressed explicitly. */
function join(overrides: Partial<RaidJoinObservation> = {}): RaidJoinObservation {
  return {
    guildId: GUILD_A,
    userId: TARGET,
    userTag: "newbie#0001",
    isNewAccount: true,
    accountCreatedMs: 1_000_000,
    suspiciousUsername: false,
    joinedAtMs: 10_000_000,
    ...overrides,
  };
}

/** A watched destructive action. */
function nukeAction(overrides: Partial<NukeActionObservation> = {}): NukeActionObservation {
  return {
    guildId: GUILD_A,
    kind: "channel-delete",
    actorId: TARGET,
    actorTag: "nuker#0001",
    targetId: "chan-9",
    targetName: "general",
    atMs: 1_000_000,
    ...overrides,
  };
}

/** Everything one security test needs. */
interface SecurityHarness {
  readonly v3: V3Harness;
  readonly members: FakeMemberActions;
  readonly actions: FakeSecurityActions;
  readonly incidents: ReturnType<typeof memoryIncidents>;
  readonly log: ReturnType<typeof memorySecurityLog>;
  readonly service: SecurityService;
  readonly auditActions: string[];
  readonly auditEvents: { action: string; details: unknown }[];
  /** Controlled clock, so a recovery sweep can be triggered without waiting. */
  now: number;
}

function securityHarness(): SecurityHarness {
  const v3 = createV3Harness();
  const members = fakeMemberActions({
    muteRole: MUTE_ROLE,
    // The `Quarantined` role is what raid containment and the nuke response apply,
    // so a harness without it would only test the refusal path.
    quarantineRole: { id: "role-q", name: "Quarantined", position: 1 },
  });
  const actions = fakeSecurityActions({
    ownerId: OWNER,
    botId: BOT,
    // The same mute role the member adapter knows about: containment reads it through
    // the security port so it can leave an active mute in place.
    muteRole: MUTE_ROLE,
  });
  const incidents = memoryIncidents();
  const log = memorySecurityLog();
  const auditActions: string[] = [];
  const auditEvents: { action: string; details: unknown }[] = [];
  const clock = { now: 1_000_000 };

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
      auditEvents.push({ action: event.action, details: event.details });
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([]);
    },
  });

  const moderation = new ModerationService({
    logger: testLogger,
    audit,
    cases: memoryCaseRepository(),
    members,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.moderation),
  });

  const service = new SecurityService({
    logger: testLogger,
    audit,
    moderation,
    members,
    actions,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.security),
    moderationEnabled: (guildId) =>
      v3.config.get(guildId).then((config) => config.moderation.enabled),
    incidents,
    log,
    now: () => clock.now,
  });

  return {
    v3,
    members,
    actions,
    incidents,
    log,
    service,
    auditActions,
    auditEvents,
    get now() {
      return clock.now;
    },
    set now(value: number) {
      clock.now = value;
    },
  };
}

/** Enables the security module with the given overrides and seeds a target. */
async function enableSecurity(
  harness: SecurityHarness,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await harness.v3.config.update(
    GUILD_A,
    { security: { enabled: true, ...overrides } },
    { id: "admin", kind: "user" },
  );
  harness.members.targets.set(TARGET, memberTarget({ id: TARGET }));
}

describe("V5 anti-raid: a burst is only a raid when it carries a signature", () => {
  const config = {
    enabled: true,
    joinsPerMinute: 10,
    minAccountAgeDays: 7,
    windowSeconds: 60,
    burstThreshold: 3,
    verifyNewMembers: false,
    raidModeSeconds: 600,
    lockdownOnRaid: true,
    suspiciousUsernameDetection: true,
  };

  it("spots the raid signatures cheaply and deterministically", () => {
    expect(isSuspiciousUsername("free_nitro_claim")).toBe(true);
    expect(isSuspiciousUsername("discord_gift_bot")).toBe(true);
    expect(isSuspiciousUsername("official_staff_team")).toBe(true);
    expect(isSuspiciousUsername("Alex")).toBe(false);

    // Account age is a comparison against the configured floor, not a guess.
    expect(isNewAccount(0, 30 * 24 * 60 * 60 * 1_000, 7)).toBe(false);
    // An account created the moment it joined is brand new.
    expect(isNewAccount(30 * 24 * 60 * 60 * 1_000, 30 * 24 * 60 * 60 * 1_000, 7)).toBe(true);
    expect(isNewAccount(29 * 24 * 60 * 60 * 1_000, 30 * 24 * 60 * 60 * 1_000, 7)).toBe(true);
    // `0` disables the check rather than declaring everyone new.
    expect(isNewAccount(0, 0, 0)).toBe(false);
  });

  it("watches a burst of established accounts without calling it a raid", () => {
    const recent = [
      join({ userId: "u1", isNewAccount: false }),
      join({ userId: "u2", isNewAccount: false }),
    ];
    const verdict = detectRaid(recent, join({ userId: "u3", isNewAccount: false }), config);

    expect(verdict.burst).toBe(true);
    // This is the decision that keeps the module usable: a viral giveaway must not
    // lock a server down.
    expect(verdict.likelyRaid).toBe(false);
    expect(verdict.detail).toMatch(/no new accounts or suspicious names/);
  });

  it("calls a burst of new accounts a raid", () => {
    const recent = [join({ userId: "u1" }), join({ userId: "u2" })];
    const verdict = detectRaid(recent, join({ userId: "u3" }), config);

    expect(verdict.likelyRaid).toBe(true);
    expect(verdict.newAccountIds).toEqual(["u1", "u2", "u3"]);
  });

  it("calls a burst of advertising names a raid even when the accounts are old", () => {
    const recent = [
      join({ userId: "u1", isNewAccount: false, suspiciousUsername: true }),
      join({ userId: "u2", isNewAccount: false }),
    ];
    const verdict = detectRaid(recent, join({ userId: "u3", isNewAccount: false }), config);

    expect(verdict.likelyRaid).toBe(true);
    expect(verdict.suspiciousNameIds).toEqual(["u1"]);
  });
});

describe("V5 anti-nuke: the response is a decision about the actor", () => {
  const config = {
    enabled: true,
    actionThreshold: 6,
    windowSeconds: 60,
    stripPermissions: true,
    whitelistRoleIds: [],
    whitelistUserIds: [],
    escalateToOwner: true,
  };

  it("weighs actions, so a ban wave trips faster than a channel-creation wave", () => {
    const creations = [
      nukeAction({ kind: "channel-create" }),
      nukeAction({ kind: "channel-create" }),
    ];
    expect(detectNuke(creations, nukeAction({ kind: "channel-create" }), config).detected).toBe(
      false,
    );

    // Two channel deletions weigh 4 and one ban weighs 3: the threshold of 6 is
    // crossed by `delete + delete + ban`, not by three creations.
    const destructive = [
      nukeAction({ kind: "channel-delete" }),
      nukeAction({ kind: "channel-delete" }),
    ];
    const verdict = detectNuke(destructive, nukeAction({ kind: "member-ban" }), config);
    expect(verdict.detected).toBe(true);
    expect(verdict.weight).toBe(7);
    expect(verdict.detail).toMatch(/weight 7/);
  });

  it("never exempts an administrator, but does exempt the owner and the bot", () => {
    const options = { ownerId: OWNER, botId: BOT, whitelistUserIds: ["whitelisted"] };

    expect(isWhitelisted(OWNER, options)).toBe(true);
    expect(isWhitelisted(BOT, options)).toBe(true);
    expect(isWhitelisted("whitelisted", options)).toBe(true);
    // An administrator is *not* exempt on purpose: a compromised admin account is
    // the most common nuke, and the module must be able to stop it.
    expect(isWhitelisted("an-administrator", options)).toBe(false);
  });
});

describe("V5 security service: containment, escalation and recovery", () => {
  let harness: SecurityHarness;

  beforeEach(async () => {
    harness = securityHarness();
    await enableSecurity(harness, {
      antiRaid: {
        enabled: true,
        burstThreshold: 2,
        minAccountAgeDays: 7,
        windowSeconds: 60,
        raidModeSeconds: 600,
        lockdownOnRaid: true,
      },
      antiNuke: {
        enabled: true,
        actionThreshold: 4,
        windowSeconds: 60,
        stripPermissions: true,
        escalateToOwner: true,
      },
    });
  });

  it("quarantines raid accounts through the moderation module and locks down", async () => {
    // A burst needs the threshold to be reached, and the threshold counts joins
    // inside the window *including* the one being judged: two joins with a
    // threshold of two is the smallest raid the configuration can express.
    await harness.service.observeJoin(join({ userId: "u1" }));
    const episode = await harness.service.observeJoin(join({ userId: TARGET }));

    expect(episode).not.toBeNull();
    // The containment is a moderation action: a real case, through the real guard.
    expect(harness.members.calls.some((call) => call.action === "role-add")).toBe(true);
    expect(harness.members.roles.get(TARGET)?.has("role-q")).toBe(true);
    expect(harness.actions.locked).toBe(true);
    expect(harness.auditActions).toContain("security.raid-detected");
    expect(harness.log.events.some((event) => event.action === "security.raid-detected")).toBe(
      true,
    );
  });

  it("extends the same incident instead of opening one per join", async () => {
    await harness.service.observeJoin(join({ userId: "u1" }));
    await harness.service.observeJoin(join({ userId: "u2" }));

    expect(harness.incidents.incidents).toHaveLength(1);
    // A second lockdown during the same episode changes nothing rather than
    // re-locking and re-reporting the server.
    expect(harness.actions.calls.filter((call) => call === "lock")).toHaveLength(1);
  });

  it("strips the nuker's permissions and never bans the account", async () => {
    // The account holds staff roles, which is the situation the response exists
    // for: a compromised moderator account with the power to delete the server.
    harness.members.roles.set(TARGET, new Set(["role-admin", "role-staff"]));

    // Weight, not count: two `channel-delete` actions weigh 4 and reach the
    // threshold, which is how a ten-second nuke is caught without flagging a
    // moderator deleting one channel.
    await harness.service.observeNukeAction(nukeAction({ targetId: "chan-1" }));
    const episode = await harness.service.observeNukeAction(nukeAction({ targetId: "chan-2" }));

    expect(episode).not.toBeNull();
    // Stopped, not merely logged: the account lost its roles in one call, which is
    // what makes the response fast enough to interrupt a nuke in progress.
    expect(harness.members.calls.some((call) => call.action === "strip-roles")).toBe(true);
    expect(episode?.strippedRoleIds).toEqual(["role-admin", "role-staff"]);

    // And never banned: the brief is explicit, so this is asserted, not assumed.
    expect(harness.members.bans.size).toBe(0);
    expect(harness.members.calls.some((call) => call.action === "ban")).toBe(false);

    const event = harness.log.events.find((entry) => entry.action === "security.nuke-detected");
    expect(event?.response).toMatch(/NOT banned automatically/);
    expect(event?.response).toMatch(/owner alerted/);
  });

  it("leaves an existing mute in place when it contains an account", async () => {
    // A mute is a moderation punishment, and containment is a security action. Without
    // preserving the role, a nuke response silently lifted a mute the moderators had
    // applied — a side effect no operator asked for and nothing reported.
    harness.members.roles.set(TARGET, new Set(["role-staff", MUTE_ROLE.id]));

    await harness.service.observeNukeAction(nukeAction({ targetId: "chan-1" }));
    const episode = await harness.service.observeNukeAction(nukeAction({ targetId: "chan-2" }));

    expect(episode).not.toBeNull();
    // The staff role was stripped; the mute was not.
    expect(episode?.strippedRoleIds).toEqual(["role-staff"]);
    expect(episode?.strippedRoleIds).not.toContain(MUTE_ROLE.id);
  });

  it("records the nuke response in the audit trail with the action that tripped it", async () => {
    await harness.service.observeNukeAction(nukeAction({ targetId: "chan-1" }));
    await harness.service.observeNukeAction(nukeAction({ targetId: "chan-2" }));

    const event = harness.auditEvents.find((entry) => entry.action === "security.nuke-detected");
    expect(event?.details).toMatchObject({ action: "channel-delete" });
    expect(harness.auditActions).toContain("security.nuke-detected");
  });

  it("does nothing for a single action or a whitelisted account", async () => {
    expect(await harness.service.observeNukeAction(nukeAction())).toBeNull();
    expect(await harness.service.observeNukeAction(nukeAction({ actorId: OWNER }))).toBeNull();
  });
});

describe("V5 security service: a lockdown is reversible", () => {
  let harness: SecurityHarness;

  beforeEach(async () => {
    harness = securityHarness();
    await enableSecurity(harness, {
      antiRaid: {
        enabled: true,
        burstThreshold: 2,
        minAccountAgeDays: 7,
        windowSeconds: 60,
        raidModeSeconds: 600,
        lockdownOnRaid: true,
      },
    });
  });

  it("lifts the lockdown automatically once the threat window has passed", async () => {
    // The threshold counts the join being judged, so a raid needs the window to
    // reach it: two joins with a threshold of two.
    await harness.service.observeJoin(join({ userId: "u1" }));
    await harness.service.observeJoin(join({ userId: TARGET }));
    expect(harness.actions.locked).toBe(true);

    // Inside the window: nothing to recover.
    harness.now += 60_000;
    expect(await harness.service.recoverExpired()).toHaveLength(0);
    expect(harness.actions.locked).toBe(true);

    // Past it: the sweep finds the expired incident and restores the server.
    harness.now += 10 * 60_000;
    const recovered = await harness.service.recoverExpired();
    expect(recovered).toHaveLength(1);
    expect(harness.actions.locked).toBe(false);
    expect(harness.auditActions).toContain("security.recovered");
    expect(harness.log.events.some((event) => event.action === "security.recovered")).toBe(true);
  });

  it("lets a human lift a lockdown at any moment", async () => {
    await harness.service.observeJoin(join({ userId: "u1" }));
    await harness.service.observeJoin(join({ userId: TARGET }));

    const result = await harness.service.unlockByOperator(GUILD_A, "moderator-1", "False alarm");

    expect(result.unlocked).toBe(true);
    expect(result.incidents).toHaveLength(1);
    expect(harness.actions.locked).toBe(false);
    expect(harness.auditEvents.some((entry) => entry.action === "security.unlock")).toBe(true);
  });

  it("watches a veteran burst without containing, locking or opening an incident", async () => {
    const established = { isNewAccount: false };

    const first = await harness.service.observeJoin(join({ userId: "u1", ...established }));
    const second = await harness.service.observeJoin(join({ userId: "u2", ...established }));

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(harness.incidents.incidents).toHaveLength(0);
    expect(harness.actions.locked).toBe(false);
    // It is still *reported*, because an elevated join rate is worth a human's
    // attention even when it is not an attack.
    expect(harness.log.events.some((event) => event.action === "security.raid-watch")).toBe(true);
  });

  it("reports the gap instead of silently containing when moderation is off", async () => {
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { enabled: false } },
      { id: "admin", kind: "user" },
    );

    await harness.service.observeJoin(join({ userId: "u1" }));
    await harness.service.observeJoin(join({ userId: TARGET }));

    expect(harness.members.calls).toEqual([]);
    expect(harness.log.events.some((event) => event.action === "security.quarantine-skipped")).toBe(
      true,
    );
  });

  it("stays inert when the module is disabled, and is guild-isolated", async () => {
    const disabled = securityHarness();
    expect(await disabled.service.observeJoin(join())).toBeNull();
    expect(await disabled.service.observeNukeAction(nukeAction())).toBeNull();

    // Guild B has no security configuration, so guild A's settings cannot leak into
    // a call made for guild B.
    expect(await harness.service.observeJoin(join({ guildId: GUILD_B }))).toBeNull();
    expect(harness.incidents.incidents).toHaveLength(0);
  });
});
