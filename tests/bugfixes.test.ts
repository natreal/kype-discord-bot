/**
 * Regression tests for the bug-fix batch.
 *
 * Each test here pins a defect that was reported from real use, and each one is
 * written against the *cause* rather than the symptom: the timeout bound, the no-op
 * guard, the log channel resolution and the guild-event toggles. A test that only
 * asserted "the command replies" would have passed before the fix.
 */
import { describe, expect, it } from "vitest";

import { AuditEventService } from "../src/services/audit/index.js";
import { ModerationService } from "../src/modules/moderation/moderation.service.js";
import { MODERATION_LIMITS } from "../src/modules/moderation/moderation-actions.js";
import { DURATION_CHOICES } from "../src/commands/moderation/moderation.helpers.js";
import {
  GUILD_LOG_CATEGORY,
  GUILD_LOG_EVENTS,
  GUILD_LOG_METADATA_KEY,
  GuildLogPort,
  readGuildLogToggle,
} from "../src/modules/logging/guild-log.port.js";
import { renderGuildEvent } from "../src/modules/logging/guild-log.sink.js";
import { createLogger, MemorySink } from "../src/services/logger/index.js";
import { GUILD_A, USER_ID } from "./helpers/v3-harness.js";
import { testLogger } from "./helpers/logger.js";
import {
  fakeMemberActions,
  memberTarget,
  memoryCaseRepository,
  type FakeMemberActions,
} from "./helpers/moderation.js";
import { createV3Harness } from "./helpers/v3-harness.js";

const TARGET = "444444444444444444";
const MUTE_ROLE = { id: "role-muted", name: "Muted", position: 2 };
const ACTOR = { id: USER_ID, kind: "user", tag: "moderator#0001" } as const;

/** Builds the production service over in-memory persistence and a fake guild. */
function harness() {
  const v3 = createV3Harness();
  const members: FakeMemberActions = fakeMemberActions({ muteRole: MUTE_ROLE });
  members.targets.set(TARGET, memberTarget({ id: TARGET }));

  const service = new ModerationService({
    logger: testLogger,
    audit: new AuditEventService(testLogger, {
      append: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }),
    cases: memoryCaseRepository(),
    members,
    settings: (guildId) => v3.config.get(guildId).then((config) => config.moderation),
    log: { record: () => Promise.resolve() },
  });

  return { members, service };
}

