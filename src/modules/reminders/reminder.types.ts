/**
 * Reminder contracts.
 *
 * A reminder is a row in `scheduled_tasks` with kind `reminder.fire`. Nothing about
 * a reminder is kept in memory, so a restart resumes every pending reminder instead
 * of losing it, and `/scheduler list` already shows them.
 *
 * The payload is deliberately self-describing rather than a reference to a list
 * record: the task owns everything needed to fire, so cancelling is a single
 * `cancelByKey` and there is no second table that could disagree with the schedule.
 */

/** The task kind the reminder module owns. */
export const REMINDER_TASK_KIND = "reminder.fire";

/** The task kind the bump mechanic owns. */
export const BUMP_REMINDER_TASK_KIND = "reminder.bump";

/**
 * What a scheduled reminder carries.
 *
 * Validated on the way out (the command builds it) and on the way in (the handler
 * parses it), because `payload` is stored as arbitrary JSON and a row written by an
 * older build must not be trusted at face value.
 */
export interface ReminderPayload {
  /** Discord user ID that asked to be reminded. */
  readonly userId: string;
  /** Channel to post the reminder in. */
  readonly channelId: string;
  /** What to say. */
  readonly text: string;
  /** When the reminder was created, for "set <t:…:R>" in the ping. */
  readonly createdAt: number;
}

/**
 * What a bump reminder carries.
 *
 * `bumperId` is the member who ran `/bump`. It is the person the reminder pings,
 * unless they are unavailable, in which case `roleId` (when configured) is used —
 * a bump reminder nobody sees is a reminder that did nothing.
 */
export interface BumpReminderPayload {
  readonly bumperId: string;
  /** Role to fall back to when the bumper is gone, or `null`. */
  readonly roleId: string | null;
  /** Channel the bump command was used in. */
  readonly channelId: string;
  /** When the bump happened, for the "last bumped" line. */
  readonly bumpedAt: number;
}

/**
 * A pending reminder, shaped for `/reminder list`.
 *
 * `text` is empty for a bump reminder (the wording is fixed), and `kind` lets the
 * list distinguish the two without exposing the payload.
 */
export interface PendingReminder {
  readonly id: string;
  readonly kind: "personal" | "bump";
  readonly dueAt: Date;
  readonly channelId: string;
  readonly text: string;
}

/** Outcome of creating a reminder, as the command reports it. */
export interface CreatedReminder {
  readonly taskId: string;
  readonly dueAt: Date;
  readonly channelId: string;
  readonly dedupeKey: string;
}
