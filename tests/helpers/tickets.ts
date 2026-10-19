/**
 * In-memory collaborators for the V6 ticket module tests.
 *
 * The fakes replace external systems only: `TicketService`, the transcript renderer and
 * the panel builder are the production ones.
 *
 * Two behaviours are modelled deliberately, because the module's correctness rests on
 * them and a fake that glossed over either would let a real bug through:
 *
 * - **The transition guards are compare-and-swaps.** `close` only succeeds for an `open`
 *   ticket and flips the status before returning, and `claim` only succeeds when nobody
 *   holds it. That is what the real `updateMany({ where: { status: "open" } })` does, and
 *   it is what makes "a double close is reported as closed exactly once" testable rather
 *   than merely asserted.
 * - **`create` allocates a gap-free per-guild number**, mirroring the repository's locked
 *   `MAX(number) + 1`. A fake with a global counter would hide a numbering bug that only
 *   appears across two guilds.
 */
import type {
  GuildTicketActions,
  TicketCategoryDraft,
  TicketCategoryRecord,
  TicketDraft,
  TicketQuery,
  TicketRecord,
  TicketRepository,
  TicketTranscriptRecord,
  TranscriptMessageInput,
} from "../../src/modules/tickets/index.js";

/** The in-memory ticket store, exposing internals for assertions. */
export interface MemoryTickets extends TicketRepository {
  /** Every ticket row, in creation order. */
  readonly rows: TicketRecord[];
  /** Every transcript row, in creation order. */
  readonly transcripts: TicketTranscriptRecord[];
  /** Test-only: makes the next `create` throw, to exercise the channel rollback. */
  failNextCreate(): void;
  /** Test-only: makes the next `saveTranscript` throw. */
  failNextTranscript(): void;
}

