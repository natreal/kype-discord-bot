/**
 * Ticket module types.
 *
 * A ticket is a **record**, and its Discord channel is only that record's current
 * home. That distinction drives every decision here:
 *
 * - The row outlives the channel, so `/ticket reopen` works after a close and the
 *   statistics ("time to first response", "tickets per category") are computed from
 *   what actually happened rather than from a re-read of a channel that may be gone.
 * - `number` is per-guild and gap-free, because staff refer to tickets by number in
 *   conversation. A number allocated inside a transaction that rolls back would leave
 *   a hole someone will eventually ask about.
 * - The transcript is stored as text with a checksum, not as a channel attachment: an
 *   attachment in a deleted channel is one moderation action away from being lost, and
 *   the transcript is exactly the evidence a moderator reads months later.
 *
 * Discord access is a port (`GuildTicketActions`) for the usual reason: the service
 * must be testable against a fake, and permission overwrites are security-sensitive
 * enough to deserve one implementation, reviewed once.
 */

/** Lifecycle state of a ticket. Mirrors the `status` column. */
export type TicketStatus = "open" | "closed" | "deleted";

/** Staff-set urgency, shared with the reports queue so a single ordering exists. */
export type TicketPriority = "low" | "normal" | "high";

/** A ticket category: the button on the panel and who may handle it. */
export interface TicketCategoryRecord {
  readonly id: string;
  readonly guildId: string;
  /** Stable slug used in component custom IDs. */
  readonly key: string;
  readonly label: string;
  readonly emoji: string | null;
  readonly description: string | null;
  /** Discord category new ticket channels are placed in. */
  readonly parentId: string | null;
  /** Staff roles that may see and claim tickets of this category. */
  readonly staffRoleIds: readonly string[];
  /** Roles pinged when a ticket opens. Defaults to `staffRoleIds` when empty. */
  readonly pingRoleIds: readonly string[];
  /** Question asked before the ticket is created, when set. */
  readonly prompt: string | null;
  readonly enabled: boolean;
  readonly position: number;
}

/** Everything needed to create or update a category. */
export interface TicketCategoryDraft {
  readonly guildId: string;
  readonly key: string;
  readonly label: string;
  readonly emoji?: string | null;
  readonly description?: string | null;
  readonly parentId?: string | null;
  readonly staffRoleIds?: readonly string[];
  readonly pingRoleIds?: readonly string[];
  readonly prompt?: string | null;
  readonly enabled?: boolean;
  readonly position?: number;
}

/** A persisted ticket. */
export interface TicketRecord {
  readonly id: string;
  readonly guildId: string;
  /** Human-facing, per-guild, gap-free. Rendered as `ticket #12`. */
  readonly number: number;
  readonly categoryId: string;
  readonly channelId: string;
  readonly openerId: string;
  readonly claimedById: string | null;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly subject: string | null;
  /** When the first staff reply happened, for the response-time statistic. */
  readonly firstResponseAt: Date | null;
  readonly closedAt: Date | null;
  readonly closedById: string | null;
  readonly closeReason: string | null;
  readonly messageCount: number;
  readonly createdAt: Date;
}

/** Everything needed to open a ticket. */
export interface TicketDraft {
  readonly guildId: string;
  readonly categoryId: string;
  readonly channelId: string;
  readonly openerId: string;
  readonly subject?: string | null;
  readonly priority?: TicketPriority;
}

/** Filters for the ticket list. All guild-scoped. */
export interface TicketQuery {
  readonly status?: TicketStatus | null;
  readonly categoryId?: string | null;
  readonly openerId?: string | null;
  readonly claimedById?: string | null;
  readonly limit?: number;
}

/** A stored transcript. */
export interface TicketTranscriptRecord {
  readonly id: string;
  readonly ticketId: string;
  readonly guildId: string;
  readonly content: string;
  readonly format: "markdown" | "html";
  readonly messageCount: number;
  readonly checksum: string;
  readonly createdAt: Date;
}

/** A message as the transcript renderer sees it. */
export interface TranscriptMessage {
  readonly authorId: string;
  readonly authorName: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly createdAt: Date;
  /** Attachment file names, rendered as a list rather than fetched. */
  readonly attachments?: readonly string[];
}

/**
 * Persistence port for tickets.
 *
 * `create` allocates the per-guild number inside the same transaction as the insert,
 * so two tickets opened in the same second cannot collide and a rolled-back open does
 * not consume a number.
 */
export interface TicketRepository {
  /** Allocates the next per-guild number and inserts the ticket. */
  create(draft: TicketDraft): Promise<TicketRecord>;
  findById(id: string): Promise<TicketRecord | null>;
  /** The live ticket for a channel, if that channel is still a ticket's home. */
  findByChannel(guildId: string, channelId: string): Promise<TicketRecord | null>;
  /** The most recent tickets a member opened, newest first. */
  findByOpener(guildId: string, openerId: string, limit: number): Promise<TicketRecord[]>;
  list(guildId: string, query?: TicketQuery): Promise<TicketRecord[]>;
  /** @returns false when the ticket was already claimed by someone else. */
  claim(id: string, staffId: string): Promise<boolean>;
  /** @returns false when the ticket was already closed, so a double close is a no-op. */
  close(id: string, staffId: string, reason: string, at: Date): Promise<boolean>;
  /** Reopens a closed ticket onto a (possibly new) channel. @returns false when open. */
  reopen(id: string, channelId: string): Promise<boolean>;
  markDeleted(id: string): Promise<boolean>;
  /** Records the first staff reply. Idempotent: later replies do not move it. */
  recordFirstResponse(id: string, at: Date): Promise<void>;
  incrementMessageCount(id: string, by: number): Promise<void>;
  /** Creates or replaces the transcript for a ticket. */
  saveTranscript(
    input: Omit<TicketTranscriptRecord, "id" | "createdAt">,
  ): Promise<TicketTranscriptRecord>;
  findTranscript(ticketId: string): Promise<TicketTranscriptRecord | null>;
  /** Categories. */
  listCategories(guildId: string): Promise<TicketCategoryRecord[]>;
  findCategory(guildId: string, key: string): Promise<TicketCategoryRecord | null>;
  upsertCategory(draft: TicketCategoryDraft): Promise<TicketCategoryRecord>;
  deleteCategory(guildId: string, key: string): Promise<boolean>;
}

/** Outcome of one Discord channel mutation. */
export interface TicketActionResult {
  readonly ok: boolean;
  /** Set when `ok` is false: a short, user-safe reason. */
  readonly detail?: string;
}
