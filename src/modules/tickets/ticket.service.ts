/**
 * Ticket service.
 *
 * The rules live here and the Discord calls live behind a port, for the same reason as
 * every other module: the interesting parts — who may see what, what happens when a
 * close races a reopen, whether a double close is an error — must be testable without a
 * live guild.
 *
 * Three decisions are worth stating because they are choices, not consequences:
 *
 * 1. **Closing does not delete.** The channel is locked and the transcript is stored, so
 *    a staff member can still read the conversation after closing it. Deletion is a
 *    separate, explicit operation.
 * 2. **A duplicate close is not an error.** Two staff clicking Close at the same moment
 *    is normal, and the second is told the ticket is already closed rather than shown a
 *    failure. The repository's guarded update is what makes that answer truthful.
 * 3. **Losing the race to create is reported, not retried silently.** If the channel is
 *    created but the row cannot be written, the channel is deleted again: an orphan
 *    channel that no record points at is exactly the state `/ticket close` cannot fix.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import { renderTranscript } from "./ticket-transcript.js";
import { buildTicketControls, type PanelRow } from "./ticket-panel.js";
import type {
  TicketCategoryRecord,
  TicketPriority,
  TicketQuery,
  TicketRecord,
  TicketRepository,
} from "./ticket.types.js";

/** One message as the Discord port reads it. */
export interface TranscriptMessageInput {
  readonly authorId: string;
  readonly authorName: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly createdAt: Date;
  readonly attachments?: readonly string[];
}

/**
 * The Discord operations the service needs.
 *
 * Narrow on purpose: the service can create a channel, post to it, rename it, lock it,
 * delete it and read its history — and nothing else. It cannot, for example, edit
 * arbitrary permissions or speak in a channel it was not given, which keeps the
 * security-sensitive part inside one adapter.
 */
export interface GuildTicketActions {
  createChannel(input: {
    name: string;
    parentId: string | null;
    openerId: string;
    staffRoleIds: readonly string[];
    topic: string;
  }): Promise<{ ok: boolean; channelId?: string; detail?: string }>;
  sendMessage(
    channelId: string,
    content: {
      content?: string;
      embeds?: readonly unknown[];
      components?: readonly PanelRow[];
    },
    files?: readonly { name: string; attachment: Buffer }[],
  ): Promise<{ ok: boolean; messageId?: string; detail?: string }>;
  renameChannel(
    channelId: string,
    name: string,
    reason: string,
  ): Promise<TicketActionResultOutcome>;
  archiveChannel(channelId: string, reason: string): Promise<TicketActionResultOutcome>;
  deleteChannel(channelId: string, reason: string): Promise<TicketActionResultOutcome>;
  fetchHistory(
    channelId: string,
    limit: number,
  ): Promise<{
    ok: boolean;
    messages?: readonly TranscriptMessageInput[];
    detail?: string;
  }>;
}

/** Result of one Discord mutation, mirroring `TicketActionResult` in the types file. */
export interface TicketActionResultOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

/** Maximum messages read into a transcript. */
export const TRANSCRIPT_MESSAGE_LIMIT = 1_000;

/**
 * Default ceiling on a member's open tickets.
 *
 * Mirrors `tickets.memberTicketLimit` in the guild schema. It exists so a service
 * built without a configuration source (a harness) still enforces a sane limit rather
 * than letting `open` become unbounded.
 */
export const DEFAULT_MEMBER_TICKET_LIMIT = 3;

/** A ticket is treated as "about to be swept" after this long closed. */
export const TICKET_CLOSE_GRACE_MS = 0;

/** Outcome of one ticket operation, shaped for a command to render. */
export interface TicketOutcome {
  readonly ok: boolean;
  /** Short, user-safe message. */
  readonly detail: string;
  readonly ticket?: TicketRecord;
}