/** Builds an isolated in-memory ticket repository. One per test. */
export function memoryTickets(
  initialCategories: readonly TicketCategoryDraft[] = [],
): MemoryTickets {
  const rows: TicketRecord[] = [];
  const transcripts: TicketTranscriptRecord[] = [];
  const categories: TicketCategoryRecord[] = [];
  let counter = 0;
  let failedCreate = false;
  let failedTranscript = false;

  const find = (id: string): TicketRecord | undefined => rows.find((row) => row.id === id);

  for (const [index, draft] of initialCategories.entries()) {
    counter += 1;
    categories.push({
      id: `category-${counter}`,
      guildId: draft.guildId,
      key: draft.key,
      label: draft.label,
      emoji: draft.emoji ?? null,
      description: draft.description ?? null,
      parentId: draft.parentId ?? null,
      staffRoleIds: [...(draft.staffRoleIds ?? [])],
      pingRoleIds: [...(draft.pingRoleIds ?? [])],
      prompt: draft.prompt ?? null,
      enabled: draft.enabled ?? true,
      position: draft.position ?? index,
    });
  }

  return {
    rows,
    transcripts,

    failNextCreate() {
      failedCreate = true;
    },

    failNextTranscript() {
      failedTranscript = true;
    },

    async create(draft: TicketDraft): Promise<TicketRecord> {
      if (failedCreate) {
        failedCreate = false;
        throw new Error("database unavailable");
      }
      // Gap-free per guild, which is the property the real advisory lock buys.
      const siblings = rows.filter((row) => row.guildId === draft.guildId);
      const number = siblings.reduce((highest, row) => Math.max(highest, row.number), 0) + 1;
      counter += 1;
      const row: TicketRecord = {
        id: `ticket-${counter}`,
        guildId: draft.guildId,
        number,
        categoryId: draft.categoryId,
        channelId: draft.channelId,
        openerId: draft.openerId,
        claimedById: null,
        status: "open",
        priority: draft.priority ?? "normal",
        subject: draft.subject ?? null,
        firstResponseAt: null,
        closedAt: null,
        closedById: null,
        closeReason: null,
        messageCount: 0,
        createdAt: new Date(0),
      };
      rows.push(row);
      return row;
    },

    async findById(id) {
      return find(id) ?? null;
    },

    async findByChannel(guildId, channelId) {
      return (
        rows.find(
          (row) => row.guildId === guildId && row.channelId === channelId && row.status === "open",
        ) ?? null
      );
    },

    async findByOpener(guildId, openerId, limit) {
      return rows
        .filter((row) => row.guildId === guildId && row.openerId === openerId)
        .sort((a, b) => b.number - a.number)
        .slice(0, limit);
    },

    async list(guildId, query: TicketQuery = {}) {
      return rows
        .filter(
          (row) =>
            row.guildId === guildId &&
            (query.status === undefined || query.status === null || row.status === query.status) &&
            (query.categoryId === undefined ||
              query.categoryId === null ||
              row.categoryId === query.categoryId) &&
            (query.openerId === undefined ||
              query.openerId === null ||
              row.openerId === query.openerId) &&
            (query.claimedById === undefined ||
              query.claimedById === null ||
              row.claimedById === query.claimedById),
        )
        .sort((a, b) => b.number - a.number)
        .slice(0, query.limit ?? 25);
    },

    async claim(id, staffId) {
      const row = find(id);
      if (!row || row.status !== "open" || row.claimedById !== null) {
        return false;
      }
      row.claimedById = staffId;
      return true;
    },

    async close(id, staffId, reason, at) {
      const row = find(id);
      if (!row || row.status !== "open") {
        return false;
      }
      row.status = "closed";
      row.closedAt = at;
      row.closedById = staffId;
      row.closeReason = reason;
      return true;
    },

    async reopen(id, channelId) {
      const row = find(id);
      if (!row || row.status !== "closed") {
        return false;
      }
      row.status = "open";
      row.channelId = channelId;
      row.closedAt = null;
      row.closedById = null;
      row.closeReason = null;
      return true;
    },

    async markDeleted(id) {
      const row = find(id);
      if (!row) {
        return false;
      }
      row.status = "deleted";
      return true;
    },

    async recordFirstResponse(id, at) {
      const row = find(id);
      if (row && row.firstResponseAt === null) {
        row.firstResponseAt = at;
      }
    },

    async incrementMessageCount(id, by) {
      const row = find(id);
      if (row) {
        row.messageCount += by;
      }
    },

    async saveTranscript(input) {
      if (failedTranscript) {
        failedTranscript = false;
        throw new Error("database unavailable");
      }
      const existing = transcripts.find((row) => row.ticketId === input.ticketId);
      if (existing) {
        // Replaced, not accumulated: "the transcript" must be a single unambiguously
        // current row, exactly as the real upsert on `ticketId` guarantees.
        existing.content = input.content;
        existing.format = input.format;
        existing.messageCount = input.messageCount;
        existing.checksum = input.checksum;
        return existing;
      }
      counter += 1;
      const row: TicketTranscriptRecord = {
        id: `transcript-${counter}`,
        ...input,
        createdAt: new Date(0),
      };
      transcripts.push(row);
      return row;
    },

    async findTranscript(ticketId) {
      return transcripts.find((row) => row.ticketId === ticketId) ?? null;
    },

    async listCategories(guildId) {
      return categories
        .filter((category) => category.guildId === guildId)
        .sort((a, b) => a.position - b.position);
    },

    async findCategory(guildId, key) {
      return (
        categories.find((category) => category.guildId === guildId && category.key === key) ?? null
      );
    },

    async upsertCategory(draft) {
      const existing = categories.find(
        (category) => category.guildId === draft.guildId && category.key === draft.key,
      );
      if (existing) {
        existing.label = draft.label;
        return existing;
      }
      counter += 1;
      const row: TicketCategoryRecord = {
        id: `category-${counter}`,
        guildId: draft.guildId,
        key: draft.key,
        label: draft.label,
        emoji: draft.emoji ?? null,
        description: draft.description ?? null,
        parentId: draft.parentId ?? null,
        staffRoleIds: [...(draft.staffRoleIds ?? [])],
        pingRoleIds: [...(draft.pingRoleIds ?? [])],
        prompt: draft.prompt ?? null,
        enabled: draft.enabled ?? true,
        position: draft.position ?? 0,
      };
      categories.push(row);
      return row;
    },

    async deleteCategory(guildId, key) {
      const index = categories.findIndex(
        (category) => category.guildId === guildId && category.key === key,
      );
      if (index === -1) {
        return false;
      }
      categories.splice(index, 1);
      return true;
    },
  };
}

