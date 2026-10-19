/**
 * Logging module.
 *
 * Owns the `#bot-logs` channel and the per-category log toggles. Delivery to the
 * channel is performed by a logger sink in a later phase; this module already
 * declares the resources and defaults so setup is idempotent from day one.
 */
import type { BotModule, SetupAction } from "../module.types.js";

export const LOGGING_RESOURCES = {
  // The canonical log channel name the sinks resolve against (`GuildLogSink` and
  // `ModerationLogSink` both fall back to `server-logs`). Kept in one place so the
  // module that creates the channel and the sinks that read it can never drift
  // apart — the earlier `bot-logs` name meant the module created a channel nothing
  // ever posted to.
  channel: "server-logs",
} as const;

export const loggingModule: BotModule = {
  name: "logging",
  description: "Dedicated log channel with per-category event toggles.",

  enabled(context): boolean {
    return context.config.logging.enabled;
  },

  plan(context): SetupAction[] {
    return [
      {
        key: "channel",
        description: `Create the log channel (#${LOGGING_RESOURCES.channel}) or reuse it.`,
        run: async (moduleContext) => {
          if (!this.enabled(moduleContext)) {
            return { status: "skipped", detail: "logging disabled" };
          }

          const configured = context.config.logging.channelId;
          if (configured) {
            const existing = await moduleContext.setuper.findChannelById(configured);
            if (existing) {
              return { status: "reused", resourceId: existing.id, detail: "configured channel" };
            }
          }

          const category = await moduleContext.setuper.findCategoryByName("Bot");
          const { resource, created } = await moduleContext.setuper.ensureTextChannel({
            name: LOGGING_RESOURCES.channel,
            parentId: category?.id ?? null,
            topic: "Structured bot logs (moderation, security, member events).",
            reason: "Foundation setup",
          });

          return {
            status: created ? "created" : "reused",
            resourceId: resource.id,
            detail: `#${resource.name}`,
          };
        },
      },
    ];
  },
};
