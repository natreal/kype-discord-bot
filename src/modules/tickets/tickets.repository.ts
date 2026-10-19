/**
 * Prisma-backed storage for tickets, categories and transcripts.
 *
 * The one genuinely delicate operation here is number allocation. `create` runs inside
 * a transaction that takes a per-guild advisory lock and computes `MAX(number) + 1`, so
 * two tickets opened in the same second cannot claim the same number and a rolled-back
 * open does not consume one. A database sequence would be simpler but is global, and a
 * per-guild counter column would need its own locking anyway; the lock makes the
 * invariant ("gap-free per guild") true by construction rather than by convention.
 *
 * The transition methods (`claim`, `close`, `reopen`) are guarded updates, not blind
 * writes: each returns `false` when the row was not in the state the caller assumed, so
 * two staff members closing the same ticket converge on one close instead of both
 * believing they did it.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError } from "../../services/database/index.js";
import type {
  TicketCategoryDraft,
  TicketCategoryRecord,
  TicketDraft,
  TicketPriority,
  TicketQuery,
  TicketRecord,
  TicketRepository,
  TicketStatus,
  TicketTranscriptRecord,
} from "./ticket.types.js";

export class PrismaTicketRepository implements TicketRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async create(draft: TicketDraft): Promise<TicketRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const client = tx as unknown as PrismaDatabaseClient;

        // Held until commit, so the MAX+1 read is atomic with the insert. Keyed on the
        // guild: one server's ticket volume never blocks another's.
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${draft.guildId}))`;

        const highest = await client.ticket.findFirst({
          where: { guildId: draft.guildId },
          orderBy: { number: "desc" },
          select: { number: true },
        });

        const created = await client.ticket.create({
          data: {
            guildId: draft.guildId,
            number: (highest?.number ?? 0) + 1,
            categoryId: draft.categoryId,
            channelId: draft.channelId,
            openerId: draft.openerId,
            status: "open",
            priority: draft.priority ?? "normal",
            subject: draft.subject ?? null,
          },
        });
        return toTicket(created);
      });
    } catch (error) {
      throw toDatabaseError(error, "Failed to create ticket");
    }
  }

  public async findById(id: string): Promise<TicketRecord | null> {
    try {
      const row = await this.prisma.ticket.findUnique({ where: { id } });
      return row ? toTicket(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "Failed to read ticket");
    }
  }

  public async findByChannel(guildId: string, channelId: string): Promise<TicketRecord | null> {
    try {
      // A channel can host exactly one live ticket. A closed one is deliberately not
      // returned: the channel is being wound down, and a stray message in it must not
      // resurrect the record.
      const row = await this.prisma.ticket.findFirst({
        where: { guildId, channelId, status: { in: ["open"] } },
        orderBy: { createdAt: "desc" },
      });
      return row ? toTicket(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "Failed to read ticket by channel");
    }
  }

  public async findByOpener(
    guildId: string,
    openerId: string,
    limit: number,
  ): Promise<TicketRecord[]> {
    try {
      const rows = await this.prisma.ticket.findMany({
        where: { guildId, openerId },
        orderBy: { number: "desc" },
        take: limit,
      });
      return rows.map(toTicket);
    } catch (error) {
      throw toDatabaseError(error, "Failed to list member tickets");
    }
  }

  public async list(guildId: string, query: TicketQuery = {}): Promise<TicketRecord[]> {
    try {
      const rows = await this.prisma.ticket.findMany({
        where: {
          guildId,
          ...(query.status === undefined || query.status === null ? {} : { status: query.status }),
          ...(query.categoryId === undefined || query.categoryId === null
            ? {}
            : { categoryId: query.categoryId }),
          ...(query.openerId === undefined || query.openerId === null
            ? {}
            : { openerId: query.openerId }),
          ...(query.claimedById === undefined || query.claimedById === null
            ? {}
            : { claimedById: query.claimedById }),
        },
        orderBy: { number: "desc" },
        take: query.limit ?? 25,
      });
      return rows.map(toTicket);
    } catch (error) {
      throw toDatabaseError(error, "Failed to list tickets");
    }
  }

  public async claim(id: string, staffId: string): Promise<boolean> {
    try {
      // Guarded on `claimedById: null`: the second staff member to click Claim is told
      // "no" rather than silently overwriting who is handling it.
      const result = await this.prisma.ticket.updateMany({
        where: { id, status: "open", claimedById: null },
        data: { claimedById: staffId },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "Failed to claim ticket");
    }
  }

  public async close(id: string, staffId: string, reason: string, at: Date): Promise<boolean> {
    try {
      const result = await this.prisma.ticket.updateMany({
        where: { id, status: "open" },
        data: {
          status: "closed",
          closedAt: at,
          closedById: staffId,
          closeReason: reason,
        },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "Failed to close ticket");
    }
  }

  public async reopen(id: string, channelId: string): Promise<boolean> {
    try {
      const result = await this.prisma.ticket.updateMany({
        where: { id, status: "closed" },
        data: {
          status: "open",
          channelId,
          // Cleared so the reopened ticket reads as live again; a stale closer would
          // make the panel claim it was closed by someone who is not involved.
          closedAt: null,
          closedById: null,
          closeReason: null,
        },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "Failed to reopen ticket");
    }
  }

  public async markDeleted(id: string): Promise<boolean> {
    try {
      const result = await this.prisma.ticket.updateMany({
        where: { id },
        data: { status: "deleted" },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "Failed to mark ticket deleted");
    }
  }

  public async recordFirstResponse(id: string, at: Date): Promise<void> {
    try {
      // Guarded on `firstResponseAt: null` so the statistic keeps measuring the *first*
      // staff reply, however many follow it.
      await this.prisma.ticket.updateMany({
        where: { id, firstResponseAt: null },
        data: { firstResponseAt: at },
      });
    } catch (error) {
      throw toDatabaseError(error, "Failed to record first response");
    }
  }

  public async incrementMessageCount(id: string, by: number): Promise<void> {
    try {
      await this.prisma.ticket.update({
        where: { id },
        data: { messageCount: { increment: by } },
      });
    } catch (error) {
      throw toDatabaseError(error, "Failed to update ticket message count");
    }
  }

  public async saveTranscript(
    input: Omit<TicketTranscriptRecord, "id" | "createdAt">,
  ): Promise<TicketTranscriptRecord> {
    try {
      // Upserted on `ticketId`, which is unique: re-transcribing a ticket replaces the
      // previous text rather than accumulating copies, so "the transcript" is a single
      // unambiguous row.
      const row = await this.prisma.ticketTranscript.upsert({
        where: { ticketId: input.ticketId },
        create: {
          ticketId: input.ticketId,
          guildId: input.guildId,
          content: input.content,
          format: input.format,
          messageCount: input.messageCount,
          checksum: input.checksum,
        },
        update: {
          content: input.content,
          format: input.format,
          messageCount: input.messageCount,
          checksum: input.checksum,
        },
      });
      return toTranscript(row);
    } catch (error) {
      throw toDatabaseError(error, "Failed to save ticket transcript");
    }
  }

  public async findTranscript(ticketId: string): Promise<TicketTranscriptRecord | null> {
    try {
      const row = await this.prisma.ticketTranscript.findUnique({ where: { ticketId } });
      return row ? toTranscript(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "Failed to read ticket transcript");
    }
  }

  public async listCategories(guildId: string): Promise<TicketCategoryRecord[]> {
    try {
      const rows = await this.prisma.ticketCategory.findMany({
        where: { guildId },
        orderBy: [{ position: "asc" }, { key: "asc" }],
      });
      return rows.map(toCategory);
    } catch (error) {
      throw toDatabaseError(error, "Failed to list ticket categories");
    }
  }

  public async findCategory(guildId: string, key: string): Promise<TicketCategoryRecord | null> {
    try {
      const row = await this.prisma.ticketCategory.findUnique({
        where: { guildId_key: { guildId, key } },
      });
      return row ? toCategory(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "Failed to read ticket category");
    }
  }

  public async upsertCategory(draft: TicketCategoryDraft): Promise<TicketCategoryRecord> {
    try {
      // Keyed on (guildId, key): re-running setup or editing a category in Discord
      // must update the existing row, never create a second button with the same slug.
      const row = await this.prisma.ticketCategory.upsert({
        where: { guildId_key: { guildId: draft.guildId, key: draft.key } },
        create: {
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
        },
        update: {
          label: draft.label,
          ...(draft.emoji === undefined ? {} : { emoji: draft.emoji }),
          ...(draft.description === undefined ? {} : { description: draft.description }),
          ...(draft.parentId === undefined ? {} : { parentId: draft.parentId }),
          ...(draft.staffRoleIds === undefined ? {} : { staffRoleIds: [...draft.staffRoleIds] }),
          ...(draft.pingRoleIds === undefined ? {} : { pingRoleIds: [...draft.pingRoleIds] }),
          ...(draft.prompt === undefined ? {} : { prompt: draft.prompt }),
          ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
          ...(draft.position === undefined ? {} : { position: draft.position }),
        },
      });
      return toCategory(row);
    } catch (error) {
      throw toDatabaseError(error, "Failed to save ticket category");
    }
  }

  public async deleteCategory(guildId: string, key: string): Promise<boolean> {
    try {
      const result = await this.prisma.ticketCategory.deleteMany({ where: { guildId, key } });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "Failed to delete ticket category");
    }
  }
}

/**
 * Maps a Prisma row to the domain record.
 *
 * The cast on each of these is deliberate and narrow: Prisma's generated types are
 * structural and the columns are plain strings (the schema keeps `status` and
 * `priority` as `String` so adding a state does not require a migration). The service
 * is the only writer, so the values it reads back are the ones it wrote; a row edited
 * by hand outside the bot is not defended against here, because it cannot be defended
 * against in the mapper either.
 */