/** Everything the service needs. */
export interface TicketServiceOptions {
  readonly logger: Logger;
  readonly audit: AuditEventService;
  readonly repository: TicketRepository;
  readonly actions: GuildTicketActions;
  /** `true` when the tickets module is switched on for this guild. */
  readonly enabled: (guildId: string) => Promise<boolean>;
  /**
   * Roles that may see and handle tickets of *every* category, on top of each
   * category's own `staffRoleIds`.
   *
   * Wired to the permission-class store so admins (`administrator`, `bot-manager`) and
   * the `support` class get ticket access without holding Discord's `Administrator`
   * permission: the bot already knows "this role is admin", and that is enough. Omitted
   * in minimal harnesses, where only the category's staff roles apply.
   */
  readonly ticketAccessRoleIds?: (guildId: string) => Promise<string[]>;
  /**
   * Maximum number of open tickets one member may hold. Read per call, so changing it in
   * `/settings` applies to the next open rather than to the next restart.
   */
  readonly memberLimit?: (guildId: string) => Promise<number>;
}

export class TicketService {
  private readonly logger: Logger;
  private readonly audit: AuditEventService;
  private readonly repository: TicketRepository;
  private readonly actions: GuildTicketActions;
  private readonly enabled: (guildId: string) => Promise<boolean>;
  private readonly ticketAccessRoleIds: (guildId: string) => Promise<string[]>;
  private readonly memberLimit: (guildId: string) => Promise<number>;

  public constructor(options: TicketServiceOptions) {
    this.logger = options.logger.child("tickets");
    this.audit = options.audit;
    this.repository = options.repository;
    this.actions = options.actions;
    this.enabled = options.enabled;
    this.ticketAccessRoleIds = options.ticketAccessRoleIds ?? (() => Promise.resolve([]));
    this.memberLimit = options.memberLimit ?? (() => Promise.resolve(DEFAULT_MEMBER_TICKET_LIMIT));
  }

  /** @returns the guild's enabled categories, in panel order. */
  public async categories(guildId: string): Promise<TicketCategoryRecord[]> {
    const all = await this.repository.listCategories(guildId);
    return all.filter((category) => category.enabled);
  }

  /** @returns every category, including disabled ones, for the admin surface. */
  public async allCategories(guildId: string): Promise<TicketCategoryRecord[]> {
    return this.repository.listCategories(guildId);
  }

  /** @returns a category by its stable key, or `null` — used by setup seeding. */
  public async findCategory(guildId: string, key: string): Promise<TicketCategoryRecord | null> {
    return this.repository.findCategory(guildId, key);
  }

  /** Deletes a category by key. @returns false when no such category existed. */
  public async deleteCategory(guildId: string, key: string, actorId: string): Promise<boolean> {
    const removed = await this.repository.deleteCategory(guildId, key);
    if (removed) {
      await this.audit.record({
        guildId,
        action: "ticket.category.deleted",
        category: "tickets",
        severity: "info",
        actorId,
        actorKind: "user",
        details: { key },
      });
      this.logger.info("Ticket category deleted", { guildId, key });
    }
    return removed;
  }

  /** Creates or updates a category. Used by `/setup` and `/ticket category`. */
  public async saveCategory(
    actorId: string,
    draft: Parameters<TicketRepository["upsertCategory"]>[0],
  ): Promise<TicketCategoryRecord> {
    const saved = await this.repository.upsertCategory(draft);
    await this.audit.record({
      guildId: draft.guildId,
      action: "ticket.category.saved",
      category: "tickets",
      severity: "info",
      actorId,
      actorKind: "user",
      details: { key: draft.key, enabled: saved.enabled },
    });
    this.logger.info("Ticket category saved", {
      guildId: draft.guildId,
      key: draft.key,
    });
    return saved;
  }