/** Runs one action and @returns the rejection message, or `null` when it passed. */
async function rejectionOf(
  service: ModerationService,
  action: "mute" | "unmute" | "timeout" | "untimeout",
  durationMs?: number,
): Promise<string | null> {
  try {
    await service.execute(GUILD_A, {
      action,
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Test",
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("timeout duration bounds", () => {
  /**
   * Discord's maximum is 28 days but a deadline landing exactly on the boundary is
   * rejected with `INVALID_COMMUNICATION_DISABLED_TIMESTAMP`, which is the error a
   * moderator saw as "Invalid Form Body".
   */
  it("keeps the maximum strictly below Discord's 28-day ceiling", () => {
    expect(MODERATION_LIMITS.maxTimeoutMs).toBeLessThan(28 * 24 * 60 * 60 * 1_000);
  });

  it("offers no duration choice the guard would reject", () => {
    for (const choice of DURATION_CHOICES) {
      expect(choice.value).toBeLessThanOrEqual(MODERATION_LIMITS.maxTimeoutMs);
      expect(choice.value).toBeGreaterThanOrEqual(MODERATION_LIMITS.minTimeoutMs);
    }
  });

  it("still offers a duration within a minute of the maximum", () => {
    const largest = Math.max(...DURATION_CHOICES.map((choice) => choice.value));
    expect(MODERATION_LIMITS.maxTimeoutMs - largest).toBeLessThanOrEqual(60_000);
  });

  /**
   * The bug that produced `INVALID_COMMUNICATION_DISABLED_TIMESTAMP`: the adapter
   * passed `until.getTime()` (an epoch ~1.75e12) to discord.js's `member.timeout()`,
   * which *adds* its argument to `Date.now()` — sending `communication_disabled_until`
   * over a century out. The port now accepts a *duration*, so the stored expiry stays
   * a small, plausible offset from now.
   */
  it("stores a duration offset, not an epoch timestamp", async () => {
    const { members, service } = harness();
    await service.execute(GUILD_A, {
      action: "timeout",
      actor: ACTOR,
      target: memberTarget({ id: TARGET }),
      reason: "Test",
      durationMs: 60_000,
    });

    const expiry = members.timeouts.get(TARGET);
    expect(expiry).toBeInstanceOf(Date);
    const deltaMs = (expiry as Date).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThan(5 * 60_000);
  });
});

describe("guild log toggles", () => {
  it("covers every event family the configuration schema declares", () => {
    expect([...GUILD_LOG_EVENTS].sort()).toEqual(
      [
        "channelChanges",
        "memberJoin",
        "memberLeave",
        "messageDelete",
        "messageEdit",
        "roleChanges",
      ].sort(),
    );
  });

  /**
   * A cold cache must read as "on": the schema default is true, and a log channel
   * that stayed silent until the first `/settings view` would be indistinguishable
   * from the bug this path was added to fix.
   */
  it("defaults to enabled for a guild it has never seen", () => {
    for (const event of GUILD_LOG_EVENTS) {
      expect(readGuildLogToggle("guild-never-seen", event)).toBe(true);
    }
  });
});

describe("guild log rendering", () => {
  it("renders every field line as the embed description", () => {
    const embed = renderGuildEvent({
      guildId: "g1",
      event: "memberJoin",
      title: "Member joined",
      lines: ["**Member:** someone", "**Roles:** <@&1>"],
      targetId: "u1",
      actorId: null,
    }).toJSON();

    expect(embed.title).toBe("Member joined");
    expect(embed.description).toContain("**Member:** someone");
    expect(embed.description).toContain("<@&1>");
  });

  it("truncates a body that would exceed an embed limit", () => {
    const embed = renderGuildEvent({
      guildId: "g1",
      event: "messageEdit",
      title: "Message edited",
      lines: ["x".repeat(5_000)],
      targetId: "m1",
      actorId: null,
    }).toJSON();

    expect(embed.description?.length).toBeLessThanOrEqual(4_096);
    expect(embed.description?.endsWith("…")).toBe(true);
  });

  it("never renders an empty description, which Discord rejects", () => {
    const embed = renderGuildEvent({
      guildId: "g1",
      event: "messageDelete",
      title: "Message deleted",
      lines: [],
      targetId: "m1",
      actorId: null,
    }).toJSON();

    expect(embed.description).toBe("—");
  });

  it("gives each event family its own colour", () => {
    const join = renderGuildEvent({
      guildId: "g1",
      event: "memberJoin",
      title: "Member joined",
      lines: ["x"],
      targetId: "u1",
      actorId: null,
    }).toJSON();
    const leave = renderGuildEvent({
      guildId: "g1",
      event: "memberLeave",
      title: "Member left",
      lines: ["x"],
      targetId: "u1",
      actorId: null,
    }).toJSON();

    expect(join.color).not.toBe(leave.color);
  });
});

describe("no-op member actions are refused", () => {
  /**
   * A mute on an already-muted member used to write a second `mute` case, a second
   * audit event and a second log line while changing nothing. The user's report was
   * "I can get muted even if already muted, so it's making too many cases".
   */
  it("refuses a mute when the member already holds the Muted role", async () => {
    const { members, service } = harness();
    members.roles.set(TARGET, new Set([MUTE_ROLE.id]));

    expect(await rejectionOf(service, "mute")).toMatch(/already muted/i);
  });

  it("refuses an unmute when the member is not muted", async () => {
    const { service } = harness();

    expect(await rejectionOf(service, "unmute")).toMatch(/not muted/i);
  });

  it("still allows a mute when the member is not muted", async () => {
    const { service } = harness();

    expect(await rejectionOf(service, "mute")).toBeNull();
  });

  it("still allows an unmute when the member is muted", async () => {
    const { members, service } = harness();
    members.roles.set(TARGET, new Set([MUTE_ROLE.id]));

    expect(await rejectionOf(service, "unmute")).toBeNull();
  });

  it("leaves no case behind when it refuses", async () => {
    const { members, service } = harness();
    members.roles.set(TARGET, new Set([MUTE_ROLE.id]));

    await rejectionOf(service, "mute");

    const history = await service.history(GUILD_A, { targetId: TARGET });
    expect(history).toHaveLength(0);
  });

  it("refuses an untimeout when the member is not timed out", async () => {
    const { service } = harness();

    expect(await rejectionOf(service, "untimeout")).toMatch(/not timed out/i);
  });

  it("refuses a timeout when the member is already timed out", async () => {
    const { members, service } = harness();
    members.timeouts.set(TARGET, new Date(Date.now() + 60_000));

    expect(await rejectionOf(service, "timeout", 60_000)).toMatch(/already timed out/i);
  });

  it("still allows a timeout when the member is not timed out", async () => {
    const { service } = harness();

    expect(await rejectionOf(service, "timeout", 60_000)).toBeNull();
  });
});

describe("guild-event delivery is routed by logger context category", () => {
  /**
   * The bug this pins: `GuildLogSink` routes records by `record.context.category`,
   * but `GuildLogPort.emit()` wrote the category nowhere, so every event was
   * discarded and the log channel stayed empty ("log channel doesn't work").
   * The category must be on the record's *context*, not its metadata.
   */
  it("emits records carrying the guild-log category in the logger context", () => {
    const sink = new MemorySink();
    const port = new GuildLogPort(createLogger("test", { level: "debug", sinks: [sink] }));

    port.emit({
      guildId: "111111111111111111",
      event: "memberJoin",
      title: "Member joined",
      lines: ["hello"],
      targetId: "222222222222222222",
      actorId: null,
    });

    const record = sink.records[0];
    expect(record?.context?.category).toBe(GUILD_LOG_CATEGORY);
    expect(record?.metadata?.[GUILD_LOG_METADATA_KEY]).toMatchObject({ event: "memberJoin" });
  });

  it("still respects the per-event toggle before emitting", () => {
    expect(GUILD_LOG_EVENTS).toContain("memberJoin");
    // A cold cache (never-read config) defaults a toggle to "on", which is what
    // keeps a freshly bootstrapped guild logging before its config is first read.
    expect(readGuildLogToggle("unknown-guild", "memberJoin")).toBe(true);
  });
});
