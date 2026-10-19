/**
 * Persistence port and Prisma implementation for moderation cases.
 *
 * Split from the service for the same reason the configuration layer splits
 * service from repository: the rules (thresholds, hierarchy, reversibility) are
 * business logic worth testing without PostgreSQL, and Prisma stays an
 * implementation detail of one file.
 *
 * Case numbering is the delicate part. `append` is the *only* way a case number is
 * ever produced, and the increment runs inside the same transaction as the insert:
 *
 *   BEGIN
 *     INSERT INTO guild_moderation_counters (...) VALUES (...) ON CONFLICT DO NOTHING;
 *     UPDATE guild_moderation_counters SET value = value + 1 ... RETURNING value;
 *     INSERT INTO moderation_cases (...);
 *   COMMIT
 *
 * Two moderators banning two members at the same moment therefore get `#41` and
 * `#42`, never `#41` twice, and the row lock is scoped to one guild: an action in
 * server A never waits on one in server B. `MAX(caseNumber) + 1` was rejected
 * precisely because it hands the same number to both callers and turns the second
 * action into a failed ban.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError, toNullableJson } from "../../services/database/index.js";
import type { ModerationAction } from "./moderation-actions.js";
import type { ModerationActor, ModerationTarget } from "./moderation.types.js";

/** Member state captured around an action, stored as JSON on the case. */
export interface ModerationTargetState {
  /** Role IDs held before/after the action. */
  readonly roleIds: readonly string[];
  /** Timeout expiry before/after the action, ISO-8601 or `null`. */
  readonly timedOutUntil: string | null;
  /** Mute-role presence before/after the action. */
  readonly muted: boolean;
  /**
   * Quarantine-role presence before/after the action.
   *
   * Optional so a case written before V5 still parses: the field is additive, and
   * a reader must not treat "absent" as "false" for old rows.
   */
  readonly quarantined?: boolean;
  /** Ban flag before/after the action; known from the API call itself. */
  readonly banned: boolean;
  /** Display handle, so history stays readable after a rename or a leave. */
  readonly tag: string | null;
}

/** A stored moderation case. */
export interface ModerationCaseRecord {
  readonly id: string;
  readonly guildId: string;
  readonly caseNumber: number;
  readonly action: ModerationAction;
  readonly targetId: string | null;
  readonly targetType: string;
  readonly moderatorId: string;
  readonly moderatorKind: ModerationActor["kind"];
  readonly reason: string | null;
  readonly durationMs: number | null;
  readonly expiresAt: Date | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly details: unknown;
  readonly relatedCaseNumber: number | null;
  readonly createdAt: Date;
}

/** Everything needed to append a case, minus its number (assigned on append). */
export interface ModerationCaseDraft {
  readonly guildId: string;
  readonly action: ModerationAction;
  readonly actor: ModerationActor;
  readonly target: ModerationTarget;
  readonly reason: string | null;
  readonly durationMs: number | null;
  readonly expiresAt: Date | null;
  readonly before: ModerationTargetState | null;
  readonly after: ModerationTargetState | null;
  readonly details: Record<string, unknown>;
  readonly relatedCaseNumber: number | null;
}

/** Filters accepted by `list`/`count`/`listNumbers`. All guild-scoped. */
export interface ModerationCaseQuery {
  readonly targetId?: string | null;
  readonly action?: ModerationAction | null;
  readonly limit?: number;
  /** Only cases created strictly after this instant. */
  readonly since?: Date | null;
}

/**
 * Why and when the sweeper retired an expired case it can never reverse.
 *
 * Stored on the case itself (`details.sweep`) so the decision survives a restart
 * and stays visible in `/history`, rather than being re-derived — and re-logged —
 * on every single sweep.
 */
export interface SweepResolution {
  /** Human-readable reason, e.g. `the member is no longer in this server`. */
  readonly reason: string;
  /** The deadline that was abandoned, kept because the column is cleared. */
  readonly expiresAt: Date | null;
}

