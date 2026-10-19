/**
 * Temporary role grants.
 *
 * The whole module is one guarantee: **a role granted for a duration comes off
 * again, even if the process dies in between.** That is why a grant is a row and
 * a scheduled task, not a `setTimeout`.
 *
 * The lifecycle of one grant:
 *
 *   1. `grant()` validates the role is assignable, adds it in Discord, writes the
 *      row, and schedules `role.expire` keyed on the grant's identity.
 *   2. At the deadline the scheduler runs `role.expire`, which calls `expire()`.
 *   3. `expire()` re-reads the row, removes the role, and marks it terminal.
 *
 * Two failure modes are worth naming, because the code is shaped to prevent them
 * rather than to merely handle them:
 *
 * - **The role must come off exactly once.** `expire()` does not trust the task:
 *   it re-reads the grant and only acts while it is `pending`, and the repository
 *   flips that status conditionally. A duplicate fire, a manual revoke and a
 *   startup recovery therefore all converge — the first wins, the rest observe
 *   `false` and report `skipped`.
 * - **A grant must never outlive its task.** If scheduling failed after the role
 *   was added, the member would hold the role forever with nothing due to remove
 *   it. So the role is added first and the row written immediately after, and a
 *   failure to schedule *revokes* the grant instead of leaving it half-applied.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import { ValidationError } from "../../utils/errors.js";
import type { SchedulerService } from "../scheduler/scheduler.service.js";
import type {
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerResult,
} from "../scheduler/scheduler.types.js";
import type {
  GuildRoleActions,
  RoleGrantRecord,
  RoleGrantRepository,
  RoleGrantStatus,
} from "./role.types.js";

/** The task kind this module owns. Named once, so a typo cannot fork it. */
export const ROLE_EXPIRE_TASK_KIND = "role.expire";

/** Audit actions recorded by this module. */
const AUDIT_ACTION_GRANTED = "role.granted";
const AUDIT_ACTION_REVOKED = "role.revoked";
const AUDIT_ACTION_EXPIRED = "role.expired";

/** Bounds, exported so the docs and the error messages cannot disagree. */
export const ROLE_LIMITS = {
  /** Shortest temporary grant (one minute). Below this a role is a blink. */
  minDurationMs: 60_000,
  /** Longest temporary grant (one year). Guards against a mistyped duration. */
  maxDurationMs: 365 * 24 * 60 * 60 * 1_000,
  /** Grants returned by `/roles list` at most. */
  maxListEntries: 100,
} as const;

/** One grant request. */
export interface RoleGrantRequest {
  readonly guildId: string;
  readonly userId: string;
  readonly roleId: string;
  /** The requesting user, or `system:<name>` for an automated grant. */
  readonly grantedBy: string;
  /** How long the member keeps the role. Required: this is a *temporary* grant. */
  readonly durationMs: number;
}

/** Result of a grant, so a command can report precisely. */
export interface RoleGrantOutcome {
  readonly grant: RoleGrantRecord;
  /** False when the member already held the role, so no Discord call was made. */
  readonly applied: boolean;
  /** Set when the role was removed early because the task could not be scheduled. */
  readonly rolledBack?: boolean;
}

/** Filters accepted by `list`. */
export interface RoleListQuery {
  readonly userId?: string | null;
  readonly roleId?: string | null;
  readonly status?: RoleGrantStatus | null;
  readonly limit?: number;
}

export interface RoleServiceDeps {
  /** Omitted in tests that only exercise the task handler. */
  readonly scheduler?: SchedulerService | undefined;
  readonly repository: RoleGrantRepository;
  readonly actions: GuildRoleActions;
  readonly logger: Logger;
  readonly audit?: AuditEventService | undefined;
  /** Clock, injected so expiry tests do not sleep. */
  readonly now?: (() => number) | undefined;
}