/** The fake Discord port, exposing call history and failure injection. */
export interface FakeTicketActions extends GuildTicketActions {
  /** Every `createChannel` call, in order. */
  readonly createCalls: {
    name: string;
    parentId: string | null;
    openerId: string;
    staffRoleIds: readonly string[];
    topic: string;
  }[];
  /** Channels deleted, in order. */
  readonly deleted: string[];
  /** Channels archived (locked), in order. */
  readonly archived: string[];
  /** Renames issued, in order. */
  readonly renames: { channelId: string; name: string }[];
  /** Messages sent, in order. */
  readonly sent: {
    channelId: string;
    content: string | undefined;
    componentCount: number;
  }[];
  /** Test-only: makes the next `createChannel` fail. */
  failNextCreate(detail: string): void;
  /** Test-only: makes `fetchHistory` report the channel as gone. */
  hideHistory(channelId: string): void;
  /** Test-only: replaces the messages `fetchHistory` returns for a channel. */
  setHistory(channelId: string, messages: readonly TranscriptMessageInput[]): void;
  /** Test-only: the channels that currently exist. */
  channels(): readonly string[];
}

/**
 * Builds a fake Discord port.
 *
 * Channel ids are deterministic (`channel-1`, ...) so a test can assert on the channel a
 * ticket ended up in without reading it back from the service.
 */
export function fakeTicketActions(): FakeTicketActions {
  const createCalls: FakeTicketActions["createCalls"] = [];
  const deleted: string[] = [];
  const archived: string[] = [];
  const renames: { channelId: string; name: string }[] = [];
  const sent: { channelId: string; content: string | undefined; componentCount: number }[] = [];
  const live = new Set<string>();
  const history = new Map<string, readonly TranscriptMessageInput[]>();
  const hidden = new Set<string>();
  let nextCreateFailure: string | null = null;
  let counter = 0;

  return {
    createCalls,
    deleted,
    archived,
    renames,
    sent,

    failNextCreate(detail) {
      nextCreateFailure = detail;
    },

    hideHistory(channelId) {
      hidden.add(channelId);
    },

    setHistory(channelId, messages) {
      history.set(channelId, messages);
    },

    channels() {
      return [...live];
    },

    async createChannel(input) {
      createCalls.push({ ...input, staffRoleIds: [...input.staffRoleIds] });
      if (nextCreateFailure !== null) {
        const detail = nextCreateFailure;
        nextCreateFailure = null;
        return { ok: false, detail };
      }
      counter += 1;
      const channelId = `channel-${counter}`;
      live.add(channelId);
      return { ok: true, channelId };
    },

    async sendMessage(channelId, content) {
      if (!live.has(channelId)) {
        return { ok: false, detail: "that channel is gone" };
      }
      sent.push({
        channelId,
        content: content.content,
        componentCount: content.components?.length ?? 0,
      });
      return { ok: true, messageId: `message-${sent.length}` };
    },

    async renameChannel(channelId, name) {
      if (!live.has(channelId)) {
        return { ok: false, detail: "that channel is gone" };
      }
      renames.push({ channelId, name });
      return { ok: true };
    },

    async archiveChannel(channelId) {
      if (!live.has(channelId)) {
        // Mirrors the adapter: already gone is the goal state, so it is a success.
        return { ok: true };
      }
      archived.push(channelId);
      return { ok: true };
    },

    async deleteChannel(channelId) {
      deleted.push(channelId);
      live.delete(channelId);
      return { ok: true };
    },

    async fetchHistory(channelId) {
      if (hidden.has(channelId) || !live.has(channelId)) {
        return { ok: false, detail: "that channel is gone" };
      }
      return { ok: true, messages: history.get(channelId) ?? [] };
    },
  };
}

/** One transcript message, for brevity in tests. */
export function message(
  authorName: string,
  content: string,
  options: { authorId?: string; bot?: boolean; attachments?: readonly string[] } = {},
): TranscriptMessageInput {
  return {
    authorId: options.authorId ?? `id-${authorName}`,
    authorName,
    authorIsBot: options.bot ?? false,
    content,
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    ...(options.attachments ? { attachments: options.attachments } : {}),
  };
}
