/**
 * Reminder tests.
 *
 * The suite asserts the promises the feature makes to a member and to an operator:
 *
 *   1. **a reminder is delivered once, where it was set.** A reminder that silently
 *      changes channel, or fires twice, is worse than no reminder.
 *   2. **a reminder belongs to the member who set it.** Listing and cancelling are
 *      scoped, so an id cannot be used to reach somebody else's timer.
 *   3. **setting the same reminder twice replaces it**, which is what makes retrying
 *      the command harmless.
 *   4. **a bump reminder follows the bump, once per guild**, and falls back to the
 *      configured role when the member who bumped has left.
 */
import { describe, expect, it } from "vitest";

import { SchedulerService, TaskHandlerRegistry } from "../../src/modules/scheduler/index.js";
import {
  bumpReminderKey,
  clampDurationSeconds,
  createReminderTaskHandlers,
  DurationParseError,
  parseDurationSeconds,
  personalReminderKey,
  ReminderService,
} from "../../src/modules/reminders/index.js";
import {
  BUMP_REMINDER_TASK_KIND,
  REMINDER_TASK_KIND,
} from "../../src/modules/reminders/reminder.types.js";
import type { ReminderActions } from "../../src/modules/reminders/reminder.service.js";
import { testLogger } from "../helpers/logger.js";
import { memoryScheduler } from "../helpers/scheduler.js";

const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const USER = "333333333333333333";
const OTHER_USER = "444444444444444444";
const CHANNEL = "555555555555555555";
const ROLE = "666666666666666666";

/** A no-op Discord port; individual tests override what they need. */
function recordingActions(overrides: Partial<ReminderActions> = {}): ReminderActions & {
  readonly sent: { channelId: string; content: string }[];
} {
  const sent: { channelId: string; content: string }[] = [];
  return {
    sent,
    sendMessage: (channelId, content) => {
      sent.push({ channelId, content });
      return Promise.resolve();
    },
    memberExists: () => Promise.resolve(true),
    ...overrides,
  };
}

/**
 * Builds the service over the in-memory scheduler.
 *
 * The reminder handlers are registered with the real registry, so the round trip
 * through `TaskHandlerRegistry` is exercised rather than assumed.
 */
function buildService(actions: ReminderActions = recordingActions()) {
  const repository = memoryScheduler();
  const registry = new TaskHandlerRegistry();
  const scheduler = new SchedulerService({
    repository,
    registry,
    logger: testLogger,
    options: {},
  });
  const service = new ReminderService({ scheduler, actions, logger: testLogger });
  // The handler closes over the service, so the registry must be populated after it
  // exists; the scheduler only needs the registry by the time a task is executed.
  registry.registerAll(createReminderTaskHandlers(() => service));
  return { repository, registry, scheduler, actions, service };
}

/** Runs every due task once, the way a scheduler tick would. */
async function tick(scheduler: SchedulerService): Promise<void> {
  await scheduler.tick(new Date(Date.now() + 86_400_000));
}

describe("duration parsing", () => {
  it("parses compound and worded durations", () => {
    expect(parseDurationSeconds("90m")).toBe(5_400);
    expect(parseDurationSeconds("1h30m")).toBe(5_400);
    expect(parseDurationSeconds("2 hours 15 min")).toBe(8_100);
    expect(parseDurationSeconds("in 3 days")).toBe(3 * 86_400);
    expect(parseDurationSeconds("1 sem")).toBe(7 * 86_400);
  });

  it("rejects a bare number rather than guessing the unit", () => {
    // `30` is either 30 seconds or 30 minutes: picking one would be wrong by 60x.
    expect(() => parseDurationSeconds("30")).toThrow(DurationParseError);
  });

  it("returns null when the text contains no duration at all", () => {
    expect(parseDurationSeconds("tomorrow")).toBeNull();
  });

  it("clamps to the supported range", () => {
    expect(clampDurationSeconds(60)).toBe(60);
    expect(() => clampDurationSeconds(30)).toThrow(DurationParseError);
    expect(() => clampDurationSeconds(31 * 86_400)).toThrow(DurationParseError);
  });
});