export class RoleService {
  private readonly scheduler: SchedulerService | undefined;
  private readonly repository: RoleGrantRepository;
  private readonly actions: GuildRoleActions;
  private readonly logger: Logger;
  private readonly audit: AuditEventService | undefined;
  private readonly clock: () => number;

  public constructor(deps: RoleServiceDeps) {
    this.scheduler = deps.scheduler;
    this.repository = deps.repository;
    this.actions = deps.actions;
    this.logger = deps.logger.child("roles");
    this.audit = deps.audit;
    this.clock = deps.now ?? (() => Date.now());
  }

  /**
   * Grants a role for a duration.
   *
   * Order of operations is deliberate: Discord first, then storage, then the task.
   * A row written before the role was added would make the expiry task try to
   * remove a role the member never had; the reverse is recoverable by revoking.
   *
   * @throws ValidationError when the duration is out of range, the role is not
   * manageable by the bot, or the member is not in the guild.
   */
  public async grant(request: RoleGrantRequest): Promise<RoleGrantOutcome> {
    const durationMs = this.resolveDuration(request.durationMs);

    if (!(await this.actions.hasMember(request.userId))) {
      throw new ValidationError("That member is not in this server.");
    }

    if (!(await this.actions.canManage(request.roleId))) {
      throw new ValidationError(
        "I cannot manage that role. It must exist and sit below my highest role.",
      );
    }

    const expiresAt = new Date(this.clock() + durationMs);
    const existing = await this.repository.findLive(
      request.guildId,
      request.userId,
      request.roleId,
    );

    // Only touch Discord when the member does not already hold the role. Re-granting
    // an already-held role is an extension, and a redundant API call there would be
    // visible noise in the audit trail.
    const held = await this.actions.roleIdsOf(request.userId);
    const alreadyHeld = held?.includes(request.roleId) ?? false;

    if (!alreadyHeld) {
      const applied = await this.actions.setRole(
        request.userId,
        request.roleId,
        true,
        "Temporary role grant",
      );
      if (!applied.ok) {
        throw new ValidationError(
          `Could not add the role: ${applied.detail ?? "Discord refused the change"}`,
        );
      }
    }

    const grant = await this.repository.upsert({
      guildId: request.guildId,
      userId: request.userId,
      roleId: request.roleId,
      source: "temporary",
      grantedBy: request.grantedBy,
      expiresAt,
    });

    try {
      await this.scheduleExpiry(grant);
    } catch (error) {
      // The role is on the member but nothing is due to remove it, so the guarantee
      // is already broken. Undo the grant rather than leave an unbounded one.
      await this.actions.setRole(
        request.userId,
        request.roleId,
        false,
        "Temporary role grant rolled back: expiry could not be scheduled",
      );
      await this.repository.close(
        request.guildId,
        request.userId,
        request.roleId,
        "revoked",
        new Date(this.clock()),
        "system:rollback",
      );
      this.logger.error("Temporary role grant rolled back", error, {
        guildId: request.guildId,
        userId: request.userId,
        roleId: request.roleId,
      });
      return { grant, applied: !alreadyHeld, rolledBack: true };
    }

    await this.record(AUDIT_ACTION_GRANTED, grant, request.grantedBy, {
      extended: existing !== null,
      durationMs,
    });

    this.logger.info(existing ? "Temporary role grant extended" : "Temporary role granted", {
      guildId: request.guildId,
      userId: request.userId,
      roleId: request.roleId,
      expiresAt: expiresAt.toISOString(),
    });

    return { grant, applied: !alreadyHeld };
  }

