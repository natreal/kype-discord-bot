/**
 * `interactionCreate` — single entry point for every interaction type.
 *
 * The handler detects the interaction type, locates the appropriate handler,
 * executes it and guarantees a safe response:
 * - rate limits and Discord API failures are reported as "busy, try again";
 * - user errors (validation, permission) surface the *expected* message only;
 * - unexpected errors are logged with full diagnostics and answered generically.
 *
 * Stack traces, SQL errors, tokens and any other internal detail never reach
 * Discord users.
 */
import { defineEvent } from "./event.types.js";
import {
  InteractionHandler,
  type InteractionHandlerDeps,
} from "../interactions/interaction.handler.js";

export default defineEvent({
  name: "interactionCreate",
  execute: async (interaction, { services }) => {
    const dependencies: InteractionHandlerDeps = {
      logger: services.logger,
      appConfig: services.config,
      commands: services.commands,
      permissions: services.permissions,
      config: services.guildConfig,
      database: services.database,
      setup: services.setup,
      client: services.client,
      startedAt: services.startedAt,
    };

    const handler = new InteractionHandler(dependencies);
    await handler.handle(interaction);
  },
});
