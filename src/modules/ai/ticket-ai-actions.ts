/**
 * `AiTicketActionsPort` over the real `TicketService`.
 *
 * Kept out of `DiscordAiActions` deliberately: that adapter is the only place the
 * AI tool layer may touch discord.js, and the ticket module already owns its own
 * Discord access (`GuildTicketActions`, which sets the channel overwrites). This
 * class therefore holds nothing but a guild-bound service reference, so the agent
 * can do exactly what a staff member clicking the ticket buttons can do — claim,
 * close, delete, read a transcript — and nothing more.
 */
import type { TicketService } from "../tickets/ticket.service.js";
import type { TicketStatus } from "../tickets/ticket.types.js";
import type { AiTicketActionResult, AiTicketActionsPort, AiTicketSummary } from "./ai.module.js";

/** The statuses a caller may filter by, so an unknown string is simply ignored. */
const KNOWN_STATUSES: readonly TicketStatus[] = ["open", "closed", "deleted"];

/** @returns `value` as a known ticket status, or `undefined`. */
function asStatus(value: string | undefined): TicketStatus | undefined {
  return KNOWN_STATUSES.find((status) => status === value);
}

export class TicketAiActions implements AiTicketActionsPort {
  private readonly service: TicketService;
  private readonly guildId: string;

  public constructor(service: TicketService, guildId: string) {
    this.service = service;
    this.guildId = guildId;
  }

  public async list(
    query: { status?: string; limit?: number } = {},
  ): Promise<readonly AiTicketSummary[]> {
    const status = asStatus(query.status);
    const tickets = await this.service.list(this.guildId, {
      ...(status === undefined ? {} : { status }),
      limit: query.limit ?? 20,
    });
    return tickets.map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      status: ticket.status,
      subject: ticket.subject,
      channelId: ticket.channelId,
      claimedById: ticket.claimedById,
    }));
  }

  public async claim(ticketId: string, actorId: string): Promise<AiTicketActionResult> {
    const outcome = await this.service.claim(this.guildId, ticketId, actorId);
    return { ok: outcome.ok, detail: outcome.detail };
  }

  public async close(
    ticketId: string,
    actorId: string,
    reason: string,
  ): Promise<AiTicketActionResult> {
    const outcome = await this.service.close(this.guildId, ticketId, actorId, reason);
    return { ok: outcome.ok, detail: outcome.detail };
  }

  public async remove(ticketId: string, actorId: string): Promise<AiTicketActionResult> {
    const outcome = await this.service.remove(this.guildId, ticketId, actorId);
    return { ok: outcome.ok, detail: outcome.detail };
  }

  public async transcript(
    ticketId: string,
  ): Promise<{ ok: boolean; detail?: string; messageCount?: number }> {
    const stored = await this.service.transcript(ticketId);
    if (!stored) {
      return { ok: false, detail: "this ticket has no stored transcript yet" };
    }
    return { ok: true, messageCount: stored.messageCount };
  }
}
