/**
 * In-memory moderation collaborators for tests.
 *
 * Like the setup harness, these fake *Discord* and *PostgreSQL* only: the service,
 * the threshold arithmetic, the guards and the audit calls are the production
 * ones, so the tests exercise the code the bot actually runs.
 *
 * The member adapter models the facts the service reads — role position, timeout,
 * mute-role presence, ban flag — and records every write, so a test can assert
 * both the decision and the effect.
 */
import type {
  GuildMemberActions,
  MemberActionResult,
} from "../../src/modules/moderation/member-actions.js";
import type {
  ModerationCaseDraft,
  ModerationCaseQuery,
  ModerationCaseRecord,
  ModerationCaseRepository,
  SweepResolution,
} from "../../src/modules/moderation/moderation-case.repository.js";
import type {
  MemberTarget,
  ModerationTarget,
} from "../../src/modules/moderation/moderation.types.js";

/** Mute role returned by the fake adapter when the guild has one. */
export interface FakeMuteRole {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface FakeMemberActionsOptions {
  /** The guild's `Muted` role, or `null` when the server has none. */
  readonly muteRole?: FakeMuteRole | null;
  /** The security module's `Quarantined` role, or `null` when absent. */
  readonly quarantineRole?: FakeMuteRole | null;
}

/** Every write the fake adapter received, in order. */
export interface FakeMemberActions extends GuildMemberActions {
  readonly targets: Map<string, MemberTarget>;
  readonly calls: { action: string; targetId: string; roleId?: string }[];
  /** Role IDs per member, mutated by `setRole`. */
  readonly roles: Map<string, Set<string>>;
  /** Timeout expiry per member. */
  readonly timeouts: Map<string, Date | null>;
  /** Banned user IDs. */
  readonly bans: Set<string>;
  /** Number of messages `purgeMessages` reports. */
  readonly purged: { value: number };
  /** When set, every write fails with this detail. */
  failWith: string | null;
}

/** Builds the fake member adapter. */
export function fakeMemberActions(options: FakeMemberActionsOptions = {}): FakeMemberActions {
  const targets = new Map<string, MemberTarget>();
  const calls: { action: string; targetId: string; roleId?: string }[] = [];
  const roles = new Map<string, Set<string>>();
  const timeouts = new Map<string, Date | null>();
  const bans = new Set<string>();
  const purged = { value: 0 };
  const muteRole = options.muteRole ?? null;
  const quarantineRole = options.quarantineRole ?? null;

  const failed = (): MemberActionResult | null =>
    adapter.failWith === null ? null : { ok: false, detail: adapter.failWith };

  const adapter: FakeMemberActions = {
    targets,
    calls,
    roles,
    timeouts,
    bans,
    purged,
    failWith: null,

    readTarget(_guildId, userId) {
      const target = targets.get(userId);
      if (!target) {
        return Promise.resolve(null);
      }
      // The seeded target is the source of truth; the maps mirror its mutable
      // fields, so a test can change state without rebuilding the record.
      return Promise.resolve({
        ...target,
        muted: muteRole ? (roles.get(userId)?.has(muteRole.id) ?? false) : false,
        quarantined: quarantineRole ? (roles.get(userId)?.has(quarantineRole.id) ?? false) : false,
        roleIds: [...(roles.get(userId) ?? [])],
        timedOutUntil: timeouts.get(userId) ?? null,
        banned: bans.has(userId),
      });
    },

    readBannedTarget(_guildId, userId) {
      const target = targets.get(userId);
      if (!bans.has(userId) || !target) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ ...target, present: false, banned: true, roleIds: [] });
    },

