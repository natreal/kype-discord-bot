/**
 * Reminder service.
 *
 * Owns the two promises this feature makes:
 *
 *   `/reminder set in 30m stretch`  — the user is pinged, once, at the deadline;
 *   a Disboard bump               — the server is reminded to bump again ~2h later.
 *
 * Both are scheduled through the shared scheduler, so both survive a restart, are
 * visible in `/scheduler list` and are cancellable. The service itself holds no
 * state: it is a thin, testable layer between a command/event and the task table plus
 * a narrow Discord port.
 *
 * Choices worth stating, because they are decisions rather than consequences:
 *
 * - **A personal reminder pings the author, in the channel where it was set.** DMs
 *   are often closed, and a reminder that cannot be delivered is not a reminder. The
 *   destination channel is stored with the task, so moving channels later does not
 *   move an existing reminder.
 * - **The dedupe key is derived from the reminder's identity, not from its text.**
 *   Re-setting the same reminder replaces it instead of stacking a duplicate, which
 *   is what makes running the command twice harmless.
 * - **The bump reminder fires `delaySeconds` after the bump**, and is only scheduled
 *   when the guild enabled it and the bump was a real Disboard bump.
 */
import type { Logger } from "../../services/logger/index.js";
import type { SchedulerService, ScheduledTaskRecord } from "../scheduler/index.js";
import type { TaskHandlerContext, TaskHandlerResult } from "../scheduler/scheduler.types.js";
import { ValidationError } from "../../utils/errors.js";
import {
  BUMP_REMINDER_TASK_KIND,
  REMINDER_TASK_KIND,
  type BumpReminderPayload,
  type CreatedReminder,
  type PendingReminder,
  type ReminderPayload,
} from "./reminder.types.js";

/**
 * The Discord operations a reminder needs.
 *
 * Narrow on purpose: post a message, and check whether a member is still present so
 * the reminder can fall back to a role instead of pinging somebody who left. The
 * service never holds a guild object, which is what keeps it testable without a live
 * client.
 */
export interface ReminderActions {
  /** Posts a message. Throws when Discord refuses (missing access, deleted channel). */
  sendMessage(channelId: string, content: string): Promise<void>;
  /** @returns true when the member is still in the guild. */
  memberExists(guildId: string, userId: string): Promise<boolean>;
}

/** Input for a personal reminder, already resolved by the command. */
export interface PersonalReminderInput {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly text: string;
  readonly delaySeconds: number;
}

/** Input for a bump reminder, built from a detected bump message. */
export interface BumpReminderInput {
  readonly guildId: string;
  readonly bumperId: string;
  readonly channelId: string;
  readonly delaySeconds: number;
  readonly roleId: string | null;
}

/** Collaborators, all injected. */
export interface ReminderServiceDeps {
  readonly scheduler: SchedulerService;
  readonly actions: ReminderActions;
  readonly logger: Logger;
}

/**
 * The dedupe key for a personal reminder.
 *
 * Scoped to the user *and* the text, so a member can keep several distinct reminders
 * pending ("standup" and "water") while re-setting one replaces it. The delay is not
 * part of the key: "remind me to stretch" set twice means the latest one wins.
 */
