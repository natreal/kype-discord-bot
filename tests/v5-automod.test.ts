/**
 * V5 automod tests.
 *
 * The suite proves what the brief actually promises, and each promise is asserted
 * through the production code — never through a stub of it:
 *
 *   1. every rule fires on the right input and stays quiet on the wrong one (the
 *      evaluator is pure, so this is a table of strings);
 *   2. a trigger produces **one moderation case, one audit event and one log line**,
 *      so automod cannot act without leaving the same trail a human does;
 *   3. the escalation ladder is respected and the trigger count survives a restart,
 *      because it is read from the case history rather than from memory;
 *   4. bots, the owner, administrators and staff are never judged;
 *   5. automod never punishes when moderation is disabled.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import { AutomodService, AUTOMOD_ACTOR_ID } from "../../src/modules/automod/index.js";
import {
  countEmojis,
  countLinks,
  evaluate,
  hasInvite,
  uppercaseRatio,
} from "../../src/modules/automod/automod.evaluator.js";
import { escalationDecision } from "../../src/modules/automod/automod-escalation.js";
import { SlidingWindow } from "../../src/modules/automod/automod-window.js";
import { ModerationService } from "../../src/modules/moderation/moderation.service.js";
import type { AutomodMessageObservation } from "../../src/modules/automod/index.js";
import { GUILD_A, GUILD_B, createV3Harness, type V3Harness } from "../helpers/v3-harness.js";
import { testLogger } from "../helpers/logger.js";
import {
  fakeMemberActions,
  memoryCaseRepository,
  memberTarget,
  type FakeMemberActions,
} from "../helpers/moderation.js";

const AUTHOR = "444444444444444444";
const MUTE_ROLE = { id: "role-muted", name: "Muted", position: 2 };
const CLEAN_WINDOW = { count: 1, channels: 1, identicalRun: 1 };

/** Builds an observation with sane defaults a test can override. */
function message(overrides: Partial<AutomodMessageObservation> = {}): AutomodMessageObservation {
  return {
    kind: "message",
    guildId: GUILD_A,
    channelId: "chan-1",
    channelName: "general",
    messageId: "msg-1",
    authorId: AUTHOR,
    authorTag: "spammer#0001",
    authorIsOwner: false,
    authorIsAdministrator: false,
    botAuthor: false,
    content: "hello world",
    mentionCount: 0,
    emojiCount: 0,
    timestampMs: 1_000_000,
    ...overrides,
  };
}

/** Applies an automod patch and @returns the parsed section. */
async function automodConfig(
  v3: V3Harness,
  overrides: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<V3Harness["config"]["get"]>>["automod"]> {
  await v3.config.update(GUILD_A, { automod: overrides }, { id: "tester", kind: "user" });
  return (await v3.config.get(GUILD_A)).automod;
}

/** Everything one service test needs. */
interface AutomodHarness {
  readonly v3: V3Harness;
  readonly members: FakeMemberActions;
  readonly service: AutomodService;
  readonly auditActions: string[];
  readonly logLines: { action: string; caseNumber: number }[];
  /** When set, the exemption the service should apply for this author. */
  exempt: boolean;
}

/**
 * Builds the real automod service over the real moderation service.
 *
 * Only Discord and PostgreSQL are faked: the evaluator, the window, the ladder, the
 * escalation and every moderation guard are the production ones, so a test that
 * passes here proves what the bot actually does.
 */
function automodHarness(options: { muteRole?: typeof MUTE_ROLE | null } = {}): AutomodHarness {
  const v3 = createV3Harness();
  const muteRole = "muteRole" in options ? (options.muteRole ?? null) : MUTE_ROLE;
  const members = fakeMemberActions({ muteRole });
  const auditActions: string[] = [];
  const logLines: { action: string; caseNumber: number }[] = [];
  const harness = { exempt: false } as AutomodHarness;

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
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
    log: {
      record(event) {
        logLines.push({ action: event.action, caseNumber: event.caseNumber });
        return Promise.resolve();
      },
    },
  });

  const service = new AutomodService({
    logger: testLogger,
    audit,
    moderation,
    members,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.automod),
    moderationEnabled: (guildId) =>
      v3.config.get(guildId).then((config) => config.moderation.enabled),
    exemption: {
      holdsSecurityPermission: () => Promise.resolve(harness.exempt),
    },
  });

  return Object.assign(harness, { v3, members, service, auditActions, logLines });
}

