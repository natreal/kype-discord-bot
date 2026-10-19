/**
 * Closing a ticket is a staff action.
 *
 * The panel posts one component set for every viewer, so the opener sees the Close
 * button too. The handler must therefore refuse the click rather than trust the button
 * being visible — otherwise a member can open a ticket and immediately close it,
 * bypassing the member-limit slot and turning the panel into a create/close loop.
 */
import { GuildMember, type ButtonInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  InteractionHandler,
  type InteractionHandlerDeps,
} from "../src/interactions/interaction.handler.js";
import { CommandRegistry } from "../src/commands/command.registry.js";
import type { TicketRecord } from "../src/modules/tickets/index.js";
import { testLogger } from "./helpers/logger.js";

const GUILD = "guild-1";
const OPENER = "opener-1";
const STAFF = "staff-1";
const TICKET_ID = "ticket-1";

/** A `GuildMember` that passes the handler's `instanceof` check but needs no client. */
function member(id: string): GuildMember {
  // Own data properties are installed before the prototype is attached: assigning
  // `id` afterwards would hit GuildMember's getter-only accessor instead.
  const stub = {
    id,
    guild: { id: GUILD },
    roles: { cache: new Map([["everyone", {}]]) },
  };
  Object.setPrototypeOf(stub, GuildMember.prototype);
  return stub as GuildMember;
}

/** The ticket row both paths read before the authorization decision. */
const ticket: TicketRecord = {
  id: TICKET_ID,
  guildId: GUILD,
  number: 1,
  categoryId: "category-1",
  channelId: "channel-1",
  openerId: OPENER,
  claimedById: null,
  status: "open",
  priority: "normal",
  subject: null,
  firstResponseAt: null,
  closedAt: null,
  closedById: null,
  closeReason: null,
  messageCount: 0,
  createdAt: new Date("2026-01-01T12:00:00.000Z"),
};

interface Harness {
  readonly handler: InteractionHandler;
  readonly interaction: ButtonInteraction;
  readonly close: ReturnType<typeof vi.fn>;
  readonly replies: unknown[];
}

/** Builds the real handler with only the ticket path wired. */
function harness(options: { staff: boolean; userId: string }): Harness {
  const replies: unknown[] = [];
  const close = vi.fn(async () => ({ ok: true, detail: "Ticket closed." }));

  const service = {
    find: async () => ticket,
    isTicketStaff: async () => options.staff,
    staffCategoryIds: async () => [],
    close,
  };

  const interaction = {
    id: "interaction-1",
    customId: `ticket:close:${TICKET_ID}`,
    guild: { id: GUILD },
    guildId: GUILD,
    channelId: "channel-1",
    user: { id: options.userId, username: options.userId },
    member: member(options.userId),
    deferred: false,
    replied: false,
    inGuild: () => true,
    isButton: () => true,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => {
      replies.push(payload);
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ButtonInteraction;

  const handler = new InteractionHandler({
    logger: testLogger,
    commands: new CommandRegistry(),
    permissions: {
      check: () => ({ allowed: false, missing: ["tickets.view"] }),
      isGodAccess: () => false,
    },
    config: {},
    database: {},
    setup: {},
    setupResources: [],
    createSetupContext: () => ({ definitions: [], resources: {}, permissionService: {} }),
    createModerationContext: () => ({ service: {}, members: {} }),
    createSecurityContext: () => ({ service: {}, actions: {} }),
    createAutomodContext: () => ({ service: {} }),
    createTicketContext: () => ({ service }),
    createBackupService: () => ({}),
    client: {},
    appConfig: {},
    audit: {},
    startedAt: Date.now(),
  } as unknown as InteractionHandlerDeps);

  // The handler is exercised through its public dispatcher: the fake above is shaped
  // like a button interaction and `handle` routes it to `handleTicketClose`.
  return { handler, interaction, close, replies };
}

/** @returns the description of the first reply embed. */
function descriptionOf(replies: readonly unknown[]): string {
  const payload = replies[0] as { embeds?: { data: { description?: string } }[] };
  return payload.embeds?.[0]?.data.description ?? "";
}

describe("ticket close authorization", () => {
  it("refuses the opener even though the Close button was posted in their channel", async () => {
    const { handler, interaction, close, replies } = harness({ staff: false, userId: OPENER });

    await handler.handle(interaction);

    expect(close).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain("Only the support team can close this ticket.");
  });

  it("lets ticket staff close the ticket", async () => {
    const { handler, interaction, close, replies } = harness({ staff: true, userId: STAFF });

    await handler.handle(interaction);

    expect(close).toHaveBeenCalledWith(GUILD, TICKET_ID, STAFF, "Closed from the ticket panel");
    expect(descriptionOf(replies)).toContain("Ticket closed.");
  });
});