    readState(userId) {
      // Mirrors what `readTarget` derives from the same maps, minus the
      // authorization facts the no-op guard does not need.
      if (!targets.has(userId)) {
        return Promise.resolve(null);
      }
      const timeout = timeouts.get(userId) ?? null;
      return Promise.resolve({
        timedOutUntil: timeout === null ? null : timeout.toISOString(),
        muted: muteRole ? (roles.get(userId)?.has(muteRole.id) ?? false) : false,
        quarantined: quarantineRole ? (roles.get(userId)?.has(quarantineRole.id) ?? false) : false,
      });
    },

    timeout(target, durationMs) {
      calls.push({ action: "timeout", targetId: target.id });
      const failure = failed();
      if (failure) {
        return Promise.resolve(failure);
      }
      timeouts.set(target.id, new Date(Date.now() + durationMs));
      return Promise.resolve({ ok: true });
    },

    removeTimeout(target) {
      calls.push({ action: "untimeout", targetId: target.id });
      const failure = failed();
      if (failure) {
        return Promise.resolve(failure);
      }
      timeouts.set(target.id, null);
      return Promise.resolve({ ok: true });
    },

    kick(target) {
      calls.push({ action: "kick", targetId: target.id });
      return Promise.resolve(failed() ?? { ok: true });
    },

    ban(target) {
      calls.push({ action: "ban", targetId: target.id });
      const failure = failed();
      if (failure) {
        return Promise.resolve(failure);
      }
      bans.add(target.id);
      return Promise.resolve({ ok: true });
    },

    unban(target) {
      calls.push({ action: "unban", targetId: target.id });
      const failure = failed();
      if (failure) {
        return Promise.resolve(failure);
      }
      bans.delete(target.id);
      return Promise.resolve({ ok: true });
    },

    muteRole() {
      return Promise.resolve(muteRole);
    },

    quarantineRole() {
      return Promise.resolve(quarantineRole);
    },

    stripRoles(target, options) {
      calls.push({ action: "strip-roles", targetId: target.id });
      const failure = failed();
      if (failure) {
        return Promise.resolve({ ok: false, removed: [], ...failure });
      }
      // Mirrors the real adapter: `@everyone` and the caller's kept roles survive,
      // and everything else comes off in one write.
      const current = roles.get(target.id) ?? new Set<string>();
      const keep = new Set(options.keepRoleIds);
      const removed = [...current].filter((roleId) => !keep.has(roleId));
      for (const roleId of removed) {
        current.delete(roleId);
      }
      roles.set(target.id, current);
      return Promise.resolve({ ok: true, removed });
    },

    setRole(target, roleId, present) {
      calls.push({ action: present ? "role-add" : "role-remove", targetId: target.id, roleId });
      const failure = failed();
      if (failure) {
        return Promise.resolve(failure);
      }
      const current = roles.get(target.id) ?? new Set<string>();
      if (present) {
        current.add(roleId);
      } else {
        current.delete(roleId);
      }
      roles.set(target.id, current);
      return Promise.resolve({ ok: true });
    },

    directMessage() {
      // DMs are reported as delivered unless a test simulates an unreachable
      // member, which keeps the default path free of irrelevant notes.
      return Promise.resolve({ ok: adapter.failWith === null });
    },

    purgeMessages() {
      return Promise.resolve({ removed: purged.value });
    },
  };

  return adapter;
}

/** Builds a member target with sane defaults a test can override. */
export function memberTarget(overrides: Partial<MemberTarget> = {}): MemberTarget {
  return {
    type: "member",
    id: "444444444444444444",
    tag: "target#0001",
    present: true,
    sameGuild: true,
    protectedMember: false,
    botPermissions: 0n,
    highestRolePosition: 1,
    botHighestRolePosition: 10,
    timedOutUntil: null,
    muted: false,
    banned: false,
    roleIds: [],
    ...overrides,
  };
}

/** Builds a channel target (used by `purge`). */
export function channelTarget(
  overrides: Partial<Extract<ModerationTarget, { type: "channel" }>> = {},
): Extract<ModerationTarget, { type: "channel" }> {
  return { type: "channel", id: "chan-1", name: "general", ...overrides };
}