type TicketRow = {
  id: string;
  guildId: string;
  number: number;
  categoryId: string;
  channelId: string;
  openerId: string;
  claimedById: string | null;
  status: string;
  priority: string;
  subject: string | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  closedById: string | null;
  closeReason: string | null;
  messageCount: number;
  createdAt: Date;
};

type TicketCategoryRow = {
  id: string;
  guildId: string;
  key: string;
  label: string;
  emoji: string | null;
  description: string | null;
  parentId: string | null;
  staffRoleIds: string[];
  pingRoleIds: string[];
  prompt: string | null;
  enabled: boolean;
  position: number;
};

type TranscriptRow = {
  id: string;
  ticketId: string;
  guildId: string;
  content: string;
  format: string;
  messageCount: number;
  checksum: string;
  createdAt: Date;
};

function toTicket(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    categoryId: row.categoryId,
    channelId: row.channelId,
    openerId: row.openerId,
    claimedById: row.claimedById,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    subject: row.subject,
    firstResponseAt: row.firstResponseAt,
    closedAt: row.closedAt,
    closedById: row.closedById,
    closeReason: row.closeReason,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
  };
}

function toCategory(row: TicketCategoryRow): TicketCategoryRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    key: row.key,
    label: row.label,
    emoji: row.emoji,
    description: row.description,
    parentId: row.parentId,
    staffRoleIds: [...row.staffRoleIds],
    pingRoleIds: [...row.pingRoleIds],
    prompt: row.prompt,
    enabled: row.enabled,
    position: row.position,
  };
}

function toTranscript(row: TranscriptRow): TicketTranscriptRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    guildId: row.guildId,
    content: row.content,
    format: row.format === "html" ? "html" : "markdown",
    messageCount: row.messageCount,
    checksum: row.checksum,
    createdAt: row.createdAt,
  };
}
