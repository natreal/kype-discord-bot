/**
 * Ticket module (V6).
 *
 * Declares the Discord resources the ticket workflow needs and seeds the default
 * categories, so `/setup` leaves a server with a working panel rather than a panel with
 * nothing to click.
 *
 * The categories are seeded from `TICKET_DEFAULT_CATEGORIES` rather than hardcoded in
 * the setup action, because the same list is what a fresh guild should get and what a
 * test should assert against. Seeding is idempotent (`upsertCategory` is keyed on
 * `(guildId, key)`), so re-running setup updates the labels and never duplicates a
 * button.
 */
import { PermissionFlagsBits } from "discord.js";

import type { BotModule, SetupAction } from "../module.types.js";

export const TICKET_RESOURCES = {
  category: "Tickets",
  staffRole: "Support Team",
} as const;

/**
 * Categories every server starts with.
 *
 * Deliberately three and deliberately generic: a server that wants different ones edits
 * them, and a server that wants none disables the module. Seeding nothing would leave
 * the panel empty on first run, which reads as "broken" rather than "unconfigured".
 */
export const TICKET_DEFAULT_CATEGORIES: readonly {
  key: string;
  label: string;
  emoji: string;
  description: string;
}[] = [
  {
    key: "support",
    label: "General Support",
    emoji: "❓",
    description: "Questions about the server or how to use it.",
  },
  {
    key: "report",
    label: "Report a Member",
    emoji: "🚨",
    description: "Report a member's behaviour to the staff team privately.",
  },
  {
    key: "appeal",
    label: "Appeal",
    emoji: "⚖️",
    description: "Appeal a punishment you received.",
  },
];

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
      {
        key: "categories",
        description: "Seed the default ticket categories so the panel has buttons.",
        run: async (context) => {
          if (!tickets.enabled) {
            return { status: "skipped", detail: "tickets disabled" };
          }
          if (!context.tickets) {
            // Setup run from a process without the ticket service (a harness, or a
            // guild that has not been wired). Reported rather than thrown so the rest
            // of setup still completes.
            return { status: "skipped", detail: "ticket service unavailable" };
          }

          const parent = await context.setuper.findCategoryByName(TICKET_RESOURCES.category);
          const staffRole = await context.setuper.findRoleByName(TICKET_RESOURCES.staffRole);
          // Destructured and bound: setup needs three of the port's operations, and
          // reaching through `context.tickets` each time makes the calls read as though
          // they were `this`-dependent when they are not.
          const findCategory = context.tickets.findCategory.bind(context.tickets);
          const saveCategory = context.tickets.saveCategory.bind(context.tickets);
          const { guildId, actorId } = context.tickets;

          let position = 0;
          let seeded = 0;
          let updated = 0;
          for (const definition of TICKET_DEFAULT_CATEGORIES) {
            const before = await findCategory(guildId, definition.key);
            await saveCategory(actorId, {
              guildId,
              key: definition.key,
              label: definition.label,
              emoji: definition.emoji,
              description: definition.description,
              parentId: parent?.id ?? null,
              staffRoleIds: staffRole ? [staffRole.id] : [],
              pingRoleIds: staffRole ? [staffRole.id] : [],
              enabled: true,
              position,
            });
            if (before) {
              updated += 1;
            } else {
              seeded += 1;
            }
            position += 1;
          }

          return {
            status: seeded > 0 ? "created" : "reused",
            detail: `${seeded} created, ${updated} updated`,
          };
        },
      },
    ];
  },
};
