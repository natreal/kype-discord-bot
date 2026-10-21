/**
 * Setup declaration for the reminders module.
 *
 * Like the scheduler, reminders own no Discord resource that is worth creating
 * automatically: the channel is whatever the operator picks in `/settings`, and a bot
 * inventing a `#reminders` channel would post bumps somewhere nobody reads. The module
 * exists so `/help` and the setup report list the feature, and so the bump settings are
 * reported as "enabled / not configured" instead of looking unsupported.
 */
import type { BotModule, ModuleContext } from "../module.types.js";

/** Module name, as reported by `/help` and the setup report. */
export const REMINDERS_MODULE_NAME = "reminders";

/** No Discord resources are provisioned. */
export const REMINDERS_RESOURCES = {} as const;

export const reminderModule: BotModule = {
  name: REMINDERS_MODULE_NAME,
  description: "Personal timers (/reminder) and Disboard bump reminders.",

  enabled(): boolean {
    // Always available: `/reminder` is a personal utility any member may use, so it is
    // not gated by a guild switch. The bump reminder has its own toggle in
    // `automation.bumpReminderEnabled`, checked where a bump is detected.
    return true;
  },

  plan(context: ModuleContext): [] {
    // Nothing to create: the bump channel comes from `/settings`, and the reminder
    // destination is the channel the member runs `/reminder` in.
    void context;
    return [];
  },
};