  /**
   * Removes a temporary role before its deadline.
   *
   * The Discord call happens first and the row is flipped only if it succeeded.
   * Flipping first would mark the grant terminal while the member still held the
   * role, and the closed row would then never be revisited — a silent leak.
   *
   * The scheduled task is deliberately *not* cancelled here. Cancelling would make
   * revoke and expiry two code paths with two failure modes; instead the task runs,
   * finds the grant closed and reports `skipped`, which is already cheap.
   *
   * @returns the grant as it now stands, or `null` when none was live.
   */
  public async revoke(
    guildId: string,
    userId: string,
    roleId: string,
    revokedBy: string,
  ): Promise<RoleGrantRecord | null> {
    const grant = await this.repository.findLive(guildId, userId, roleId);
    if (!grant) {
      return null;
    }

    const held = await this.actions.roleIdsOf(userId);
    if (held?.includes(roleId)) {
      const removed = await this.actions.setRole(userId, roleId, false, "Temporary role revoked");
      if (!removed.ok) {
        throw new ValidationError(
          `Could not remove the role: ${removed.detail ?? "Discord refused the change"}`,
        );
      }
    }

    const at = new Date(this.clock());
    await this.repository.close(guildId, userId, roleId, "revoked", at, revokedBy);
    await this.record(AUDIT_ACTION_REVOKED, grant, revokedBy, {});
    this.logger.info("Temporary role revoked", { guildId, userId, roleId, revokedBy });

    return { ...grant, status: "revoked", revokedAt: at, revokedBy };
  }

  /**
   * Expires one grant: removes the role, then marks the row terminal.
   *
   * Safe to call twice. The status transition is claimed conditionally, so the
   * loser of a race observes `false` and reports `skipped` instead of removing a
   * role twice or overwriting the other caller's outcome.
   *
   * @returns `true` when this call performed the expiry, `false` when the grant
   * was already terminal or no longer exists.
   */
  public async expire(grantId: string): Promise<boolean> {
    const grant = await this.repository.findById(grantId);
    if (!grant || grant.status !== "active") {
      return false;
    }

    const held = await this.actions.roleIdsOf(grant.userId);
    // `held === null` means the member left the guild. There is nothing to remove,
    // but the grant is still closed: leaving it active would make every future sweep
    // re-examine it forever and show the operator a grant that never ends.
    if (held?.includes(grant.roleId)) {
      const removed = await this.actions.setRole(
        grant.userId,
        grant.roleId,
        false,
        "Temporary role expired",
      );
      this.note(removed.ok, "Could not remove an expired role", grant, {
        detail: removed.detail ?? "Discord refused the change",
      });
    }

    const claimed = await this.repository.closeById(
      grantId,
      "expired",
      new Date(this.clock()),
      "system:expiry",
    );
    if (!claimed) {
      // Another caller closed it between the read and the write. Their outcome
      // stands, and this one must not double-count in the audit trail.
      return false;
    }

    await this.record(AUDIT_ACTION_EXPIRED, grant, "system", {});
    this.logger.info("Temporary role expired", {
      guildId: grant.guildId,
      userId: grant.userId,
      roleId: grant.roleId,
    });
    return true;
  }

  /**
   * The `role.expire` handler, registered with the scheduler.
   *
   * Thin by design: it validates its payload and delegates. All the idempotence
   * lives in `expire()`, so the guarantee holds whether the task fired on time,
   * fired twice, or never fired and startup recovery did the work instead.
   */
  public handler(): TaskHandler {
    return {
      kind: ROLE_EXPIRE_TASK_KIND,
      description: "Removes a temporary role when its grant expires.",
      run: async (context: TaskHandlerContext): Promise<TaskHandlerResult> => {
        const grantId = this.readGrantId(context);
        const expired = await this.expire(grantId);
        return expired
          ? { outcome: "done", detail: `removed role for grant ${grantId}` }
          : { outcome: "skipped", detail: "grant already closed" };
      },
    };
  }

