/**
 * The single place where feature modules are registered.
 *
 * Adding a module = implement `BotModule`, append it here. No other file needs
 * to change, which keeps the setup system and module inventory in sync.
 */
import { aiModule } from "./ai/ai.module.js";
import { coreModule } from "./core/core.module.js";
import { loggingModule } from "./logging/logging.module.js";
import { moderationModule } from "./moderation/moderation.module.js";
import { membersModule } from "./members/members.module.js";
import { reminderModule } from "./reminders/reminders.module.js";
import { roleModule } from "./roles/role.module.js";
import { schedulerModule } from "./scheduler/scheduler.module.js";
import { securityModule } from "./security/security.module.js";
import { ticketModule } from "./tickets/ticket.module.js";
import type { BotModule } from "./module.types.js";

/** Order matters: earlier modules can create resources later ones reuse. */
export const botModules: readonly BotModule[] = [
  coreModule,
  loggingModule,
  moderationModule,
  membersModule,
  securityModule,
  ticketModule,
  aiModule,
  // Owns the `role.expire` task kind the scheduler dispatches, so it is registered
  // before the scheduler in the list to keep the dependency direction readable.
  roleModule,
  // Owns the `reminder.*` task kinds. Listed before the scheduler for the same reason
  // as the role module: the kinds it dispatches belong to features, not to the engine.
  reminderModule,
  // Last on purpose: it owns no resources, so it has nothing to contribute to
  // ordering, and listing it at the end keeps the resource-creating modules in
  // the sequence a reader expects.
  schedulerModule,
];

/** @returns the module registered under `name`, if any. */
export function findModule(name: string): BotModule | undefined {
  return botModules.find((module) => module.name === name);
}
