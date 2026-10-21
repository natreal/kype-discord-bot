/**
 * Reminders module (V8): `/reminder` and the Disboard bump reminder.
 *
 * Public surface. `app.ts` registers the task handler and builds the guild-bound
 * service; the `/reminder` command and `messageCreate` use the same service, so a
 * personal reminder and a bump reminder cannot behave differently in how they are
 * stored, listed or cancelled.
 */
export { reminderModule, REMINDERS_MODULE_NAME, REMINDERS_RESOURCES } from "./reminders.module.js";
export { DiscordReminderActions } from "./discord-reminder-actions.js";
export {
  ReminderService,
  bumpReminderKey,
  parseBumpPayload,
  parseReminderPayload,
  personalReminderKey,
  type BumpReminderInput,
  type PersonalReminderInput,
  type ReminderActions,
  type ReminderServiceDeps,
} from "./reminder.service.js";
export {
  BUMP_REMINDER_TASK_KIND,
  REMINDER_TASK_KIND,
  type BumpReminderPayload,
  type CreatedReminder,
  type PendingReminder,
  type ReminderPayload,
} from "./reminder.types.js";
export { createReminderTaskHandlers } from "./reminder.tasks.js";
export type { ReminderServiceResolver } from "./reminder.tasks.js";
export {
  clampDurationSeconds,
  DurationParseError,
  parseDurationSeconds,
  REMINDER_DURATION_LIMITS,
} from "./reminder.time.js";
