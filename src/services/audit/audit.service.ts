/**
 * Structured audit trail.
 *
 * Reuses the existing logging architecture rather than replacing it: every event
 * is written to the structured `Logger` *and*, when the database is reachable, to
 * the `audit_events` table so "who changed what, when, in which guild" survives a
 * log rotation.
 *
 * Guarantees:
 * - guild-scoped: `guildId` is always explicit, and `null` means "not guild-bound";
 * - best-effort: a failed insert is logged and swallowed. Auditing must never be
 *   able to break, or roll back, the action it was recording;
 * - secret-free: `before`/`after` carry configuration values only, and the logger
 *   applies its own redaction pass on top.
 */
import type { PrismaDatabaseClient } from "../database/index.js";
import { toNullableJson } from "../database/index.js";
import type { Logger } from "../logger/index.js";

/** Severity of an audited action. */
export type AuditSeverity = "info" | "warn" | "privileged";

/** Who triggered the action. */
export type AuditActorKind = "user" | "system" | "god";

/** Outcome of the audited action. */
export type AuditOutcome = "success" | "failure" | "denied";

/** One audit event, as supplied by a service. */
export interface AuditEventInput {
  readonly guildId?: string | null;
  /** Stable action identifier, e.g. `setup.run`, `config.update`. */
  readonly action: string;
  /** Emitting subsystem: `config`, `authorization`, `setup`, `diagnostics`. */
  readonly category: string;
  readonly severity?: AuditSeverity;
  readonly actorId?: string | null;
  readonly actorKind?: AuditActorKind;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly outcome?: AuditOutcome;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly details?: unknown;
}

/** A persisted audit event. */
export interface AuditEventRecord extends Required<
  Omit<AuditEventInput, "before" | "after" | "details">
> {
  readonly before: unknown;
  readonly after: unknown;
  readonly details: unknown;
  readonly createdAt: Date;
}

/** Persistence port, so the service is testable without PostgreSQL. */
export interface AuditEventRepository {
  append(event: AuditEventRecord): Promise<void>;
  list(guildId: string, limit: number): Promise<AuditEventRecord[]>;
}

export class AuditEventService {
  private readonly logger: Logger;
  private readonly repository: AuditEventRepository | undefined;

  public constructor(logger: Logger, repository?: AuditEventRepository) {
    this.logger = logger.child("audit");
    this.repository = repository;
  }

  /**
   * Records an audit event.
   *
   * Never throws: an audit failure is reported through the logger so the operator
   * still learns about it, while the caller's work is unaffected.
   */
  public async record(event: AuditEventInput): Promise<void> {
    const record = normalize(event);

    const metadata: Record<string, unknown> = {
      action: record.action,
      category: record.category,
      actorId: record.actorId,
      actorKind: record.actorKind,
      targetType: record.targetType,
      targetId: record.targetId,
      outcome: record.outcome,
    };
    if (record.guildId !== null) {
      metadata["guildId"] = record.guildId;
    }

    // Privileged (God Access) actions and failures are logged louder so they stand
    // out in an operator's log stream.
    if (record.severity === "privileged" || record.outcome !== "success") {
      this.logger.warn(`Audit: ${record.action}`, metadata);
    } else {
      this.logger.info(`Audit: ${record.action}`, metadata);
    }

    if (!this.repository) {
      return;
    }

    try {
      await this.repository.append(record);
    } catch (error) {
      this.logger.warn("Failed to persist an audit event", {
        action: record.action,
        error: String(error),
      });
    }
  }

  /** @returns the most recent audit events of a guild, newest first. */
  public async list(guildId: string, limit = 25): Promise<AuditEventRecord[]> {
    if (!this.repository) {
      return [];
    }
    try {
      return await this.repository.list(guildId, limit);
    } catch (error) {
      this.logger.warn("Failed to read audit events", { guildId, error: String(error) });
      return [];
    }
  }
}

/** Applies defaults so every persisted row has the same shape. */
function normalize(event: AuditEventInput): AuditEventRecord {
  return {
    guildId: event.guildId ?? null,
    action: event.action,
    category: event.category,
    severity: event.severity ?? "info",
    actorId: event.actorId ?? null,
    actorKind: event.actorKind ?? "system",
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    outcome: event.outcome ?? "success",
    before: event.before ?? null,
    after: event.after ?? null,
    details: event.details ?? null,
    createdAt: new Date(),
  };
}

/** Prisma-backed audit repository. */
export class PrismaAuditEventRepository implements AuditEventRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async append(event: AuditEventRecord): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        guildId: event.guildId,
        action: event.action,
        category: event.category,
        severity: event.severity,
        actorId: event.actorId,
        actorKind: event.actorKind,
        targetType: event.targetType,
        targetId: event.targetId,
        outcome: event.outcome,
        before: toNullableJson(event.before),
        after: toNullableJson(event.after),
        details: toNullableJson(event.details),
      },
    });
  }

  public async list(guildId: string, limit: number): Promise<AuditEventRecord[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      guildId: row.guildId,
      action: row.action,
      category: row.category,
      severity: row.severity as AuditEventRecord["severity"],
      actorId: row.actorId,
      actorKind: row.actorKind as AuditEventRecord["actorKind"],
      targetType: row.targetType,
      targetId: row.targetId,
      outcome: row.outcome as AuditEventRecord["outcome"],
      before: row.before,
      after: row.after,
      details: row.details,
      createdAt: row.createdAt,
    }));
  }
}
