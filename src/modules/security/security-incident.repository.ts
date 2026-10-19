/**
 * Persistence for security incidents.
 *
 * An incident is stored rather than kept in memory for one reason: a lockdown that
 * only lives in RAM is lifted by every restart, and a raid does not care about
 * deployments. `expiresAt` is what makes the recovery automatic, and it has to
 * survive the process that started it.
 *
 * One incident per `(guild, kind)` is *active* at a time: the second join of the
 * same raid must extend the existing episode, not open a hundred duplicates that an
 * operator would have to close one by one.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError, toJson } from "../../services/database/index.js";
import type {
  SecurityIncident,
  SecurityIncidentDraft,
  SecurityIncidentKind,
  SecurityIncidentRepository,
} from "./security.types.js";

/** JSON read from the database, normalized to a stable array of strings. */
function asIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export class PrismaSecurityIncidentRepository implements SecurityIncidentRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async open(draft: SecurityIncidentDraft): Promise<SecurityIncident> {
    try {
      // `upsert` on nothing is not possible (there is no unique key on
      // `(guildId, kind, status)`), so the active row is looked up first. The
      // window is small and this path only runs when a raid is already detected.
      const existing = await this.active(draft.guildId, draft.kind);
      if (existing) {
        return this.touch(existing.id, draft);
      }
      const row = await this.prisma.securityIncident.create({
        data: {
          guildId: draft.guildId,
          kind: draft.kind,
          status: "active",
          summary: draft.summary,
          // Round-tripped through JSON, like the backup payload: the column holds
          // JSON, and what a reader parses back must equal what was written.
          // `toJson` is the repository layer's single JSON boundary.
          details: toJson(JSON.parse(JSON.stringify(draft.details))),
          targetedIds: [...draft.targetedIds],
          expiresAt: draft.expiresAt,
        },
      });
      return toRecord(row);
    } catch (error) {
      throw toDatabaseError(error, "securityIncident.open");
    }
  }

  /** Extends an active episode with the latest observations. */
  private async touch(id: string, draft: SecurityIncidentDraft): Promise<SecurityIncident> {
    const row = await this.prisma.securityIncident.update({
      where: { id },
      data: {
        summary: draft.summary,
        details: toJson(JSON.parse(JSON.stringify(draft.details))),
        targetedIds: [...draft.targetedIds],
        expiresAt: draft.expiresAt,
      },
    });
    return toRecord(row);
  }

  public async active(
    guildId: string,
    kind: SecurityIncidentKind,
  ): Promise<SecurityIncident | null> {
    try {
      const row = await this.prisma.securityIncident.findFirst({
        where: { guildId, kind, status: "active" },
        orderBy: { startedAt: "desc" },
      });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "securityIncident.active");
    }
  }

  public async listActive(guildId: string): Promise<SecurityIncident[]> {
    try {
      const rows = await this.prisma.securityIncident.findMany({
        where: { guildId, status: "active" },
        orderBy: { startedAt: "asc" },
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "securityIncident.listActive");
    }
  }

  public async listExpired(now: Date): Promise<SecurityIncident[]> {
    try {
      const rows = await this.prisma.securityIncident.findMany({
        where: { status: "active", expiresAt: { not: null, lte: now } },
        orderBy: { startedAt: "asc" },
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "securityIncident.listExpired");
    }
  }

  public async resolve(id: string, resolvedBy: string): Promise<SecurityIncident | null> {
    try {
      const row = await this.prisma.securityIncident.update({
        where: { id },
        data: { status: "resolved", resolvedAt: new Date(), resolvedBy },
      });
      return toRecord(row);
    } catch {
      // Already resolved (or deleted) is not an error for a recovery sweep.
      return null;
    }
  }
}

/** Maps a Prisma row onto the module's record type. */
function toRecord(row: {
  id: string;
  guildId: string;
  kind: string;
  status: string;
  summary: string;
  details: unknown;
  targetedIds: unknown;
  startedAt: Date;
  expiresAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}): SecurityIncident {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind === "nuke" ? "nuke" : "raid",
    status: row.status === "resolved" ? "resolved" : "active",
    summary: row.summary,
    details: row.details,
    targetedIds: asIdList(row.targetedIds),
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
  };
}
