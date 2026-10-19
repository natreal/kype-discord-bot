/**
 * Prisma-backed storage for role grants.
 *
 * This is the `role_grants` table, shared by every V6 role surface: a temporary
 * grant, a self-service menu click, a welcome autorole and an automation rule all
 * write the same row and differ only in `source`. That is why `upsert` is scoped
 * to the *live* grant rather than to the (guild, user, role) triple — an expired
 * or revoked row must be history, not a blocker.
 *
 * The concurrency hazard is real and the code is shaped around it: two grants of
 * the same role arriving at once must not both find "no live grant" and both
 * insert, because the member would then hold two live rows, the first expiry would
 * remove the role early, and the second would leave a permanent pending row behind.
 * A transaction-scoped advisory lock on the guild serializes them.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError } from "../../services/database/index.js";
import type {
  RoleGrantDraft,
  RoleGrantQuery,
  RoleGrantRecord,
  RoleGrantRepository,
  RoleGrantSource,
  RoleGrantStatus,
} from "./role.types.js";

export class PrismaRoleGrantRepository implements RoleGrantRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async upsert(draft: RoleGrantDraft): Promise<RoleGrantRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const client = tx as unknown as PrismaDatabaseClient;

        // `pg_advisory_xact_lock` on a hash of the guild id. Held until the
        // transaction commits, so the read-then-write below is atomic with respect
        // to other granters in the same guild. The lock is keyed on the guild, not
        // the row, so one action in server A never waits on one in server B.
        await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${draft.guildId}))`;

        const live = await client.roleGrant.findFirst({
          where: {
            guildId: draft.guildId,
            userId: draft.userId,
            roleId: draft.roleId,
            status: "active",
          },
        });

        if (live) {
          // Extended in place: the deadline moves, the identity does not. Writing a
          // second row would leave the previous `role.expire` task pointing at a
          // grant nothing reads.
          const updated = await client.roleGrant.update({
            where: { id: live.id },
            data: {
              expiresAt: draft.expiresAt,
              grantedBy: draft.grantedBy,
              source: draft.source,
              // Cleared on extension: the grant is live again, and a stale revoker
              // would make the row read as though it had already been removed.
              revokedAt: null,
              revokedBy: null,
            },
          });
          return toRecord(updated);
        }

        const created = await client.roleGrant.create({
          data: {
            guildId: draft.guildId,
            userId: draft.userId,
            roleId: draft.roleId,
            source: draft.source,
            // Omitted rather than set to `undefined`: under
            // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
            // as an absent optional field, and Prisma rejects the former here.
            ...(draft.menuId === undefined || draft.menuId === null
              ? {}
              : { menuId: draft.menuId }),
            grantedBy: draft.grantedBy,
            status: "active",
            expiresAt: draft.expiresAt,
          },
        });
        return toRecord(created);
      });
    } catch (error) {
      throw toDatabaseError(error, "role.upsert");
    }
  }

  /**
   * Closes a live grant.
   *
   * Conditional on `status: "active"`, so the transition is claimed by exactly one
   * caller: a manual revoke racing the expiry task cannot both succeed and report a
   * change, and the loser's audit event is not written.
   */
  public async close(
    guildId: string,
    userId: string,
    roleId: string,
    status: Exclude<RoleGrantStatus, "active">,
    at: Date,
    closedBy: string,
  ): Promise<boolean> {
    try {
      const result = await this.prisma.roleGrant.updateMany({
        where: { guildId, userId, roleId, status: "active" },
        data: { status, revokedAt: at, revokedBy: closedBy },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "role.close");
    }
  }

  /** Closes one grant by id. Used by the expiry task, which knows only the id. */
  public async closeById(
    id: string,
    status: Exclude<RoleGrantStatus, "active">,
    at: Date,
    closedBy: string,
  ): Promise<boolean> {
    try {
      const result = await this.prisma.roleGrant.updateMany({
        where: { id, status: "active" },
        data: { status, revokedAt: at, revokedBy: closedBy },
      });
      return result.count > 0;
    } catch (error) {
      throw toDatabaseError(error, "role.closeById");
    }
  }

  public async findById(id: string): Promise<RoleGrantRecord | null> {
    try {
      const row = await this.prisma.roleGrant.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "role.findById");
    }
  }

  public async findLive(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<RoleGrantRecord | null> {
    try {
      const row = await this.prisma.roleGrant.findFirst({
        where: { guildId, userId, roleId, status: "active" },
      });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "role.findLive");
    }
  }

  public async list(guildId: string, query: RoleGrantQuery = {}): Promise<RoleGrantRecord[]> {
    try {
      const rows = await this.prisma.roleGrant.findMany({
        where: {
          guildId,
          ...(query.userId === undefined || query.userId === null ? {} : { userId: query.userId }),
          ...(query.roleId === undefined || query.roleId === null ? {} : { roleId: query.roleId }),
          ...(query.status === undefined || query.status === null ? {} : { status: query.status }),
        },
        orderBy: { expiresAt: "asc" },
        take: query.limit ?? 25,
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "role.list");
    }
  }

  public async listExpired(now: Date, limit: number): Promise<RoleGrantRecord[]> {
    try {
      // No guild filter on purpose: this is the recovery path, called once at
      // startup for the whole process, and it must see every guild. `expiresAt: null`
      // is excluded implicitly by the `lte`, which is what keeps a permanent grant
      // (a self-service role) out of the sweep.
      const rows = await this.prisma.roleGrant.findMany({
        where: { status: "active", expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        take: limit,
      });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "role.listExpired");
    }
  }
}

/** Shape of a `role_grants` row, as Prisma returns it. */
interface RoleGrantRow {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly source: string;
  readonly menuId: string | null;
  readonly grantedBy: string;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
}

/** Maps a row to the domain record, narrowing the two string-typed columns. */
function toRecord(row: RoleGrantRow): RoleGrantRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    roleId: row.roleId,
    source: row.source as RoleGrantSource,
    menuId: row.menuId,
    grantedBy: row.grantedBy,
    status: row.status as RoleGrantStatus,
    // Normalized here so no caller has to treat `Date | null` as `undefined`: the
    // schema allows a permanent grant, the domain record requires an explicit
    // absent deadline.
    expiresAt: row.expiresAt,
    grantedAt: row.createdAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}
