/**
 * Core module.
 *
 * Baseline guild resources that every other module can rely on. It is always
 * enabled and is the reason setup never produces duplicate categories.
 */
import type { BotModule, SetupAction } from "../module.types.js";

/** Well-known resource keys resolved by the core module. */
export const CORE_RESOURCES = {
  category: "Bot",
} as const;

export const coreModule: BotModule = {
  name: "core",
  description: "Baseline categories and permissions used by every other module.",

  enabled(): boolean {
    return true;
  },

  plan(): SetupAction[] {
    return [
      {
        key: "category",
        description: "Create the shared bot category (reused when it already exists).",
        run: async (context) => {
          const { resource, created } = await context.setuper.ensureCategory({
            name: CORE_RESOURCES.category,
            reason: "Foundation setup",
          });
          return {
            status: created ? "created" : "reused",
            resourceId: resource.id,
            detail: CORE_RESOURCES.category,
          };
        },
      },
    ];
  },
};