export function personalReminderKey(userId: string, text: string): string {
  // A djb2 hash keeps the key short and stable. Two different texts of the same user
  // colliding would merely merge two reminders, and the stored payload (not the key)
  // is what gets delivered, so the failure mode is "one of two similar reminders is
  // replaced", never a wrong message.
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${REMINDER_TASK_KIND}:${userId}:${(hash >>> 0).toString(36)}`;
}

/** The dedupe key for a bump reminder: at most one pending reminder per guild. */
export function bumpReminderKey(guildId: string): string {
  return `${BUMP_REMINDER_TASK_KIND}:${guildId}`;
}

export class ReminderService {
  private readonly scheduler: SchedulerService;
  private readonly actions: ReminderActions;
  private readonly logger: Logger;

  public constructor(deps: ReminderServiceDeps) {
    this.scheduler = deps.scheduler;
    this.actions = deps.actions;
    this.logger = deps.logger.child("reminders");
  }

  /**
   * Schedules a personal reminder.
   *
   * The delay has already been parsed and range-checked by the command; it is
   * re-checked here so a caller cannot create a task that is already due and fires
   * before the member has finished reading the confirmation.
   */
  public async createPersonalReminder(input: PersonalReminderInput): Promise<CreatedReminder> {
    if (!Number.isFinite(input.delaySeconds) || input.delaySeconds <= 0) {
      throw new ValidationError("A reminder must be scheduled in the future.");
    }

    const payload: ReminderPayload = {
      userId: input.userId,
      channelId: input.channelId,
      text: input.text,
      createdAt: Date.now(),
    };
    const dedupeKey = personalReminderKey(input.userId, input.text);

    const task = await this.scheduler.schedule({
      guildId: input.guildId,
      kind: REMINDER_TASK_KIND,
      delaySeconds: Math.round(input.delaySeconds),
      payload,
      dedupeKey,
    });

    this.logger.info("Reminder scheduled", {
      guildId: input.guildId,
      userId: input.userId,
      dueAt: task.dueAt.toISOString(),
    });

    return { taskId: task.id, dueAt: task.dueAt, channelId: input.channelId, dedupeKey };
  }

  /**
   * Schedules the "bump again" reminder that follows a Disboard bump.
   *
   * Keyed per guild, so two bumps in a row replace the reminder rather than stacking
   * two pings a couple of minutes apart — the later bump is the one that matters, and
   * the earlier reminder would be wrong by then.
   */
  public async scheduleBumpReminder(input: BumpReminderInput): Promise<CreatedReminder> {
    const payload: BumpReminderPayload = {
      bumperId: input.bumperId,
      channelId: input.channelId,
      roleId: input.roleId,
      bumpedAt: Date.now(),
    };
    const dedupeKey = bumpReminderKey(input.guildId);

    const task = await this.scheduler.schedule({
      guildId: input.guildId,
      kind: BUMP_REMINDER_TASK_KIND,
      // At least a second: a zero delay would be refused by the scheduler and turn a
      // misconfiguration into a silent no-op instead of a reminder that fires at once.
      delaySeconds: Math.max(1, Math.round(input.delaySeconds)),
      payload,
      dedupeKey,
    });

    this.logger.info("Bump reminder scheduled", {
      guildId: input.guildId,
      bumperId: input.bumperId,
      dueAt: task.dueAt.toISOString(),
    });

    return { taskId: task.id, dueAt: task.dueAt, channelId: input.channelId, dedupeKey };
  }

  /**
   * Lists the reminders a member may cancel, or every reminder in the guild.
   *
   * Bump reminders appear only in a guild-wide listing: a member did not create one,
   * so it is not theirs to cancel. Both kinds are read from the same pending queue, so
   * the list can never show something the scheduler will not run.
   */
  public async list(
    guildId: string,
    options: { readonly userId?: string } = {},
  ): Promise<PendingReminder[]> {
    const tasks = await this.scheduler.listPending(guildId, 100);
    const reminders: PendingReminder[] = [];

    for (const task of tasks) {
      if (task.kind === REMINDER_TASK_KIND) {
        const payload = parseReminderPayload(task);
        if (!payload || (options.userId !== undefined && payload.userId !== options.userId)) {
          continue;
        }
        reminders.push({
          id: task.id,
          kind: "personal",
          dueAt: task.dueAt,
          channelId: payload.channelId,
          text: payload.text,
        });
        continue;
      }

      if (task.kind === BUMP_REMINDER_TASK_KIND && options.userId === undefined) {
        const payload = parseBumpPayload(task);
        if (!payload) {
          continue;
        }
        reminders.push({
          id: task.id,
          kind: "bump",
          dueAt: task.dueAt,
          channelId: payload.channelId,
          text: "",
        });
      }
    }

    return reminders.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  }

  /**
   * Cancels one reminder by task id.
   *
   * Ownership is checked against the stored payload, so guessing an id cannot cancel
   * somebody else's reminder; "not yours" and "does not exist" both answer `false`,
   * because the difference is not the caller's business.
   */
  public async cancel(guildId: string, taskId: string, userId: string): Promise<boolean> {
    const pending = await this.scheduler.listPending(guildId, 100);
    const task = pending.find((candidate) => candidate.id === taskId);
    if (!task || task.kind !== REMINDER_TASK_KIND) {
      return false;
    }
    const payload = parseReminderPayload(task);
    if (!payload || payload.userId !== userId) {
      return false;
    }
    return this.scheduler.cancel(task.id);
  }

  /** Cancels every personal reminder a member has pending. @returns how many. */
  public async cancelAll(guildId: string, userId: string): Promise<number> {
    const pending = await this.list(guildId, { userId });
    let cancelled = 0;
    for (const reminder of pending) {
      if (await this.scheduler.cancel(reminder.id)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /**
   * Runs a due reminder. Called by the task handler, never by a command.
   *
   * @returns `done` when the message was delivered, `skipped` when the reminder is no
   * longer deliverable (unreadable payload). A Discord failure throws, so the
   * scheduler retries it and records the reason in `lastError`.
   */
  public async fire(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    if (context.task.kind === REMINDER_TASK_KIND) {
      return this.firePersonal(context);
    }
    if (context.task.kind === BUMP_REMINDER_TASK_KIND) {
      return this.fireBump(context);
    }
    // The registry routes by kind, so reaching here means the routing is wrong. It is
    // skipped rather than thrown: retrying would not fix it.
    return { outcome: "skipped", detail: `not a reminder task: ${context.task.kind}` };
  }

  private async firePersonal(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const payload = parseReminderPayload(context.task);
    if (!payload) {
      // A malformed payload is a bug, not a transient condition: retrying it would
      // fail identically three times.
      context.logger.warn("Skipping a reminder with an unreadable payload", {
        taskId: context.task.id,
      });
      return { outcome: "skipped", detail: "invalid-payload" };
    }

    // The member may have left. Posting without a mention is the honest fallback: the
    // channel is still where the reminder was meant for, and pinging somebody who is
    // gone would only produce a broken mention.
    const present = await this.actions.memberExists(context.task.guildId, payload.userId);
    const lead = present ? `<@${payload.userId}>` : "_(the member who set this has left)_";
    const setAge = Math.floor(payload.createdAt / 1_000);

    await this.actions.sendMessage(
      payload.channelId,
      `${lead} ⏰ **Reminder:** ${payload.text}\n-# Set <t:${setAge}:R>.`,
    );
    return { outcome: "done" };
  }

  private async fireBump(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const payload = parseBumpPayload(context.task);
    if (!payload) {
      context.logger.warn("Skipping a bump reminder with an unreadable payload", {
        taskId: context.task.id,
      });
      return { outcome: "skipped", detail: "invalid-payload" };
    }

    // Priority: the member who bumped (they asked for it by bumping), then the role the
    // operator configured, then a plain announcement. A bump reminder nobody sees is a
    // reminder that did nothing.
    const bumperPresent = await this.actions.memberExists(context.task.guildId, payload.bumperId);
    const mention = bumperPresent
      ? `<@${payload.bumperId}>`
      : payload.roleId !== null
        ? `<@&${payload.roleId}>`
        : "**Bump reminder**";
    const bumpedAge = Math.floor(payload.bumpedAt / 1_000);

    await this.actions.sendMessage(
      payload.channelId,
      [
        `${mention} 🔔 The server can be bumped on Disboard again.`,
        "Use `/bump` to bring new members in.",
        `-# Last bump <t:${bumpedAge}:R> · bump reminders are configured with /settings.`,
      ].join("\n"),
    );
    return { outcome: "done" };
  }
}