/** In-memory case repository with the same numbering guarantee as Prisma's. */
export function memoryCaseRepository(): ModerationCaseRepository & {
  readonly cases: ModerationCaseRecord[];
} {
  const cases: ModerationCaseRecord[] = [];

  const matches = (
    record: ModerationCaseRecord,
    guildId: string,
    query: ModerationCaseQuery,
  ): boolean =>
    record.guildId === guildId &&
    (query.targetId === undefined ||
      query.targetId === null ||
      record.targetId === query.targetId) &&
    (query.action === undefined || query.action === null || record.action === query.action) &&
    (query.since === undefined || query.since === null || record.createdAt > query.since);

  return {
    cases,

    append(draft: ModerationCaseDraft) {
      // Numbers are per guild, starting at 1, exactly like the counter row.
      const number = cases.filter((record) => record.guildId === draft.guildId).length + 1;
      const record: ModerationCaseRecord = {
        id: `case-${draft.guildId}-${number}`,
        guildId: draft.guildId,
        caseNumber: number,
        action: draft.action,
        targetId: draft.target.id,
        targetType: draft.target.type === "member" ? "member" : "channel",
        moderatorId: draft.actor.id,
        moderatorKind: draft.actor.kind,
        reason: draft.reason,
        durationMs: draft.durationMs,
        expiresAt: draft.expiresAt,
        before: draft.before,
        after: draft.after,
        details: draft.details,
        relatedCaseNumber: draft.relatedCaseNumber,
        createdAt: new Date(),
      };
      cases.push(record);
      return Promise.resolve(record);
    },

    list(guildId, query = {}) {
      return Promise.resolve(
        cases
          .filter((record) => matches(record, guildId, query))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, query.limit ?? 25),
      );
    },

    count(guildId, query = {}) {
      return Promise.resolve(cases.filter((record) => matches(record, guildId, query)).length);
    },

    listNumbers(guildId, query) {
      return Promise.resolve(
        cases
          .filter((record) => matches(record, guildId, query))
          .sort((left, right) => left.caseNumber - right.caseNumber)
          .slice(0, query.limit ?? 100)
          .map((record) => record.caseNumber),
      );
    },

    listExpired(now: Date, limit: number) {
      // Mirrors the production query: a deadline-bearing action, past due, and not
      // already reversed. The reversal filter is what keeps a swept case from being
      // swept again on every tick.
      const lifted = new Set(
        cases
          .filter(
            (record) =>
              record.action === "unmute" ||
              record.action === "untimeout" ||
              record.action === "unban",
          )
          .map((record) => record.relatedCaseNumber)
          .filter((value): value is number => value !== null),
      );

      return Promise.resolve(
        cases
          .filter(
            (record) =>
              (record.action === "mute" ||
                record.action === "timeout" ||
                record.action === "ban") &&
              record.expiresAt !== null &&
              record.expiresAt.getTime() <= now.getTime() &&
              !lifted.has(record.caseNumber),
          )
          .sort(
            (left, right) => (left.expiresAt?.getTime() ?? 0) - (right.expiresAt?.getTime() ?? 0),
          )
          .slice(0, limit),
      );
    },

    closeUnliftable(id: string, resolution: SweepResolution) {
      // Mirrors the production write: clearing `expiresAt` is what makes a retired
      // case invisible to `listExpired` above, and the reason is kept on the record.
      const record = cases.find((candidate) => candidate.id === id);
      if (record) {
        (record as { expiresAt: Date | null }).expiresAt = null;
        (record as { details: unknown }).details = {
          ...((record.details as Record<string, unknown> | null) ?? {}),
          sweep: {
            resolvedAt: new Date().toISOString(),
            reason: resolution.reason,
            expiresAt: resolution.expiresAt?.toISOString() ?? null,
          },
        };
      }
      return Promise.resolve();
    },
  };
}
