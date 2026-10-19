/**
 * Member onboarding module.
 *
 * Owns no Discord resources of its own: the welcome channel and the auto-roles
 * are chosen by an operator through `/settings`, so `plan()` returns nothing to
 * create. The module exists so the module inventory (`/help`, setup output) names
 * the join behaviour, and so a future setup action has a home.
 */
import type { BotModule } from "../module.types.js";

export const MEMBERS_MODULE_NAME = "members";

/** Resources the members module owns. None: it assigns roles, it does not create them. */
export const MEMBERS_RESOURCES = {} as const;

export const membersModule: BotModule = {
  name: MEMBERS_MODULE_NAME,
  description: "Welcome messages and automatic roles for new members.",

  enabled(context): boolean {
    // Reported as enabled whenever the module is present, because onboarding is a
    // per-join decision the service makes from live configuration: a guild with
    // nothing configured simply has nothing to apply.
    return context.config.members.welcomeEnabled || context.config.members.autoRoleIds.length > 0;
  },

  plan(): [] {
    // A verification-free module: the resources it uses are operator-chosen, so
    // there is no name this module could own and create without guessing.
    return [];
  },
};