  /**
   * Opens a ticket: creates the channel, then the record.
   *
   * Order matters. The row needs a `channelId`, so the channel is created first; but a
   * channel with no row is invisible to every other code path, so if the row fails the
   * channel is deleted again rather than left as an orphan that `/ticket close` cannot
   * find.
   */
  public async open(
    guildId: string,
    input: {
      categoryKey: string;
      openerId: string;
      openerName: string;
      subject?: string | null;
      priority?: TicketPriority;
    },
  ): Promise<TicketOutcome> {
    if (!(await this.enabled(guildId))) {
      return { ok: false, detail: "tickets are disabled in this server" };
    }

    const category = await this.repository.findCategory(guildId, input.categoryKey);
    if (!category || !category.enabled) {
      return { ok: false, detail: `unknown ticket category: ${input.categoryKey}` };
    }

    // One live ticket per member per category. Without this a member can open a dozen
    // channels by clicking repeatedly, which is the standard way this feature is abused.
    const existing = await this.repository.list(guildId, {
      openerId: input.openerId,
      categoryId: category.id,
      status: "open",
      limit: 1,
    });
    const alreadyOpen = existing[0];
    if (alreadyOpen) {
      return {
        ok: false,
        detail: `you already have ticket #${alreadyOpen.number} open for ${category.label}`,
        ticket: alreadyOpen,
      };
    }

    // The per-category rule above stops a duplicate; this is the server's ceiling across
    // every category. It is read per call, so a `/settings` change applies to the next
    // click rather than to the next restart.
    const limit = Math.max(1, Math.trunc(await this.memberLimit(guildId)));
    const openTickets = await this.repository.list(guildId, {
      openerId: input.openerId,
      status: "open",
      limit,
    });
    if (openTickets.length >= limit) {
      return {
        ok: false,
        detail:
          limit === 1
            ? "you already have an open ticket, and the server allows one at a time"
            : `you already have ${limit} open tickets, which is the server's limit`,
        ...(openTickets[0] === undefined ? {} : { ticket: openTickets[0] }),
      };
    }

    const subject = input.subject?.trim() || null;
    // The channel must be visible to the category's staff roles *and* to every role the
    // bot already recognizes as able to handle tickets (admins, the support class), so a
    // server doesn't have to hardcode an admin role into every category.
    const staffRoleIds = mergeRoles(category.staffRoleIds, await this.ticketAccessRoleIds(guildId));
    const created = await this.actions.createChannel({
      name: channelName(category.key, input.openerName),
      parentId: category.parentId,
      openerId: input.openerId,
      staffRoleIds,
      topic: subject ?? category.description ?? category.label,
    });
    if (!created.ok || !created.channelId) {
      return { ok: false, detail: created.detail ?? "Discord refused the channel" };
    }

    let ticket: TicketRecord;
    try {
      ticket = await this.repository.create({
        guildId,
        categoryId: category.id,
        channelId: created.channelId,
        openerId: input.openerId,
        subject,
        priority: input.priority ?? "normal",
      });
    } catch (error) {
      await this.actions.deleteChannel(
        created.channelId,
        "Ticket record could not be created — rolling back",
      );
      this.logger.error("Ticket channel rolled back", error, { guildId, category: category.key });
      return { ok: false, detail: "the ticket could not be recorded, so nothing was created" };
    }

    await this.audit.record({
      guildId,
      action: "ticket.opened",
      category: "tickets",
      severity: "info",
      actorId: input.openerId,
      actorKind: "user",
      targetType: "ticket",
      targetId: ticket.id,
      details: { ticketNumber: ticket.number, category: category.key },
    });
    this.logger.info("Ticket opened", {
      guildId,
      ticketNumber: ticket.number,
      category: category.key,
    });

    // The control buttons are how staff claim or close the ticket: without them the
    // channel is just a private room with no visible way to act on it, which is the
    // exact "we can't claim or close tickets" symptom. The post is best-effort — a
    // ticket whose intro message fails is still an open ticket — but the failure is
    // logged rather than swallowed.
    await this.postControls(guildId, ticket);

    return { ok: true, detail: `ticket #${ticket.number} opened`, ticket };
  }