describe("ReminderService", () => {
  it("schedules a personal reminder and stores everything needed to fire", async () => {
    const { service, repository } = buildService();

    const created = await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 1_800,
    });

    expect(created.channelId).toBe(CHANNEL);
    expect(created.dedupeKey).toBe(personalReminderKey(USER, "stretch"));
    const [row] = repository.rows;
    expect(row).toMatchObject({
      guildId: GUILD,
      kind: REMINDER_TASK_KIND,
      dedupeKey: created.dedupeKey,
    });
    expect(row?.payload).toMatchObject({ userId: USER, channelId: CHANNEL, text: "stretch" });
  });

  it("refuses a reminder that is not in the future", async () => {
    const { service } = buildService();
    await expect(
      service.createPersonalReminder({
        guildId: GUILD,
        userId: USER,
        channelId: CHANNEL,
        text: "now",
        delaySeconds: 0,
      }),
    ).rejects.toThrow();
  });

  it("replaces a reminder with the same text instead of stacking a duplicate", async () => {
    const { service, repository } = buildService();

    await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 600,
    });
    await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 1_200,
    });

    expect(repository.rows).toHaveLength(1);
    expect(await service.list(GUILD, { userId: USER })).toHaveLength(1);
  });

  it("keeps distinct reminders of the same member apart", async () => {
    const { service } = buildService();

    for (const text of ["stretch", "water"]) {
      await service.createPersonalReminder({
        guildId: GUILD,
        userId: USER,
        channelId: CHANNEL,
        text,
        delaySeconds: 600,
      });
    }

    const pending = await service.list(GUILD, { userId: USER });
    expect(pending.map((reminder) => reminder.text).sort()).toEqual(["stretch", "water"]);
  });

  it("never lists another member's reminder as mine", async () => {
    const { service } = buildService();
    await service.createPersonalReminder({
      guildId: GUILD,
      userId: OTHER_USER,
      channelId: CHANNEL,
      text: "theirs",
      delaySeconds: 600,
    });

    expect(await service.list(GUILD, { userId: USER })).toEqual([]);
  });

  it("refuses to cancel another member's reminder, or one from another guild", async () => {
    const { service } = buildService();
    const created = await service.createPersonalReminder({
      guildId: GUILD,
      userId: OTHER_USER,
      channelId: CHANNEL,
      text: "theirs",
      delaySeconds: 600,
    });

    expect(await service.cancel(GUILD, created.taskId, USER)).toBe(false);
    expect(await service.cancel(OTHER_GUILD, created.taskId, OTHER_USER)).toBe(false);
    // Still pending: a refused cancel must not remove the row.
    expect(await service.list(GUILD)).toHaveLength(1);
  });

  it("cancels only the caller's reminders", async () => {
    const { service } = buildService();
    for (const userId of [USER, OTHER_USER]) {
      await service.createPersonalReminder({
        guildId: GUILD,
        userId,
        channelId: CHANNEL,
        text: "water",
        delaySeconds: 600,
      });
    }

    expect(await service.cancelAll(GUILD, USER)).toBe(1);
    const remaining = await service.list(GUILD);
    expect(remaining).toHaveLength(1);
  });
});

describe("firing", () => {
  it("pings the member in the channel the reminder was set in", async () => {
    const actions = recordingActions();
    const { service, scheduler } = buildService(actions);
    await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 60,
    });

    await tick(scheduler);

    expect(actions.sent).toHaveLength(1);
    expect(actions.sent[0]?.channelId).toBe(CHANNEL);
    expect(actions.sent[0]?.content).toContain(`<@${USER}>`);
    expect(actions.sent[0]?.content).toContain("stretch");
  });

  it("does not ping the channel on behalf of a member who has left", async () => {
    const actions = recordingActions({ memberExists: () => Promise.resolve(false) });
    const { service, scheduler } = buildService(actions);
    await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 60,
    });

    await tick(scheduler);

    // The reminder is still posted — the channel is still the right place — but a
    // broken mention is not produced for somebody who is gone.
    expect(actions.sent).toHaveLength(1);
    expect(actions.sent[0]?.content).not.toContain(`<@${USER}>`);
  });

  it("skips a row whose payload is unreadable instead of retrying it forever", async () => {
    const actions = recordingActions();
    const { service, repository } = buildService(actions);
    await service.createPersonalReminder({
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      text: "stretch",
      delaySeconds: 60,
    });
    // A row written by another build: no userId at all.
    (repository.rows[0] as { payload: unknown }).payload = { text: "stretch" };

    const result = await service.fire({ task: repository.rows[0]!, logger: testLogger });

    expect(result.outcome).toBe("skipped");
    expect(actions.sent).toHaveLength(0);
  });

  it("reports an unknown task kind as skipped rather than throwing", async () => {
    const { service } = buildService();
    const result = await service.fire({
      task: {
        id: "task-x",
        guildId: GUILD,
        kind: "someone.else",
        dueAt: new Date(),
        payload: {},
        status: "pending",
        recurrence: null,
        dedupeKey: null,
        attempts: 0,
        lastError: null,
      },
      logger: testLogger,
    });

    expect(result.outcome).toBe("skipped");
  });
});