/**
 * Reads a stored personal-reminder payload.
 *
 * @returns the payload, or `null` when the row does not have the expected shape (a
 * row written by an older build, or a corrupted one). Never throws: a bad row must
 * not fail a task three times.
 */
export function parseReminderPayload(task: ScheduledTaskRecord): ReminderPayload | null {
  const record = asRecord(task.payload);
  if (!record) {
    return null;
  }
  const { userId, channelId, text, createdAt } = record;
  if (typeof userId !== "string" || typeof channelId !== "string" || typeof text !== "string") {
    return null;
  }
  return {
    userId,
    channelId,
    text,
    createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
  };
}

/** Reads a stored bump-reminder payload; `null` when unreadable. */
export function parseBumpPayload(task: ScheduledTaskRecord): BumpReminderPayload | null {
  const record = asRecord(task.payload);
  if (!record) {
    return null;
  }
  const { bumperId, channelId, roleId, bumpedAt } = record;
  if (typeof bumperId !== "string" || typeof channelId !== "string") {
    return null;
  }
  return {
    bumperId,
    channelId,
    roleId: typeof roleId === "string" ? roleId : null,
    bumpedAt: typeof bumpedAt === "number" ? bumpedAt : Date.now(),
  };
}

/** @returns the payload as a plain record, or `null` when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
