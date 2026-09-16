/**
 * Moderation module (foundation only).
 *
 * Declares the roles/channels the moderation feature will need so that the
 * setup system is already idempotent, and records the defaults chosen by the
 * operator. Punishment logic lands in a later phase.
 */
import type { BotModule, SetupAction } from "../module.types.js";

export const MODERATION_RESOURCES = {
  role: "Muted",
  channel: "bot-moderation",
} as const;

export const moderationModule: BotModule = {
  name: "moderation",
  description: "Warning, timeout, kick and ban tooling with an audit trail.",

  enabled(context): boolean {
    return context.config.moderation.enabled;
  },

  plan(planContext): SetupAction[] {
    const { moderation, logging } = planContext.config;

    return [
      {
        key: "role",
        description: `Create the "${MODERATION_RESOURCES.role}" role used for soft punishments.`,
        run: async (context) => {
          if (!moderation.enabled) {
            return { status: "skipped", detail: "moderation disabled" };
          }
          const { resource, created } = await context.setuper.ensureRole({
            name: MODERATION_RESOURCES.role,
            mentionable: false,
            reason: "Foundation setup",
          });
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
      {
        key: "channel",
        description: `Create the "#${MODERATION_RESOURCES.channel}" audit channel.`,
        run: async (context) => {
          if (!moderation.enabled) {
            return { status: "skipped", detail: "moderation disabled" };
          }
          const category = await context.setuper.findCategoryByName("Bot");
          const { resource, created } = await context.setuper.ensureTextChannel({
            name: MODERATION_RESOURCES.channel,
            parentId: category?.id ?? null,
            topic: "Moderation actions and case history.",
            reason: "Foundation setup",
          });
          return {
            status: created ? "created" : "reused",
            resourceId: resource.id,
            ...(logging.enabled ? {} : { detail: "logging disabled" }),
          };
        },
      },
    ];
  },
};
