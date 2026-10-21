/**
 * Task handlers for the reminder kinds.
 *
 * One factory for both kinds, because they differ only in how the guild-bound service
 * is found. The handler is registered once at boot with a *resolver*, so a task from
 * any guild is dispatched to that guild's adapter — a handler bound to one guild at
 * startup would be wrong for every other server.
 *
 * Returning `skipped` when the guild is unavailable is deliberate: the bot was removed
 * from the server, so there is nobody left to remind and retrying would fail three
 * times for a good reason.
 */
import type { TaskHandler } from "../scheduler/scheduler.types.js";
import { BUMP_REMINDER_TASK_KIND, REMINDER_TASK_KIND } from "./reminder.types.js";
import type { ReminderService } from "./reminder.service.js";

/** @returns the guild-bound reminder service, or `null` when the guild is gone. */
export type ReminderServiceResolver = (guildId: string) => ReminderService | null;

/**
 * Builds the handlers the reminders module contributes to the scheduler.
 *
 * @param resolve Guild-bound service lookup, per task.
 */
export function createReminderTaskHandlers(
  resolve: ReminderServiceResolver,
): readonly TaskHandler[] {
  return [
    {
      kind: REMINDER_TASK_KIND,
      description: "Pings a member who asked to be reminded.",
      run: async (context) => {
        const service = resolve(context.task.guildId);
        if (!service) {
          return { outcome: "skipped", detail: "guild unavailable" };
        }
        return service.fire(context);
      },
    },
    {
      kind: BUMP_REMINDER_TASK_KIND,
      description: "Pings the server when it can be bumped on Disboard again.",
      run: async (context) => {
        const service = resolve(context.task.guildId);
        if (!service) {
          return { outcome: "skipped", detail: "guild unavailable" };
        }
        return service.fire(context);
      },
    },
  ];
}
