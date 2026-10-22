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
      authorization: services.authorization,
      // Maintenance is a dispatch-level gate, not a command-level check: it has to
      // run before authorization so a paused guild never sees a permission prompt.
      maintenance: services.maintenance,
      // `/roles` binds Discord roles to power levels through the same store the
      // authorization layer resolves, so the two can never disagree.
      permissionClasses: services.permissionClasses,
      diagnostics: services.diagnostics,
      config: services.guildConfig,
      database: services.database,
      setup: services.setup,
      setupResources: services.setupResources,
      // Wired once in the bootstrap; this event only forwards it.
      createSetupContext: services.createSetupContext,
      // Moderation follows the same rule: one construction path, forwarded here.
      createModerationContext: services.createModerationContext,
      // V5: automod, security and backups are built the same way, per invocation.
      createAutomodContext: services.createAutomodContext,
      // V6: tickets follow the same rule.
      createTicketContext: services.createTicketContext,
      createSecurityContext: services.createSecurityContext,
      createBackupService: services.createBackupService,
      deployment: services.deployment,
      audit: services.audit,
      client: services.client,
      ai: services.ai,
      aiSettings: services.aiSettings,
      aiMemory: services.aiMemory,
      // `/stop` and `/restart` go through the bootstrap's own teardown, never around it.
      process: services.process,
      // `/leave` uses the service so the reply is flushed before the bot leaves.
      guildLeave: services.guildLeave,
      startedAt: services.startedAt,
    };

    const handler = new InteractionHandler(dependencies);
    await handler.handle(interaction);
  },
});
