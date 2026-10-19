/**
 * Role module.
 *
 * Owns the temporary-role lifecycle and the `role.expire` task kind the scheduler
 * dispatches. It declares no Discord resources of its own: a grant reuses the role
 * an operator already made, which is why `plan()` only verifies configuration
 * rather than creating anything.
 */
import type { BotModule, SetupAction } from "../module.types.js";

export const ROLE_MODULE_NAME = "roles";

/** Resources the role module owns. None: it assigns roles, it does not create them. */
export const ROLE_RESOURCES = {} as const;

export const roleModule: BotModule = {
  name: ROLE_MODULE_NAME,
  description: "Temporary roles and automatic role expiry.",

  enabled(): boolean {
    // Always enabled: the expiry task must run for a guild even if no other role
    // feature is configured, because a grant written while the module was on would
    // otherwise never be removed if the module were later switched off.
    return true;
  },

  plan(): SetupAction[] {
    // A verification action rather than a creation one: the role a grant targets is
    // chosen by an operator (`/role temp role:@X`), so there is no name this module
    // could own and create without guessing.
    return [];
  },
};
