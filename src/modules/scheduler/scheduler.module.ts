/**
 * Scheduler module (V6).
 *
 * Unlike the other modules, the scheduler provisions no Discord resources: it has
 * no channel, no role and nothing an administrator would want a setup action for.
 * Its `BotModule` exists for one reason — to be *listed* by `/help`, `plan()` and
 * the setup report alongside everything else, so deferred work is visible in the
 * same place as the features it serves. A module that is missing from that list
 * reads as "the bot cannot do this", which would be false.
 *
 * `enabled` is deliberately always `true`. The scheduler is not a feature an
 * operator turns on: temporary roles, welcome reminders and the automation engine
 * all schedule through it, so it has to be running for the features that *are*
 * enabled to keep their promises. Disabling it would not disable those features;
 * it would only make them silently stop finishing.
 */
import type { BotModule } from "../module.types.js";

/** Setup key reported when no action is needed. Only used for reporting. */
export const SCHEDULER_MODULE_NAME = "scheduler";

/**
 * No Discord resources.
 *
 * Declared as an empty object rather than omitted so the shape matches the other
 * modules (`MODULE_RESOURCES` naming) and a reader looking for "what does the
 * scheduler create?" gets an explicit answer instead of a missing export.
 */
export const SCHEDULER_RESOURCES = {} as const;

export const schedulerModule: BotModule = {
  name: SCHEDULER_MODULE_NAME,
  description: "Durable deferred work: temporary roles, expiring channels, reminders.",

  enabled(): boolean {
    // Always on, for the reason in the header: the features that schedule work are
    // the ones with a switch, and they assume the engine is alive.
    return true;
  },

  plan(): [] {
    // No setup actions: the scheduler owns no Discord resources. Returning an empty
    // list (rather than omitting `plan`) is what makes it appear in the setup
    // report as "enabled, nothing to create" instead of looking unsupported.
    return [];
  },
};