  /** Assigns a staff member to a ticket. Losing the race is reported, not retried. */
  public async claim(guildId: string, ticketId: string, staffId: string): Promise<TicketOutcome> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.guildId !== guildId) {
      return { ok: false, detail: "no such ticket" };
    }
    if (ticket.status !== "open") {
      return { ok: false, detail: `ticket #${ticket.number} is ${ticket.status}` };
    }
    if (ticket.openerId === staffId) {
      // The opener is the one being helped, not the helper: letting them claim their own
      // ticket would leave it "handled" with nobody actually assigned to answer it.
      return { ok: false, detail: "you can't claim your own ticket" };
    }
    if (ticket.claimedById === staffId) {
      // Idempotent rather than an error: a double-click on Claim is not a mistake worth
      // reporting, and the state the caller wanted already holds.
      return { ok: true, detail: `you are already handling ticket #${ticket.number}`, ticket };
    }
    if (ticket.claimedById) {
      return {
        ok: false,
        detail: `ticket #${ticket.number} is already claimed by <@${ticket.claimedById}>`,
        ticket,
      };
    }

    const won = await this.repository.claim(ticketId, staffId);
    if (!won) {
      return { ok: false, detail: "someone else claimed this ticket first" };
    }

    await this.audit.record({
      guildId,
      action: "ticket.claimed",
      category: "tickets",
      severity: "info",
      actorId: staffId,
      actorKind: "user",
      targetType: "ticket",
      targetId: ticket.id,
      details: { ticketNumber: ticket.number },
    });
    return { ok: true, detail: `you are now handling ticket #${ticket.number}`, ticket };
  }

  /**
   * Closes a ticket: transcript first, then lock, then record.
   *
   * The transcript is taken *before* the channel is locked, because a locked channel is
   * one permission edit away from being unreadable, and the transcript is the artifact
   * that must survive. If the transcript fails the close still proceeds — refusing to
   * close a ticket because transcription failed would leave staff unable to finish a
   * conversation, which is worse than a missing transcript — but the failure is logged
   * and reported in the outcome so it is not silent.
   */
  public async close(
    guildId: string,
    ticketId: string,
    staffId: string,
    reason: string,
  ): Promise<TicketOutcome & { transcriptSaved: boolean }> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.guildId !== guildId) {
      return { ok: false, detail: "no such ticket", transcriptSaved: false };
    }
    if (ticket.status !== "open") {
      return {
        ok: false,
        detail: `ticket #${ticket.number} is already ${ticket.status}`,
        ticket,
        transcriptSaved: false,
      };
    }

    const transcriptSaved = await this.captureTranscript(guildId, ticket);
    const closedAt = new Date();
    const won = await this.repository.close(ticketId, staffId, reason, closedAt);
    if (!won) {
      // Lost the race: another close committed between the read and the write. The
      // outcome is the one the caller wanted, so it is reported as closed.
      return {
        ok: true,
        detail: `ticket #${ticket.number} was closed by someone else`,
        ticket: (await this.repository.findById(ticketId)) ?? ticket,
        transcriptSaved,
      };
    }

    await this.actions.archiveChannel(ticket.channelId, `Closed by ${staffId}: ${reason}`);

    await this.audit.record({
      guildId,
      action: "ticket.closed",
      category: "tickets",
      severity: "info",
      actorId: staffId,
      actorKind: "user",
      targetType: "ticket",
      targetId: ticket.id,
      details: { ticketNumber: ticket.number, reason, transcriptSaved },
    });
    this.logger.info("Ticket closed", {
      guildId,
      ticketNumber: ticket.number,
      transcriptSaved,
    });

    return {
      ok: true,
      detail: transcriptSaved
        ? `ticket #${ticket.number} closed`
        : `ticket #${ticket.number} closed, but the transcript could not be saved`,
      ticket: (await this.repository.findById(ticketId)) ?? ticket,
      transcriptSaved,
    };
  }

  /**
   * Reopens a closed ticket.
   *
   * A reopen creates a *new* channel rather than unlocking the old one, because the old
   * channel may have been deleted, renamed or repurposed in the meantime, and a ticket
   * that claims to be open while pointing at a channel that no longer exists is worse
   * than one that takes a second to reopen.
   */
  public async reopen(
    guildId: string,
    ticketId: string,
    staffId: string,
    input: { categoryKey: string; openerName: string },
  ): Promise<TicketOutcome> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.guildId !== guildId) {
      return { ok: false, detail: "no such ticket" };
    }
    if (ticket.status === "open") {
      return { ok: false, detail: `ticket #${ticket.number} is already open`, ticket };
    }
    if (ticket.status === "deleted") {
      return { ok: false, detail: `ticket #${ticket.number} was deleted and cannot be reopened` };
    }

    const category = await this.repository.findCategory(guildId, input.categoryKey);
    if (!category) {
      return { ok: false, detail: `unknown ticket category: ${input.categoryKey}` };
    }

    const staffRoleIds = mergeRoles(category.staffRoleIds, await this.ticketAccessRoleIds(guildId));
    const created = await this.actions.createChannel({
      name: channelName(category.key, input.openerName),
      parentId: category.parentId,
      openerId: ticket.openerId,
      staffRoleIds,
      topic: ticket.subject ?? category.label,
    });
    if (!created.ok || !created.channelId) {
      return { ok: false, detail: created.detail ?? "Discord refused the channel" };
    }

    const reopened = await this.repository.reopen(ticketId, created.channelId);
    if (!reopened) {
      // Someone reopened it between the read and the write; drop the channel we made so
      // the member is not left with two.
      await this.actions.deleteChannel(created.channelId, "Duplicate reopen — rolling back");
      return { ok: false, detail: "that ticket was reopened by someone else" };
    }

    await this.audit.record({
      guildId,
      action: "ticket.reopened",
      category: "tickets",
      severity: "info",
      actorId: staffId,
      actorKind: "user",
      targetType: "ticket",
      targetId: ticket.id,
      details: { ticketNumber: ticket.number },
    });

    const reopenedTicket = (await this.repository.findById(ticketId)) ?? ticket;
    // A reopened ticket gets a fresh channel, so it needs a fresh set of control
    // buttons too — otherwise the very actions that close the ticket are missing again.
    await this.postControls(guildId, reopenedTicket);

    return {
      ok: true,
      detail: `ticket #${ticket.number} reopened`,
      ticket: reopenedTicket,
    };
  }

  /** Deletes a ticket's channel and marks the record deleted. */
  public async remove(guildId: string, ticketId: string, staffId: string): Promise<TicketOutcome> {
    const ticket = await this.repository.findById(ticketId);
    if (!ticket || ticket.guildId !== guildId) {
      return { ok: false, detail: "no such ticket" };
    }
    if (ticket.status === "deleted") {
      return { ok: true, detail: `ticket #${ticket.number} is already deleted`, ticket };
    }

    // A deleted ticket must not lose its evidence, so the transcript is taken again
    // unless one already exists.
    if (!(await this.repository.findTranscript(ticketId))) {
      await this.captureTranscript(guildId, ticket);
    }
    await this.actions.deleteChannel(ticket.channelId, `Deleted by ${staffId}`);
    await this.repository.markDeleted(ticketId);

    await this.audit.record({
      guildId,
      action: "ticket.deleted",
      category: "tickets",
      severity: "privileged",
      actorId: staffId,
      actorKind: "user",
      targetType: "ticket",
      targetId: ticket.id,
      details: { ticketNumber: ticket.number },
    });
    return {
      ok: true,
      detail: `ticket #${ticket.number} deleted`,
      ticket: (await this.repository.findById(ticketId)) ?? ticket,
    };
  }

  /** @returns the stored transcript, or `null`. */
  public async transcript(ticketId: string) {
    return this.repository.findTranscript(ticketId);
  }

  /** @returns active tickets for a guild, newest first. */
  public async list(guildId: string, query: TicketQuery = {}): Promise<TicketRecord[]> {
    return this.repository.list(guildId, query);
  }

  /** @returns the ticket a channel belongs to, if any. */
  public async byChannel(guildId: string, channelId: string): Promise<TicketRecord | null> {
    return this.repository.findByChannel(guildId, channelId);
  }

  /**
   * @returns a ticket by id, but only when it belongs to `guildId`.
   *
   * The guild check is structural: a stale button from another server resolves to
   * `null`, so the caller refuses before it can act on a foreign ticket.
   */
  public async find(guildId: string, ticketId: string): Promise<TicketRecord | null> {
    const ticket = await this.repository.findById(ticketId);
    return ticket && ticket.guildId === guildId ? ticket : null;
  }

  /**
   * @returns true when one of `roleIds` grants access to every category.
   *
   * Used by the command and component layers to recognize the configured staff role
   * even when it is not bound to a permission class. Guild owners and Administrators
   * hold no role a service can inspect, so callers still ask the authorization layer
   * first and treat this as the role-based half of the answer.
   */
  public async isTicketStaff(guildId: string, roleIds: readonly string[]): Promise<boolean> {
    const accessRoleIds = await this.ticketAccessRoleIds(guildId);
    return accessRoleIds.some((roleId) => roleIds.includes(roleId));
  }

  /**
   * @returns the ids of the categories whose `staffRoleIds` name one of `roleIds`.
   *
   * A helper nominated by a single category sees that category's queue, not the whole
   * server's: an appeal reviewer should not read reports, and the ticket channel's
   * overwrites already enforce the same boundary.
   */
  public async staffCategoryIds(guildId: string, roleIds: readonly string[]): Promise<string[]> {
    const categories = await this.repository.listCategories(guildId);
    return categories
      .filter((category) => category.staffRoleIds.some((roleId) => roleIds.includes(roleId)))
      .map((category) => category.id);
  }

  /**
   * Posts the Claim / Close / Transcript buttons into a ticket's channel.
   *
   * These buttons are the only surface staff have for "claim" and "close"; the slash
   * command deliberately excludes those subcommands (they stay on the ticket where a
   * staff member is looking), so a ticket whose intro message never lands is a ticket
   * that cannot be claimed or closed. Posting is therefore part of *opening*, not an
   * afterthought, and part of *reopening* too, since a reopen creates a brand-new
   * channel with nothing in it.
   *
   * Best-effort: a failed post is logged, not thrown, because an open ticket with no
   * buttons is still better than an open ticket the opening call reported as a failure
   * and a member who clicked the panel a second time.
   */
  private async postControls(guildId: string, ticket: TicketRecord): Promise<void> {
    const controls = buildTicketControls({
      id: ticket.id,
      status: ticket.status,
      claimedById: ticket.claimedById,
    });

    const result = await this.actions.sendMessage(ticket.channelId, {
      content: ticket.subject
        ? `**Ticket #${ticket.number}** — ${ticket.subject}`
        : `**Ticket #${ticket.number}**`,
      components: [controls],
    });

    if (!result.ok) {
      this.logger.warn("Ticket control buttons could not be posted", {
        guildId,
        ticketNumber: ticket.number,
        detail: result.detail ?? "unknown",
        impact: "Staff may be unable to claim or close this ticket until it is reopened.",
      });
    }
  }

  /**
   * Reads the channel and stores the transcript.
   *
   * @returns true when a transcript was stored. A `false` is a *reported* failure, never
   * a silent one: the caller includes it in the outcome, and the audit event records it,
   * because "closed with no transcript" is something an operator will later need to
   * explain.
   */
  private async captureTranscript(guildId: string, ticket: TicketRecord): Promise<boolean> {
    const history = await this.actions.fetchHistory(ticket.channelId, TRANSCRIPT_MESSAGE_LIMIT);
    if (!history.ok || !history.messages) {
      this.logger.warn("Ticket transcript unavailable", {
        guildId,
        ticketNumber: ticket.number,
        detail: history.detail ?? "unknown",
      });
      return false;
    }

    // Stored as Markdown: it is the format a human reads in a code block or a pull
    // request, and the one that survives being pasted into a chat client unchanged.
    const rendered = renderTranscript(
      [...history.messages],
      { guildId, ticketNumber: ticket.number, subject: ticket.subject },
      "markdown",
    );

    try {
      await this.repository.saveTranscript({
        ticketId: ticket.id,
        guildId,
        content: rendered.content,
        format: rendered.format,
        messageCount: rendered.messageCount,
        checksum: rendered.checksum,
      });
      return true;
    } catch (error) {
      this.logger.error("Ticket transcript could not be stored", error, {
        guildId,
        ticketNumber: ticket.number,
      });
      return false;
    }
  }
}

/**
 * @returns the two role lists merged and de-duplicated, preserving order.
 *
 * The category's own staff roles come first, then any additional access roles the
 * caller resolved (admin roles via the permission-class model). De-duplication matters
 * because a role can legitimately appear in both lists — a category that already names
 * the admin role as staff must not write two identical overwrites.
 */
function mergeRoles(
  categoryRoles: readonly string[],
  accessRoles: readonly string[],
): readonly string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const roleId of [...categoryRoles, ...accessRoles]) {
    if (!seen.has(roleId)) {
      seen.add(roleId);
      merged.push(roleId);
    }
  }
  return merged;
}

/**
 * @returns a Discord-safe channel name for a new ticket.
 *
 * Discord lowercases and hyphenates channel names anyway, so this does the work up front
 * rather than letting Discord reinterpret it: the name a staff member sees in the logs
 * is then the name that exists. The opener's name is included because a channel list of
 * `ticket-general`, `ticket-general`, `ticket-general` is useless.
 */
function channelName(categoryKey: string, openerName: string): string {
  const slug = openerName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return `${categoryKey}-${slug || "member"}`.slice(0, 100);
}