  /**
   * Closes every grant whose deadline has passed, across all guilds.
   *
   * This is the safety net, not the primary path: the scheduled task normally wins.
   * It exists because a task row could have been lost, cancelled by hand, or
   * abandoned after exhausting its attempts, and in every one of those cases the
   * member would otherwise keep the role indefinitely. Call it at startup, so a
   * restart alone is enough to repair the drift.
   *
   * @returns the number of grants this call actually expired.
   */
  public async recoverExpired(limit = ROLE_LIMITS.maxListEntries): Promise<number> {
    const expired = await this.repository.listExpired(new Date(this.clock()), limit);
    let recovered = 0;

    for (const grant of expired) {
      try {
        if (await this.expire(grant.id)) {
          recovered += 1;
        }
      } catch (error) {
        // One unreadable guild must not stop the sweep for the others: this loop is
        // the repair path, and aborting it would leave every later grant leaked.
        this.logger.error("Could not recover an expired role grant", error, {
          guildId: grant.guildId,
          userId: grant.userId,
          roleId: grant.roleId,
        });
      }
    }

    if (recovered > 0) {
      this.logger.info("Recovered expired role grants", {
        recovered,
        examined: expired.length,
      });
    }
    return recovered;
  }

  /** Lists grants for a guild, for `/roles list`. */
  public list(guildId: string, query: RoleListQuery = {}): Promise<RoleGrantRecord[]> {
    return this.repository.list(guildId, {
      ...query,
      limit: Math.min(query.limit ?? 25, ROLE_LIMITS.maxListEntries),
    });
  }

  /** The live grant a member holds for a role, or `null`. */
  public findLive(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<RoleGrantRecord | null> {
    return this.repository.findLive(guildId, userId, roleId);
  }

  /**
   * Schedules (or reschedules) a grant's expiry.
   *
   * The dedupe key is the grant's identity, so extending a grant replaces the
   * existing task instead of creating a second one. Two tasks for one grant would
   * mean the earlier deadline wins and the member loses the role early — the
   * extension would silently do nothing.
   */
  private async scheduleExpiry(grant: RoleGrantRecord): Promise<void> {
    if (!this.scheduler || !grant.expiresAt) {
      return;
    }

    await this.scheduler.schedule({
      guildId: grant.guildId,
      kind: ROLE_EXPIRE_TASK_KIND,
      dueAt: grant.expiresAt,
      payload: { grantId: grant.id },
      dedupeKey: `${ROLE_EXPIRE_TASK_KIND}:${grant.guildId}:${grant.userId}:${grant.roleId}`,
    });
  }

  /** Reads and validates the task payload, so a malformed task fails loudly. */
  private readGrantId(context: TaskHandlerContext): string {
    const payload = context.task.payload;
    const grantId =
      typeof payload === "object" && payload !== null
        ? (payload as { grantId?: unknown }).grantId
        : undefined;

    if (typeof grantId !== "string" || grantId.length === 0) {
      throw new ValidationError(
        `Scheduled task ${context.task.id} has no valid "grantId" payload.`,
      );
    }
    return grantId;
  }

  /** @throws ValidationError when the duration is outside the supported range. */
  private resolveDuration(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs < ROLE_LIMITS.minDurationMs) {
      throw new ValidationError(
        `A temporary role must last at least ${ROLE_LIMITS.minDurationMs / 60_000} minute(s).`,
      );
    }
    if (durationMs > ROLE_LIMITS.maxDurationMs) {
      throw new ValidationError("A temporary role cannot last longer than one year.");
    }
    return durationMs;
  }

  /** Records an audit event, tolerating an absent audit service. */
  private async record(
    action: string,
    grant: RoleGrantRecord,
    actorId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) {
      return;
    }
    await this.audit.record({
      guildId: grant.guildId,
      action,
      category: "roles",
      severity: "info",
      actorId,
      actorKind: actorId === "system" ? "system" : "user",
      targetType: "member",
      targetId: grant.userId,
      details: { roleId: grant.roleId, ...details },
    });
  }

  /** Logs a non-fatal Discord failure. Never throws: expiry must still complete. */
  private note(
    ok: boolean,
    message: string,
    grant: RoleGrantRecord,
    details: Record<string, unknown>,
  ): void {
    if (ok) {
      return;
    }
    this.logger.warn(message, {
      guildId: grant.guildId,
      userId: grant.userId,
      roleId: grant.roleId,
      ...details,
    });
  }
}
