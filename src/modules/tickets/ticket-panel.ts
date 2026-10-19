/**
 * Ticket panel and per-ticket control payloads.
 *
 * Two pure builders, kept apart from the service and from discord.js value construction
 * on purpose:
 *
 * - `buildTicketPanel` renders the message members click to open a ticket. The custom
 *   id carries the category *key*, not its database id: the key is stable across a
 *   reinstall, readable in a log, and safe to embed in a component id whose length
 *   Discord caps.
 * - `buildTicketControls` renders the buttons inside a ticket channel.
 *
 * Both return plain descriptors rather than discord.js builders, so the shape is
 * testable without a client and the command layer is the only place that turns a
 * descriptor into an `ActionRowBuilder`.
 */

/** A button or select-option descriptor, independent of discord.js. */
export interface PanelButton {
  /** Component custom id, already namespaced and length-checked. */
  readonly customId: string;
  readonly label: string;
  /** `primary`, `secondary`, `success` or `danger`. */
  readonly style: "primary" | "secondary" | "success" | "danger";
  readonly emoji?: string;
  /** Disabled buttons are rendered but not clickable — used for exhausted actions. */
  readonly disabled?: boolean;
}

/** A row of up to five buttons. */
export interface PanelRow {
  readonly buttons: readonly PanelButton[];
}

/** The open-ticket panel for a guild's categories. */
export interface TicketPanel {
  readonly title: string;
  readonly description: string;
  readonly rows: readonly PanelRow[];
}

/** Custom-id prefixes. Exported so the interaction router and the builder agree. */
export const TICKET_IDS = {
  /** `ticket:open:<categoryKey>`. */
  open: "ticket:open:",
  /** `ticket:close:<ticketId>`. */
  close: "ticket:close:",
  /** `ticket:claim:<ticketId>`. */
  claim: "ticket:claim:",
  /** `ticket:transcript:<ticketId>`. */
  transcript: "ticket:transcript:",
  /** `ticket:delete:<ticketId>`. */
  delete: "ticket:delete:",
} as const;

/** Discord's maximum custom id length. */
const MAX_CUSTOM_ID = 100;

/**
 * @returns the panel rows for a guild's categories, or an empty array when there are
 * none — an empty panel is a message with no buttons, which the caller renders as
 * "no categories configured" rather than as a broken component.
 *
 * Categories are chunked into rows of five because Discord rejects a sixth button in a
 * row; a guild with seven categories therefore gets two rows rather than an error.
 */
export function buildTicketPanel(
  categories: readonly { key: string; label: string; emoji?: string | null }[],
): TicketPanel {
  const buttons: PanelButton[] = categories.slice(0, 25).map((category) => ({
    customId: truncateId(`${TICKET_IDS.open}${category.key}`),
    label: category.label,
    style: "primary",
    ...(category.emoji ? { emoji: category.emoji } : {}),
  }));

  const rows: PanelRow[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({ buttons: buttons.slice(index, index + 5) });
  }

  return {
    title: "Need help?",
    description:
      buttons.length === 0
        ? "No ticket categories are configured yet. An administrator can add one with `/ticket category`."
        : "Choose a category below and I will open a private channel for you.",
    rows,
  };
}

/**
 * @returns the control buttons for a ticket channel.
 *
 * The Claim button is disabled once the ticket is claimed by *someone else*, so a
 * second staff member sees why it is unavailable rather than clicking into a refusal.
 * The opener sees the same buttons because a channel message has one component set for
 * every viewer; the interaction handler refuses claim, close, transcript and delete for
 * anyone who is not ticket staff, so the buttons never grant access by themselves.
 */
export function buildTicketControls(ticket: {
  id: string;
  status: string;
  claimedById: string | null;
  claimedBySelf?: boolean;
}): PanelRow {
  const isOpen = ticket.status === "open";
  const claimedByOther = ticket.claimedById !== null && ticket.claimedBySelf !== true;

  return {
    buttons: [
      {
        customId: truncateId(`${TICKET_IDS.claim}${ticket.id}`),
        label: ticket.claimedBySelf ? "You are handling this" : "Claim",
        style: "primary",
        disabled: !isOpen || claimedByOther,
      },
      {
        customId: truncateId(`${TICKET_IDS.close}${ticket.id}`),
        label: "Close",
        style: "danger",
        disabled: !isOpen,
      },
      {
        customId: truncateId(`${TICKET_IDS.transcript}${ticket.id}`),
        label: "Transcript",
        style: "secondary",
      },
      {
        customId: truncateId(`${TICKET_IDS.delete}${ticket.id}`),
        label: "Delete channel",
        style: "danger",
        disabled: ticket.status === "deleted",
      },
    ],
  };
}

/**
 * How many tickets the `/ticket list` reply carries buttons for.
 *
 * Discord caps a message at five action rows, and each ticket needs its own row
 * (one button cannot serve two tickets), so the first five tickets get controls and
 * the rest stay readable as embeds.
 */
export const QUEUE_CONTROL_ROWS = 5;

/**
 * @returns the Claim / Close / Transcript / Delete buttons for a ticket queue.
 *
 * The queue exists for a staff member who is *not* in the ticket channel, which is
 * exactly why the controls travel with it: without them, handling ticket #12 meant
 * opening the channel, scrolling to the buttons and coming back. Each row is
 * labelled with its ticket number so a row is never ambiguous about what it acts
 * on, and Claim is disabled once anyone holds the ticket.
 */
export function buildTicketQueueControls(
  tickets: readonly {
    id: string;
    number: number;
    status: string;
    claimedById: string | null;
  }[],
): PanelRow[] {
  return tickets.slice(0, QUEUE_CONTROL_ROWS).map((ticket) => {
    const isOpen = ticket.status === "open";
    return {
      buttons: [
        {
          customId: truncateId(`${TICKET_IDS.claim}${ticket.id}`),
          label: `#${ticket.number} Claim`,
          style: "primary",
          disabled: !isOpen || ticket.claimedById !== null,
        },
        {
          customId: truncateId(`${TICKET_IDS.close}${ticket.id}`),
          label: `#${ticket.number} Close`,
          style: "danger",
          disabled: !isOpen,
        },
        {
          customId: truncateId(`${TICKET_IDS.transcript}${ticket.id}`),
          label: `#${ticket.number} Transcript`,
          style: "secondary",
        },
        {
          customId: truncateId(`${TICKET_IDS.delete}${ticket.id}`),
          label: `#${ticket.number} Delete`,
          style: "danger",
          disabled: ticket.status === "deleted",
        },
      ],
    };
  });
}

/**
 * @returns `id` shortened to Discord's limit.
 *
 * Every id this module builds is `prefix` + a cuid or a slug, so it is well inside the
 * limit; the truncation exists so a future longer identifier degrades into a mismatched
 * button — which the router reports — rather than into a rejected interaction payload.
 */
function truncateId(id: string): string {
  return id.length <= MAX_CUSTOM_ID ? id : id.slice(0, MAX_CUSTOM_ID);
}
