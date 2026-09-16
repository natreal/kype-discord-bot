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
import { securityModule } from "./security/security.module.js";
import { ticketModule } from "./tickets/ticket.module.js";
import type { BotModule } from "./module.types.js";

/** Order matters: earlier modules can create resources later ones reuse. */
export const botModules: readonly BotModule[] = [
  coreModule,
  loggingModule,
  moderationModule,
  securityModule,
  ticketModule,
  aiModule,
];

/** @returns the module registered under `name`, if any. */
export function findModule(name: string): BotModule | undefined {
  return botModules.find((module) => module.name === name);
}
