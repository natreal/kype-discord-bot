/**
 * Discord.js module augmentation.
 *
 * `client.commands` is declared here so that every consumer (commands, events,
 * the deployment script, tests) gets the project's typed `CommandRegistry`
 * instead of discord.js's untyped `Collection`.
 *
 * The declaration lives in `src/types` rather than next to the client factory so
 * that it is loaded for the whole program, including files that never import the
 * client module.
 */
import type { CommandRegistry } from "../commands/command.registry.js";

declare module "discord.js" {
  interface Client {
    /** Registry of commands discovered at startup. */
    commands: CommandRegistry;
  }
}

export {};
