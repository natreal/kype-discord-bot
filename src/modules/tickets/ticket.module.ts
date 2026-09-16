/**
 * Ticket module (foundation only).
 *
 * The full ticket workflow lands later. Today the module declares the category
 * and staff role the workflow will use, so setup is already idempotent.
 */
import { PermissionFlagsBits } from "discord.js";

import type { BotModule, SetupAction } from "../module.types.js";

export const TICKET_RESOURCES = {
  category: "Tickets",
  staffRole: "Support Team",
} as const;

export const ticketModule: BotModule = {
  name: "tickets",
  description: "Private support threads with staff assignment and transcripts.",

  enabled(context): boolean {
    return context.config.tickets.enabled;
  },

  plan(planContext): SetupAction[] {
    const { tickets } = planContext.config;

    return [
      {
        key: "category",
        description: `Create the "${TICKET_RESOURCES.category}" category for ticket channels.`,
        run: async (context) => {
          if (!tickets.enabled) {
            return { status: "skipped", detail: "tickets disabled" };
          }
          const { resource, created } = await context.setuper.ensureCategory({
            name: TICKET_RESOURCES.category,
            reason: "Foundation setup",
          });
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
      {
        key: "staff-role",
        description: `Create the "${TICKET_RESOURCES.staffRole}" role with access to tickets.`,
        run: async (context) => {
          if (!tickets.enabled) {
            return { status: "skipped", detail: "tickets disabled" };
          }
          const { resource, created } = await context.setuper.ensureRole({
            name: TICKET_RESOURCES.staffRole,
            mentionable: true,
            permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
            reason: "Foundation setup",
          });
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
    ];
  },
};