describe("bump reminder", () => {
  it("pings the member who bumped, in the configured channel", async () => {
    const actions = recordingActions();
    const { service, scheduler } = buildService(actions);

    await service.scheduleBumpReminder({
      guildId: GUILD,
      bumperId: USER,
      channelId: CHANNEL,
      delaySeconds: 7_200,
      roleId: null,
    });
    await tick(scheduler);

    expect(actions.sent).toHaveLength(1);
    expect(actions.sent[0]?.channelId).toBe(CHANNEL);
    expect(actions.sent[0]?.content).toContain(`<@${USER}>`);
  });

  it("falls back to the configured role when the bumper has left", async () => {
    const actions = recordingActions({ memberExists: () => Promise.resolve(false) });
    const { service, scheduler } = buildService(actions);

    await service.scheduleBumpReminder({
      guildId: GUILD,
      bumperId: USER,
      channelId: CHANNEL,
      delaySeconds: 7_200,
      roleId: ROLE,
    });
    await tick(scheduler);

    expect(actions.sent[0]?.content).toContain(`<@&${ROLE}>`);
    expect(actions.sent[0]?.content).not.toContain(`<@${USER}>`);
  });

  it("keeps one pending bump reminder per guild", async () => {
    const { service, repository } = buildService();

    await service.scheduleBumpReminder({
      guildId: GUILD,
      bumperId: USER,
      channelId: CHANNEL,
      delaySeconds: 600,
      roleId: null,
    });
    const second = await service.scheduleBumpReminder({
      guildId: GUILD,
      bumperId: OTHER_USER,
      channelId: CHANNEL,
      delaySeconds: 7_200,
      roleId: null,
    });

    expect(repository.rows).toHaveLength(1);
    expect(second.dedupeKey).toBe(bumpReminderKey(GUILD));
    // The later bump is the one that matters: the stored payload follows it.
    expect(repository.rows[0]?.payload).toMatchObject({ bumperId: OTHER_USER });
  });

  it("is not a member's to cancel, and is not listed as theirs", async () => {
    const { service } = buildService();
    const created = await service.scheduleBumpReminder({
      guildId: GUILD,
      bumperId: USER,
      channelId: CHANNEL,
      delaySeconds: 600,
      roleId: null,
    });

    expect(await service.list(GUILD, { userId: USER })).toEqual([]);
    expect(await service.cancel(GUILD, created.taskId, USER)).toBe(false);
    // The guild-wide listing still shows it, so an operator can see what is pending.
    expect((await service.list(GUILD)).map((reminder) => reminder.kind)).toEqual(["bump"]);
  });

  it("skips a bump task when the guild is no longer available", async () => {
    // The handler resolves the guild-bound service; `null` means the bot was removed.
    const handlers = createReminderTaskHandlers(() => null);
    const handler = handlers.find((candidate) => candidate.kind === BUMP_REMINDER_TASK_KIND);

    const result = await handler!.run({
      task: {
        id: "task-y",
        guildId: GUILD,
        kind: BUMP_REMINDER_TASK_KIND,
        dueAt: new Date(),
        payload: { bumperId: USER, channelId: CHANNEL, roleId: null, bumpedAt: Date.now() },
        status: "pending",
        recurrence: null,
        dedupeKey: null,
        attempts: 0,
        lastError: null,
      },
      logger: testLogger,
    });

    expect(result).toMatchObject({ outcome: "skipped", detail: "guild unavailable" });
  });
});