export interface ModerationCaseRepository {
  /** Appends a case and returns it with its freshly assigned number. */
  append(draft: ModerationCaseDraft): Promise<ModerationCaseRecord>;
  list(guildId: string, query?: ModerationCaseQuery): Promise<ModerationCaseRecord[]>;
  count(guildId: string, query?: ModerationCaseQuery): Promise<number>;
  /** Case numbers matching a query, oldest first (used to pick an `unwarn`). */
  listNumbers(guildId: string, query: ModerationCaseQuery): Promise<number[]>;
  /**
   * @returns temporary punishments whose `expiresAt` has passed and that no
   * `unmute`/`untimeout`/`unban` case has already reversed, oldest deadline first.
   *
   * Not guild-scoped: this is the recovery path, called by the sweeper for the
   * whole process, and it must see every guild.
   */
  listExpired(now: Date, limit: number): Promise<ModerationCaseRecord[]>;

  /**
   * Retires an expired case the sweeper can never reverse, so it stops being a
   * candidate for every future sweep.
   *
   * `expiresAt` is cleared because *that* is the sweeper's predicate: a value there
   * means "this punishment is still waiting for its deadline". A deadline nobody can
   * ever act on would otherwise be examined, failed and logged on every sweep, for
   * the lifetime of the bot — one member who left is enough to make a bot that has
   * nothing to do touch the database and the log file every minute, forever.
   *
   * Nothing is lost by clearing it: the deadline is still derivable from
   * `createdAt + durationMs`, and this method stores it in `details.sweep` along
   * with the reason, so the case keeps reading as what happened.
   */
  closeUnliftable(id: string, resolution: SweepResolution): Promise<void>;
}

