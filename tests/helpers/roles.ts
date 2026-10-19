/**
 * In-memory collaborators for the V6 role module tests.
 *
 * The fakes replace external systems only: `RoleService` and its contracts under
 * test are the production ones.
 *
 * Two behaviours are modelled deliberately, because the module's correctness rests
 * on them and a fake that glossed over either would let a real bug pass:
 *
 * - `close` and `closeById` only succeed for a row that is `active`, and they flip
 *   the status *before* returning. That is the compare-and-swap the real
 *   `updateMany({ where: { status: "active" } })` performs, and it is what makes
 *   "expiry happens exactly once" testable rather than merely asserted.
 * - `setRole` records every call, so a test can prove that an idempotent re-fire
 *   does *not* touch Discord a second time.
 */
import type {
  GuildRoleActions,
  RoleActionResult,
  RoleGrantDraft,
  RoleGrantQuery,
  RoleGrantRecord,
  RoleGrantRepository,
} from "../../src/modules/roles/index.js";

/** Interface for the in-memory grant store, exposing internals for assertions. */
export interface MemoryRoleGrants extends RoleGrantRepository {
  /** Every row, in creation order. */
  readonly rows: RoleGrantRecord[];
  /** Test-only: closes a row without going through the port's status guard. */
  forceStatus(id: string, status: RoleGrantRecord["status"]): void;
  /** Test-only: moves a row's deadline, to simulate time passing. */
  setExpiry(id: string, at: Date): void;
}

/** Builds an isolated in-memory grant repository. One per test. */
export function memoryRoleGrants(): MemoryRoleGrants {
  const rows: RoleGrantRecord[] = [];
  let counter = 0;

  const find = (id: string): RoleGrantRecord | undefined => rows.find((row) => row.id === id);

  const store: MemoryRoleGrants = {
    rows,

    forceStatus(id, status) {
      const row = find(id);
      if (row) {
        row.status = status;
      }
    },

    setExpiry(id, at) {
      const row = find(id);
      if (row) {
        row.expiresAt = at;
      }
    },

    async upsert(draft: RoleGrantDraft): Promise<RoleGrantRecord> {
      const live = rows.find(
        (row) =>
          row.guildId === draft.guildId &&
          row.userId === draft.userId &&
          row.roleId === draft.roleId &&
          row.status === "active",
      );

      if (live) {
        // Extended in place, and a previous revoke is cleared — mirroring the real
        // repository, where a grant that is live again must not read as removed.
        live.expiresAt = draft.expiresAt;
        live.grantedBy = draft.grantedBy;
        live.source = draft.source;
        live.revokedAt = null;
        live.revokedBy = null;
        return live;
      }

      counter += 1;
      const row: RoleGrantRecord = {
        id: `grant-${counter}`,
        guildId: draft.guildId,
        userId: draft.userId,
        roleId: draft.roleId,
        source: draft.source,
        menuId: draft.menuId ?? null,
        grantedBy: draft.grantedBy,
        status: "active",
        expiresAt: draft.expiresAt,
        grantedAt: new Date(0),
        revokedAt: null,
        revokedBy: null,
      };
      rows.push(row);
      return row;
    },

    async close(guildId, userId, roleId, status, at, closedBy): Promise<boolean> {
      const row = rows.find(
        (candidate) =>
          candidate.guildId === guildId &&
          candidate.userId === userId &&
          candidate.roleId === roleId &&
          candidate.status === "active",
      );
      if (!row) {
        return false;
      }
      row.status = status;
      row.revokedAt = at;
      row.revokedBy = closedBy;
      return true;
    },

    async closeById(id, status, at, closedBy): Promise<boolean> {
      const row = find(id);
      if (!row || row.status !== "active") {
        return false;
      }
      row.status = status;
      row.revokedAt = at;
      row.revokedBy = closedBy;
      return true;
    },

    async findById(id) {
      return find(id) ?? null;
    },

    async findLive(guildId, userId, roleId) {
      return (
        rows.find(
          (row) =>
            row.guildId === guildId &&
            row.userId === userId &&
            row.roleId === roleId &&
            row.status === "active",
        ) ?? null
      );
    },

    async list(guildId: string, query: RoleGrantQuery = {}) {
      return rows.filter(
        (row) =>
          row.guildId === guildId &&
          (query.userId === undefined || query.userId === null || row.userId === query.userId) &&
          (query.roleId === undefined || query.roleId === null || row.roleId === query.roleId) &&
          (query.status === undefined || query.status === null || row.status === query.status),
      );
    },

    async listExpired(now: Date, limit: number) {
      return rows
        .filter(
          (row) =>
            row.status === "active" &&
            row.expiresAt !== null &&
            row.expiresAt.getTime() <= now.getTime(),
        )
        .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
        .slice(0, limit);
    },
  };

  return store;
}

/** Interface for the fake Discord port, exposing call history for assertions. */
export interface FakeRoleActions extends GuildRoleActions {
  /** Every `setRole` call, in order: `[userId, roleId, present]`. */
  readonly roleCalls: { userId: string; roleId: string; present: boolean }[];
  /** Test-only: makes the next `setRole` fail. */
  failNextSetRole(detail: string): void;
  /** Test-only: makes the member look like they left the guild. */
  removeMember(userId: string): void;
  /** Test-only: marks a role unmanageable (above the bot, or integration-owned). */
  unmanageable(roleId: string): void;
  /** Test-only: the roles a member currently holds. */
  rolesOf(userId: string): readonly string[];
}

/** Builds a fake Discord port with a small, inspectable role universe. */
export function fakeRoleActions(initial: Record<string, readonly string[]> = {}): FakeRoleActions {
  const members = new Map<string, Set<string>>(
    Object.entries(initial).map(([userId, roleIds]) => [userId, new Set(roleIds)]),
  );
  const unmanageableRoles = new Set<string>();
  const roleCalls: { userId: string; roleId: string; present: boolean }[] = [];
  let nextFailure: string | null = null;

  return {
    roleCalls,

    failNextSetRole(detail) {
      nextFailure = detail;
    },

    removeMember(userId) {
      members.delete(userId);
    },

    unmanageable(roleId) {
      unmanageableRoles.add(roleId);
    },

    rolesOf(userId) {
      return [...(members.get(userId) ?? [])];
    },

    async hasMember(userId) {
      return members.has(userId);
    },

    async roleIdsOf(userId) {
      const held = members.get(userId);
      // `null`, not `[]`, for an absent member: the service depends on the
      // distinction to decide whether an expiry can be closed.
      return held ? [...held] : null;
    },

    async setRole(userId, roleId, present): Promise<RoleActionResult> {
      roleCalls.push({ userId, roleId, present });

      if (nextFailure !== null) {
        const detail = nextFailure;
        nextFailure = null;
        return { ok: false, detail };
      }

      const held = members.get(userId);
      if (!held) {
        return { ok: false, detail: "that member is not in this server" };
      }
      if (present) {
        held.add(roleId);
      } else {
        held.delete(roleId);
      }
      return { ok: true };
    },

    async canManage(roleId) {
      return !unmanageableRoles.has(roleId);
    },

    async botHighestPosition() {
      return 100;
    },

    async rolePosition(roleId) {
      return unmanageableRoles.has(roleId) ? null : 1;
    },
  };
}
