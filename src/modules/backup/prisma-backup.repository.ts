/**
 * Prisma-backed snapshot storage.
 *
 * Every query starts from `guildId`, and `find` requires it: a snapshot ID alone is
 * never enough to address a row, so a leaked ID from one guild cannot read another
 * guild's snapshot. That is the storage half of the "backups are isolated per
 * server, never shared between guilds" requirement; the service enforces the other
 * half by comparing the payload's embedded `guildId`.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError, toJson } from "../../services/database/index.js";
import type {
  BackupPayload,
  BackupRecord,
  BackupRepository,
  BackupSummary,
} from "./backup.types.js";

export class PrismaBackupRepository implements BackupRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async append(record: {
    readonly guildId: string;
    readonly kind: "manual" | "scheduled";
    readonly status: "complete" | "partial";
    readonly payload: BackupPayload;
    readonly checksum: string;
    readonly createdBy: string;
  }): Promise<BackupSummary> {
    try {
      // Round-tripped through JSON so Prisma stores exactly what a reader will
      // parse back, rather than a class instance with a prototype it drops.
      // `toJson` is the repository layer's single JSON boundary, so the cast lives
      // there instead of here.
      const row = await this.prisma.backupSnapshot.create({
        data: {
          guildId: record.guildId,
          kind: record.kind,
          status: record.status,
          payload: toJson(JSON.parse(JSON.stringify(record.payload))),
          roleCount: record.payload.roles.length,
          channelCount: record.payload.channels.length,
          checksum: record.checksum,
          createdBy: record.createdBy,
        },
      });
      return toSummary(row);
    } catch (error) {
      throw toDatabaseError(error, "backup.append");
    }
  }

  public async list(guildId: string, limit: number): Promise<BackupSummary[]> {
    try {
      const rows = await this.prisma.backupSnapshot.findMany({
        where: { guildId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map(toSummary);
    } catch (error) {
      throw toDatabaseError(error, "backup.list");
    }
  }

  public async find(guildId: string, backupId: string): Promise<BackupRecord | null> {
    try {
      const row = await this.prisma.backupSnapshot.findFirst({
        where: { id: backupId, guildId },
      });
      return row ? { ...toSummary(row), payload: asPayload(row.payload) } : null;
    } catch (error) {
      throw toDatabaseError(error, "backup.find");
    }
  }

  public async latest(guildId: string): Promise<BackupRecord | null> {
    try {
      const row = await this.prisma.backupSnapshot.findFirst({
        where: { guildId },
        orderBy: { createdAt: "desc" },
      });
      return row ? { ...toSummary(row), payload: asPayload(row.payload) } : null;
    } catch (error) {
      throw toDatabaseError(error, "backup.latest");
    }
  }

  public async delete(guildId: string, backupId: string): Promise<boolean> {
    try {
      const result = await this.prisma.backupSnapshot.deleteMany({
        where: { id: backupId, guildId },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "backup.delete");
    }
  }

  public async prune(guildId: string, keep: number): Promise<number> {
    try {
      const rows = await this.prisma.backupSnapshot.findMany({
        where: { guildId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const stale = rows.slice(keep).map((row) => row.id);
      if (stale.length === 0) {
        return 0;
      }
      const result = await this.prisma.backupSnapshot.deleteMany({
        where: { guildId, id: { in: stale } },
      });
      return result.count;
    } catch (error) {
      throw toDatabaseError(error, "backup.prune");
    }
  }
}

/** Maps a Prisma row onto the summary type. */
function toSummary(row: {
  id: string;
  guildId: string;
  kind: string;
  status: string;
  roleCount: number;
  channelCount: number;
  checksum: string | null;
  createdBy: string;
  createdAt: Date;
}): BackupSummary {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind === "scheduled" ? "scheduled" : "manual",
    status: row.status === "partial" ? "partial" : "complete",
    roleCount: row.roleCount,
    channelCount: row.channelCount,
    checksum: row.checksum,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** @returns the payload when it is shaped like one, otherwise `null`. */
function asPayload(value: unknown): BackupPayload | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<BackupPayload>;
  if (
    candidate.version !== 1 ||
    typeof candidate.guildId !== "string" ||
    !Array.isArray(candidate.roles) ||
    !Array.isArray(candidate.channels)
  ) {
    return null;
  }
  return candidate as BackupPayload;
}
