/**
 * Prisma-backed storage for AI guild memory.
 *
 * The one invariant worth pinning is the upsert: a note under (guild, kind, key)
 * is replaced in place, never stacked, so "remember" is idempotent and there is
 * exactly one value to recall. Keying on the guild keeps every read/write scoped,
 * so memory can never leak between servers even if a key collides across them.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError } from "../../services/database/index.js";
import type {
  AiGuildMemoryKind,
  AiGuildMemoryRecord,
  AiGuildMemoryRepository,
} from "./ai-memory.types.js";

export class PrismaAiGuildMemoryRepository implements AiGuildMemoryRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async upsert(draft: {
    guildId: string;
    kind: AiGuildMemoryKind;
    key: string;
    content: string;
  }): Promise<AiGuildMemoryRecord> {
    try {
      const row = await this.prisma.aiGuildMemory.upsert({
        where: { guildId_kind_key: { guildId: draft.guildId, kind: draft.kind, key: draft.key } },
        create: {
          guildId: draft.guildId,
          kind: draft.kind,
          key: draft.key,
          content: draft.content,
        },
        update: { content: draft.content },
      });
      return toRecord(row);
    } catch (error) {
      throw toDatabaseError(error, "aiMemory.upsert");
    }
  }

  public async find(
    guildId: string,
    kind: AiGuildMemoryKind,
    key: string,
  ): Promise<AiGuildMemoryRecord | null> {
    try {
      const row = await this.prisma.aiGuildMemory.findUnique({
        where: { guildId_kind_key: { guildId, kind, key } },
      });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "aiMemory.find");
    }
  }

  public async list(guildId: string, limit: number): Promise<AiGuildMemoryRecord[]> {
    try {
      const rows = await this.prisma.aiGuildMemory.findMany({
        where: { guildId },
        orderBy: { updatedAt: "desc" },
        take: limit,
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "aiMemory.list");
    }
  }

  public async remove(
    guildId: string,
    kind: AiGuildMemoryKind,
    key: string,
  ): Promise<boolean> {
    try {
      const result = await this.prisma.aiGuildMemory.deleteMany({
        where: { guildId, kind, key },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "aiMemory.remove");
    }
  }

  public async count(guildId: string): Promise<number> {
    try {
      return await this.prisma.aiGuildMemory.count({ where: { guildId } });
    } catch (error) {
      throw toDatabaseError(error, "aiMemory.count");
    }
  }
}

/** Maps a Prisma row to the domain record (the `kind` is already a `String`). */
function toRecord(row: {
  id: string;
  guildId: string;
  kind: string;
  key: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}): AiGuildMemoryRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind as AiGuildMemoryKind,
    key: row.key,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