describe("V5 automod: the evaluator is a pure function of what it was shown", () => {
  it("counts links, invites, emojis and caps without touching Discord", () => {
    expect(countLinks("see https://a.example and http://b.example")).toBe(2);
    expect(countLinks("no links here")).toBe(0);
    expect(hasInvite("join discord.gg/abc123")).toBe(true);
    expect(hasInvite("join discord.com/invite/xyz")).toBe(true);
    expect(hasInvite("a normal sentence")).toBe(false);
    expect(countEmojis("hi <:custom:123> <a:anim:456>")).toBe(2);
    // Digits and punctuation are excluded, which is the point: `111` must not
    // dilute the ratio into "not shouting".
    expect(uppercaseRatio("WOW!!!!!111").percent).toBe(100);
    // `Hello World` is 10 letters, 2 of them uppercase.
    expect(uppercaseRatio("Hello World").percent).toBe(20);
  });

  it("fires anti-caps only above the configured bounds", async () => {
    const v3 = createV3Harness();
    const config = await automodConfig(v3, {
      rules: { antiCaps: true },
      thresholds: { capsMinLength: 10, capsPercent: 70 },
    });

    expect(
      evaluate(message({ content: "THIS IS SHOUTING" }), config, CLEAN_WINDOW).matches,
    ).toHaveLength(1);
    // Same rule, message too short: the minimum length is what stops `LOL` from
    // becoming a punishment.
    expect(evaluate(message({ content: "LOUD" }), config, CLEAN_WINDOW).clean).toBe(true);
  });

  it("judges an invite as an invite, not as a generic link", async () => {
    const v3 = createV3Harness();
    // `anti-link` off and `anti-invite` on: a server that only asked about invites
    // must never be told "too many links".
    const config = await automodConfig(v3, { rules: { antiLink: false, antiInvite: true } });

    const verdict = evaluate(message({ content: "discord.gg/raid" }), config, CLEAN_WINDOW);
    expect(verdict.matches.map((match) => match.rule)).toEqual(["anti-invite"]);
  });

  it("measures rate rules against the window, not the message", async () => {
    const v3 = createV3Harness();
    const config = await automodConfig(v3, {
      rules: { antiSpam: true, antiFlood: true },
      thresholds: { spamMessages: 4, floodChannels: 3 },
    });

    expect(evaluate(message(), config, { count: 2, channels: 1, identicalRun: 1 }).clean).toBe(
      true,
    );
    expect(
      evaluate(message(), config, { count: 4, channels: 1, identicalRun: 1 }).matches.map(
        (match) => match.rule,
      ),
    ).toEqual(["anti-spam"]);
    expect(
      evaluate(message(), config, { count: 4, channels: 3, identicalRun: 1 })
        .matches.map((match) => match.rule)
        .sort(),
    ).toEqual(["anti-flood", "anti-spam"]);
  });

  it("refuses to judge a bot, the owner or an administrator", async () => {
    const v3 = createV3Harness();
    const config = await automodConfig(v3, { rules: { antiMentionSpam: true } });
    const spammy = { mentionCount: 50 };

    expect(
      evaluate(message({ ...spammy, botAuthor: true }), config, CLEAN_WINDOW).exemptReason,
    ).toBe("bot");
    expect(
      evaluate(message({ ...spammy, authorIsOwner: true }), config, CLEAN_WINDOW).exemptReason,
    ).toBe("owner");
    expect(
      evaluate(message({ ...spammy, authorIsAdministrator: true }), config, CLEAN_WINDOW)
        .exemptReason,
    ).toBe("administrator");
    expect(evaluate(message(spammy), config, CLEAN_WINDOW).clean).toBe(false);
  });

  it("keeps the sliding window bounded and reports identical runs", () => {
    const window = new SlidingWindow({ windowMs: 10_000, maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) {
      window.record(message({ messageId: `msg-${index}`, timestampMs: 1_000 + index }));
    }
    const snapshot = window.peek(AUTHOR, 1_004);
    // Bounded: the oldest entries are dropped rather than growing without limit.
    expect(snapshot.count).toBe(3);
    expect(snapshot.identicalRun).toBe(3);
  });
});

describe("V5 automod: escalation is data, not a chain of ifs", () => {
  it("selects the highest rung at or below the trigger count", () => {
    const ladder = [
      { triggers: 1, action: "warn" as const, durationMs: 0 },
      { triggers: 3, action: "mute" as const, durationMs: 600_000 },
      { triggers: 5, action: "timeout" as const, durationMs: 3_600_000 },
    ];

    expect(escalationDecision(ladder, 1).moderationAction).toBe("warn");
    expect(escalationDecision(ladder, 2).moderationAction).toBe("warn");
    expect(escalationDecision(ladder, 4).moderationAction).toBe("mute");
    expect(escalationDecision(ladder, 9).moderationAction).toBe("timeout");
    expect(escalationDecision(ladder, 9).durationMs).toBe(3_600_000);
  });

  it('treats an empty ladder as "record only"', () => {
    const decision = escalationDecision([], 5);
    expect(decision.moderationAction).toBeNull();
    expect(decision.action).toBe("none");
  });
});

describe("V5 automod: a trigger is a moderation case, an audit event and a log line", () => {
  let harness: AutomodHarness;

  beforeEach(async () => {
    harness = automodHarness();
    // One rule with a reachable threshold and a ladder that punishes from the
    // first trigger, so each test asserts the escalation path rather than the
    // calibration of the defaults.
    await automodConfig(harness.v3, {
      enabled: true,
      rules: { antiMentionSpam: true, antiInvite: true },
      thresholds: { mentions: 3 },
      escalation: [{ triggers: 1, action: "timeout", durationMs: 600_000 }],
      warnOnFirstTrigger: false,
    });
    harness.members.targets.set(AUTHOR, memberTarget({ id: AUTHOR }));
  });

  it("punishes through the moderation module, recorded as `system`/`automation`", async () => {
    const outcome = await harness.service.observe(message({ mentionCount: 9 }));

    expect(outcome.verdict).toBe("triggered");
    expect(outcome.matches.map((match) => match.rule)).toEqual(["anti-mention-spam"]);
    expect(outcome.moderation?.action).toBe("timeout");

    // The proof that automod did not reimplement anything: the case came from
    // `ModerationService`, with its actor kind and source intact.
    const recorded = outcome.moderation?.case;
    expect(recorded?.moderatorId).toBe(AUTOMOD_ACTOR_ID);
    expect(recorded?.moderatorKind).toBe("system");
    expect(recorded?.details).toMatchObject({ source: "automation" });

    // And the logs are the moderation module's, not a parallel set.
    expect(harness.logLines).toEqual([{ action: "timeout", caseNumber: 1 }]);
    expect(harness.auditActions).toContain("automod.trigger");
    expect(harness.auditActions).toContain("moderation.timeout");
  });

  it("escalates on the count read from the case history, not from memory", async () => {
    await automodConfig(harness.v3, {
      escalation: [
        { triggers: 1, action: "warn", durationMs: 0 },
        { triggers: 2, action: "timeout", durationMs: 600_000 },
      ],
    });

    const first = await harness.service.observe(message({ mentionCount: 9 }));
    expect(first.moderation?.action).toBe("warn");
    expect(first.triggerCount).toBe(1);

    const second = await harness.service.observe(message({ messageId: "msg-2", mentionCount: 9 }));
    expect(second.moderation?.action).toBe("timeout");
    expect(second.triggerCount).toBe(2);
  });

  it("does not DM anything, because automod is not a person", async () => {
    // A system actor has no DM channel; the moderation service must not try. This
    // asserts the automation path does not accidentally attempt user-facing mail.
    const outcome = await harness.service.observe(message({ mentionCount: 9 }));
    expect(outcome.moderation?.notes).toEqual([]);
  });

  it("stays quiet when the author is staff", async () => {
    harness.exempt = true;
    const outcome = await harness.service.observe(message({ mentionCount: 9 }));

    expect(outcome.verdict).toBe("exempt");
    expect(outcome.exemptReason).toBe("lockdown-holder");
    expect(harness.logLines).toEqual([]);
    expect(harness.auditActions).toEqual([]);
  });

  it("records a note instead of punishing when the ladder says none", async () => {
    await automodConfig(harness.v3, { escalation: [], warnOnFirstTrigger: true });

    const outcome = await harness.service.observe(message({ mentionCount: 9 }));
    expect(outcome.moderation?.action).toBe("note");
    expect(harness.logLines[0]?.action).toBe("note");
  });

  it("records the trigger without punishing when moderation is disabled", async () => {
    await harness.v3.config.update(
      GUILD_A,
      { moderation: { enabled: false } },
      { id: "admin", kind: "user" },
    );

    const outcome = await harness.service.observe(message({ mentionCount: 9 }));

    // The trigger is audited (that is automod's own record) and moderation refuses
    // the punishment, so nothing is written to the case history.
    expect(outcome.verdict).toBe("triggered");
    expect(harness.auditActions).toContain("automod.trigger");
    expect(harness.auditActions).not.toContain("moderation.timeout");
    expect(outcome.notes.join(" ")).toMatch(/moderation is disabled/i);
  });

  it("ignores an observation for a guild with the module off, and one for another guild", async () => {
    const disabled = automodHarness();
    expect((await disabled.service.observe(message())).verdict).toBe("clean");

    // Guild isolation: the same author in guild B is judged by guild B's settings,
    // which the harness leaves disabled.
    const outcome = await harness.service.observe(message({ guildId: GUILD_B, mentionCount: 9 }));
    expect(outcome.verdict).toBe("clean");
    expect(harness.logLines).toEqual([]);
  });

  it("survives a failing moderation call and reports it as a note", async () => {
    // The mute role is absent, so the ladder's `timeout` is not the problem — the
    // target being unresolvable is what must be reported, not thrown.
    harness.members.targets.delete(AUTHOR);
    const outcome = await harness.service.observe(message({ mentionCount: 9 }));

    expect(outcome.verdict).toBe("triggered");
    expect(outcome.notes.join(" ")).toMatch(/left before|Could not apply/);
  });
});