export class PrismaModerationCaseRepository implements ModerationCaseRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async append(draft: ModerationCaseDraft): Promise<ModerationCaseRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const client = tx as unknown as PrismaDatabaseClient;

        // The counter row is created on first use, so a guild that never
        // moderates anything has no counter row at all.
        await client.$executeRaw`
          INSERT INTO guild_moderation_counters ("id", "guildId", "value", "updatedAt")
          VALUES (${`counter:${draft.guildId}`}, ${draft.guildId}, 0, now())
          ON CONFLICT ("guildId") DO NOTHING
        `;

        const incremented = await client.$queryRaw<{ value: number }[]>`
          UPDATE guild_moderation_counters
             SET "value" = "value" + 1, "updatedAt" = now()
           WHERE "guildId" = ${draft.guildId}
          RETURNING "value"
        `;

        const caseNumber = incremented[0]?.value;
        if (typeof caseNumber !== "number") {
          throw new Error("Moderation case counter did not return a value");
        }

        const row = await client.moderationCase.create({
          data: {
            guildId: draft.guildId,
            caseNumber,
            action: draft.action,
            targetId: draft.target.id,
            targetType: draft.target.type === "member" ? "member" : "channel",
            moderatorId: draft.actor.id,
            moderatorKind: draft.actor.kind,
            reason: draft.reason,
            durationMs: draft.durationMs,
            expiresAt: draft.expiresAt,
            before: toNullableJson(draft.before),
            after: toNullableJson(draft.after),
            details: toNullableJson(draft.details),
            relatedCaseNumber: draft.relatedCaseNumber,
          },
        });

        return toRecord(row);
      });
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.append");
    }
  }

  public async list(
    guildId: string,
    query: ModerationCaseQuery = {},
  ): Promise<ModerationCaseRecord[]> {
    try {
      const rows = await this.prisma.moderationCase.findMany({
        where: whereFor(guildId, query),
        orderBy: { createdAt: "desc" },
        take: query.limit ?? 25,
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.list");
    }
  }

  public async count(guildId: string, query: ModerationCaseQuery = {}): Promise<number> {
    try {
      return await this.prisma.moderationCase.count({ where: whereFor(guildId, query) });
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.count");
    }
  }

  public async listNumbers(guildId: string, query: ModerationCaseQuery): Promise<number[]> {
    try {
      const rows = await this.prisma.moderationCase.findMany({
        where: whereFor(guildId, query),
        orderBy: { caseNumber: "asc" },
        select: { caseNumber: true },
        take: query.limit ?? 100,
      });
      return rows.map((row) => row.caseNumber);
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.listNumbers");
    }
  }

  public async listExpired(now: Date, limit: number): Promise<ModerationCaseRecord[]> {
    try {
      const rows = await this.prisma.moderationCase.findMany({
        where: {
          // Only actions that carry a deadline can expire. `unwarn`/`unmute` never
          // have one, and a `warn` does not, so the predicate is exact rather than
          // "anything with an expiresAt".
          action: { in: ["mute", "timeout", "ban"] },
          expiresAt: { lte: now, not: null },
        },
        orderBy: { expiresAt: "asc" },
        take: limit,
      });

      // A case whose punishment was already lifted by hand must not be swept again:
      // the reversal is itself a case (`unmute`/`untimeout`/`unban`), so the filter
      // is applied here rather than at the call site, where it would be easy to
      // forget. Without it the sweeper would "lift" an already-lifted mute forever.
      const lifted = await this.liftedCaseNumbers(rows.map((row) => row.caseNumber));
      return rows.filter((row) => !lifted.has(row.caseNumber)).map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.listExpired");
    }
  }

  public async closeUnliftable(id: string, resolution: SweepResolution): Promise<void> {
    try {
      // Read-merge-write rather than a JSON patch: the case's `details` already carry
      // action-specific extras (`source`, `count`, ...), and this must add to them
      // instead of replacing them.
      const row = await this.prisma.moderationCase.findUnique({
        where: { id },
        select: { details: true },
      });
      const previous = row?.details;
      const details: Record<string, unknown> =
        typeof previous === "object" && previous !== null && !Array.isArray(previous)
          ? { ...(previous as Record<string, unknown>) }
          : {};
      details.sweep = {
        resolvedAt: new Date().toISOString(),
        reason: resolution.reason,
        // Kept because the column itself is cleared below: the case must still say
        // when it was *supposed* to end.
        expiresAt: resolution.expiresAt?.toISOString() ?? null,
      };

      // `updateMany`, not `update`: a case deleted in the meantime is not a failure.
      // The goal — it never gets swept again — is already met.
      await this.prisma.moderationCase.updateMany({
        where: { id },
        data: { expiresAt: null, details: toNullableJson(details) },
      });
    } catch (error) {
      throw toDatabaseError(error, "moderationCase.closeUnliftable");
    }
  }

  /**
   * @returns the case numbers that a reversal case already points at.
   *
   * `relatedCaseNumber` is what a reversal records, so one query answers it for
   * every candidate instead of one query per row.
   */
  private async liftedCaseNumbers(caseNumbers: readonly number[]): Promise<Set<number>> {
    if (caseNumbers.length === 0) {
      return new Set();
    }
    const reversals = await this.prisma.moderationCase.findMany({
      where: {
        action: { in: ["unmute", "untimeout", "unban"] },
        relatedCaseNumber: { in: [...caseNumbers] },
      },
      select: { relatedCaseNumber: true },
    });
    return new Set(
      reversals
        .map((row) => row.relatedCaseNumber)
        .filter((value): value is number => value !== null),
    );
  }
}

/** Builds the Prisma filter, always starting from the guild scope. */
function whereFor(guildId: string, query: ModerationCaseQuery) {
  return {
    guildId,
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.since ? { createdAt: { gt: query.since } } : {}),
  };
}

/** Maps a Prisma row onto the module's record type. */
function toRecord(row: {
  id: string;
  guildId: string;
  caseNumber: number;
  action: string;
  targetId: string | null;
  targetType: string;
  moderatorId: string;
  moderatorKind: string;
  reason: string | null;
  durationMs: number | null;
  expiresAt: Date | null;
  before: unknown;
  after: unknown;
  details: unknown;
  relatedCaseNumber: number | null;
  createdAt: Date;
}): ModerationCaseRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    caseNumber: row.caseNumber,
    action: row.action as ModerationAction,
    targetId: row.targetId,
    targetType: row.targetType,
    moderatorId: row.moderatorId,
    moderatorKind: row.moderatorKind as ModerationActor["kind"],
    reason: row.reason,
    durationMs: row.durationMs,
    expiresAt: row.expiresAt,
    before: row.before,
    after: row.after,
    details: row.details,
    relatedCaseNumber: row.relatedCaseNumber,
    createdAt: row.createdAt,
  };
}
