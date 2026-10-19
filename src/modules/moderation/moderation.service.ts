/**
 * Moderation service.
 *
 * One action, one pipeline, one place to read the rules:
 *
 *   ModerationService.execute(guildId, request)
 *     → moderation enabled? (config, read per call, per guild)
 *     → hierarchy and self-action guards
 *     → Discord call through the member-action port
 *     → case + audit event + Discord log, when the call succeeded
 *
 * Design constraints that shaped it, from the V4 brief and the phases after:
 * - it takes a plain `ModerationRequest`, never an interaction, so a future
 *   automod or AI caller uses the exact same code path, and therefore the same
 *   permissions, audit trail and log line as a human moderator;
 * - configuration is read per call from `ConfigService`, so `moderation.enabled`,
 *   the warning threshold and the DM preference always reflect the current state
 *   of that guild rather than a value cached at startup;
 * - a Discord failure is *not* recorded as a case: the history only contains
 *   things that actually happened.
 */
import type { GuildConfig } from "../../services/config/index.js";
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import { GOD_ACCESS_USER_IDS } from "../../services/permissions/index.js";
import { ValidationError } from "../../utils/errors.js";
import type { ModerationAction } from "./moderation-actions.js";
import { MODERATION_LIMITS, moderationActionDefinition } from "./moderation-actions.js";
import type {
  ModerationCaseRecord,
  ModerationCaseRepository,
  ModerationTargetState,
} from "./moderation-case.repository.js";
import type { GuildMemberActions } from "./member-actions.js";
import type {
  MemberTarget,
  ModerationActor,
  ModerationOutcome,
  ModerationRequest,
} from "./moderation.types.js";

/** Delivery port for the Discord log channel (implemented by the logging module). */
export interface ModerationLogPort {
  /** Delivers one mod-action log line. Never throws. */
  record(event: ModerationLogEvent): Promise<void>;
}

/** A moderation action, as the log channel sees it. */
export interface ModerationLogEvent {
  readonly guildId: string;
  readonly action: ModerationAction;
  readonly label: string;
  readonly caseNumber: number;
  readonly actor: ModerationActor;
  readonly targetId: string | null;
  readonly targetTag: string | null;
  readonly reason: string | null;
  readonly durationMs: number | null;
  readonly expiresAt: Date | null;
}

/**
 * Reads a guild's moderation configuration.
 *
 * A reader rather than a snapshot, so a long-lived service instance always sees
 * the guild's current settings instead of one captured at construction.
 */
export type ModerationSettingsReader = (guildId: string) => Promise<GuildConfig["moderation"]>;

export interface ModerationServiceOptions {
  readonly logger: Logger;
  readonly audit: AuditEventService;
  readonly cases: ModerationCaseRepository;
  /** Member-level Discord operations for the guild being moderated. */
  readonly members: GuildMemberActions;
  readonly settings: ModerationSettingsReader;
  /** Optional: the guild's Discord log channel. Absent when logging is off. */
  readonly log?: ModerationLogPort;
}

/** Actions that require the moderator to state a reason. */
const REASON_REQUIRED: readonly ModerationAction[] = ["ban", "kick", "softban"];

/**
 * How each temporary punishment is lifted.
 *
 * The sweeper reads this table rather than a switch, so "which actions can expire,
 * and what undoes each" is one visible list. An action absent from it cannot be
 * lifted automatically, which is the safe default: `warn` has no deadline, and a
 * `quarantine` is the security module's to release.
 */
const REVERSAL_OF: Partial<Record<ModerationAction, ModerationAction>> = {
  mute: "unmute",
  timeout: "untimeout",
  ban: "unban",
};

/** Outcome of one expired-punishment sweep, for the caller to log. */
export interface ModerationLiftResult {
  /** Expired cases the sweep looked at. */
  readonly examined: number;
  /** Cases whose punishment was reversed. */
  readonly lifted: number;
  /**
   * Cases retired because their punishment can never be reversed any more (the
   * member left). They are *not* failures: there is nothing left to do, and
   * counting them as failures is what made one departed member log a warning on
   * every sweep for the rest of the bot's life.
   */
  readonly closed: number;
  /** Cases that failed for a reason a later sweep could still fix. */
  readonly failed: number;
}

export class ModerationService {
  private readonly logger: Logger;
  private readonly audit: AuditEventService;
  private readonly cases: ModerationCaseRepository;
  private readonly members: GuildMemberActions;
  private readonly settings: ModerationSettingsReader;
  private readonly log: ModerationLogPort | undefined;

  public constructor(options: ModerationServiceOptions) {
    this.logger = options.logger.child("moderation");
    this.audit = options.audit;
    this.cases = options.cases;
    this.members = options.members;
    this.settings = options.settings;
    this.log = options.log;
  }

  /** @returns the guild's moderation configuration, validated on read. */
  public config(guildId: string): Promise<GuildConfig["moderation"]> {
    return this.settings(guildId);
  }

  /**
   * Executes one moderation action.
   *
   * @throws ValidationError for a refused request (module disabled, protected
   * target, out-of-range duration, missing reason). The message is user-facing.
   */
  public async execute(guildId: string, request: ModerationRequest): Promise<ModerationOutcome> {
    const definition = moderationActionDefinition(request.action);
    if (!definition) {
      throw new ValidationError(`Unknown moderation action: ${request.action}`);
    }

    const config = await this.settings(guildId);
    if (definition.requiresModerationEnabled && !config.enabled) {
      throw new ValidationError(
        "Moderation is disabled in this server. Enable it with `/settings set area:moderation setting:moderation-enabled value:true`.",
      );
    }

    if (definition.scope === "member") {
      return this.executeMemberAction(guildId, config, request);
    }
    return this.executePurge(guildId, request);
  }

  /** @returns the number of active warnings of a member (the threshold source). */
  public async warningCount(guildId: string, targetId: string): Promise<number> {
    const [warnings, removals] = await Promise.all([
      this.cases.count(guildId, { targetId, action: "warn" }),
      this.cases.count(guildId, { targetId, action: "unwarn" }),
    ]);
    // Each `unwarn` cancels one warning; a negative count would be nonsense, so
    // it is clamped rather than surfaced.
    return Math.max(0, warnings - removals);
  }

  /** @returns the case history of a target, newest first. */
  public history(
    guildId: string,
    query: { targetId?: string | null; action?: ModerationAction | null; limit?: number },
  ): Promise<ModerationCaseRecord[]> {
    return this.cases.list(guildId, {
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      limit: Math.min(
        query.limit ?? MODERATION_LIMITS.defaultHistoryLimit,
        MODERATION_LIMITS.maxHistoryEntries,
      ),
    });
  }

  /**
   * Lifts every temporary punishment whose deadline has passed.
   *
   * This is the sweeper the V4 schema was written for: `expiresAt` has been stored
   * on every temporary case since then, precisely so that adding this needed no
   * migration. It is the reason a mute or a timeout is genuinely temporary rather
   * than "temporary until a moderator remembers".
   *
   * It deliberately re-enters `execute()` instead of calling the member port
   * directly. That is the whole design: an automatic unmute therefore passes the
   * same guards, writes the same `unmute` case, and emits the same audit event and
   * Discord log line as a human unmute. A second code path would drift from the
   * first, and the drift would only be visible in the cases that nobody tests.
   *
   * Failures are contained per case: one member the bot can no longer act on must
   * not stop the rest of the sweep.
   *
   * A case the sweep can *never* act on is retired rather than failed (see
   * `retire`): retrying it forever is what keeps an otherwise idle bot writing to
   * its database and its log file on every sweep, for the rest of its life.
   *
   * @returns counts for the caller to log.
   */
  public async liftExpired(
    limit = MODERATION_LIMITS.maxHistoryEntries,
  ): Promise<ModerationLiftResult> {
    const expired = await this.cases.listExpired(new Date(), limit);
    let lifted = 0;
    let closed = 0;
    let failed = 0;

    for (const record of expired) {
      try {
        if ((await this.liftOne(record)) === "lifted") {
          lifted += 1;
        } else {
          closed += 1;
        }
      } catch (error) {
        failed += 1;
        // Logged, not thrown: the next sweep retries, and one unactionable member
        // must not stop the others from being released.
        this.logger.warn("Could not lift an expired punishment", {
          guildId: record.guildId,
          caseNumber: record.caseNumber,
          action: record.action,
          reason: error instanceof Error ? error.message : "unknown error",
        });
      }
    }

    if (lifted > 0 || closed > 0 || failed > 0) {
      this.logger.info("Expired punishment sweep finished", {
        examined: expired.length,
        lifted,
        closed,
        failed,
      });
    }
    return { examined: expired.length, lifted, closed, failed };
  }

  /**
   * Reverses one expired case through the normal action pipeline.
   *
   * @returns `"lifted"` when the punishment was reversed, `"closed"` when the case
   * was retired because nothing can ever reverse it.
   *
   * @throws when the reversal was refused for a reason a later sweep could still
   * fix (permissions, a Discord error), so the caller counts it as a failure.
   */
  private async liftOne(record: ModerationCaseRecord): Promise<"lifted" | "closed"> {
    const reversal = REVERSAL_OF[record.action];
    if (!reversal || !record.targetId) {
      // Not a reversible temporary punishment, or one that names no target. There is
      // nothing this sweep — or any future sweep — can do with it, so it is retired
      // once instead of failing on every pass.
      await this.retire(record, "the case is not a reversible temporary punishment");
      return "closed";
    }

    const target = await this.members.readTarget(record.guildId, record.targetId);
    if (!target) {
      // The member is gone, so the punishment is moot: there is nothing to lift, and
      // waiting will not change that. Retiring the case keeps it in `/history` as the
      // record it is while stopping the sweep from examining it again next time.
      await this.retire(record, "the member is no longer in this server");
      return "closed";
    }

    await this.execute(record.guildId, {
      action: reversal,
      // `kind: "system"` keeps the provenance honest: the log channel and
      // `/history` both show that no human issued this.
      actor: { id: "system:sweeper", kind: "system", tag: null },
      target,
      reason: `Temporary ${record.action} expired (case #${record.caseNumber})`,
      source: "automation",
    });
    return "lifted";
  }

  /**
   * Closes an expired case the sweeper can never reverse, once.
   *
   * The decision is persisted on the case (and with it why and when), so the next
   * sweep does not list it at all. That is the difference between a departed member
   * costing one log line and one database write — versus a warning, two database
   * round trips and twenty log lines every minute for as long as the bot runs.
   */
  private async retire(record: ModerationCaseRecord, reason: string): Promise<void> {
    await this.cases.closeUnliftable(record.id, { reason, expiresAt: record.expiresAt });
    this.logger.info("Retired an expired punishment that can no longer be lifted", {
      guildId: record.guildId,
      caseNumber: record.caseNumber,
      action: record.action,
      reason,
    });
  }

  /**
   * Runs a member action: guards, Discord call, then case + audit + log.
   *
   * The order matters. Every guard runs *before* the Discord call, so an action
   * that would have been refused leaves no case, no audit event and no log line:
   * a history containing refusals would be useless to a moderator.
   */
  private async executeMemberAction(
    guildId: string,
    config: GuildConfig["moderation"],
    request: ModerationRequest,
  ): Promise<ModerationOutcome> {
    if (request.target.type !== "member") {
      throw new ValidationError(`${request.action} requires a member target`);
    }
    const target = request.target;
    const definition = moderationActionDefinition(request.action);
    if (!definition) {
      throw new ValidationError(`Unknown moderation action: ${request.action}`);
    }

    this.guardTarget(guildId, request.actor, target);
    this.guardReason(request.action, request.reason);
    await this.guardMemberState(request, target);
    const durationMs = this.resolveDuration(request.action, request.durationMs ?? null);

    const notes: string[] = [];
    let before = this.captureState(target, request.action, false);
    let after: ModerationOutcome["after"];
    let relatedCaseNumber: number | null = null;
    const details: Record<string, unknown> = { source: request.source ?? "command" };

    switch (request.action) {
      case "warn":
      case "unwarn": {
        if (request.action === "unwarn") {
          const caseNumber = await this.warnCaseToRemove(
            guildId,
            target.id,
            request.caseNumber ?? null,
          );
          if (caseNumber === null) {
            throw new ValidationError("That member has no warning left to remove.");
          }
          relatedCaseNumber = caseNumber;
        }
        after = this.captureState(target, request.action, false);
        break;
      }
      case "note": {
        // A note is a *record*, not a change: the member state is captured
        // unchanged on both sides, so `/history` shows it without pretending
        // something was applied. V5 automod uses it for a first trigger.
        before = this.captureState(target, request.action, false);
        after = before;
        details["automated"] = request.source === "automation";
        break;
      }
      case "timeout": {
        const until = new Date(Date.now() + (durationMs ?? 0));
        const result = await this.members.timeout(target, durationMs ?? 0, describeReason(request));
        this.assertOk(result, "apply the timeout");
        after = {
          ...this.captureState(target, request.action, false),
          timedOutUntil: until.toISOString(),
        };
        break;
      }
      case "untimeout": {
        if (target.timedOutUntil === null) {
          throw new ValidationError("That member is not timed out.");
        }
        const result = await this.members.removeTimeout(target, describeReason(request));
        this.assertOk(result, "remove the timeout");
        after = this.captureState(target, request.action, false);
        break;
      }
      case "kick": {
        const result = await this.members.kick(target, describeReason(request));
        this.assertOk(result, "kick the member");
        after = null;
        break;
      }
      case "ban": {
        const result = await this.members.ban(target, describeReason(request), {
          deleteMessageSeconds: 0,
        });
        this.assertOk(result, "ban the user");
        after = { ...this.captureState(target, request.action, true), banned: true };
        break;
      }
      case "unban": {
        if (!target.banned) {
          throw new ValidationError("That user is not banned from this server.");
        }
        const result = await this.members.unban(target, describeReason(request));
        this.assertOk(result, "lift the ban");
        relatedCaseNumber = await this.lastCaseNumber(guildId, target.id, "ban");
        after = { ...this.captureState(target, request.action, false), banned: false };
        break;
      }
      case "softban": {
        const banned = await this.members.ban(target, describeReason(request), {
          deleteMessageSeconds: SOFTBAN_DELETE_SECONDS,
        });
        this.assertOk(banned, "ban the user");
        const unbanned = await this.members.unban(target, "Softban: ban and immediate unban");
        this.assertOk(unbanned, "lift the ban");
        details["deleteMessageSeconds"] = SOFTBAN_DELETE_SECONDS;
        after = { ...this.captureState(target, request.action, false), banned: false };
        break;
      }
      case "mute":
      case "unmute": {
        const role = await this.members.muteRole();
        if (!role) {
          // `/mute` never creates a server's roles on its own: a moderator is told
          // exactly what is missing instead of watching a silent no-op. `/setup run`
          // is what provisions and reconciles the role.
          throw new ValidationError(
            "This server has no `Muted` role. Run `/setup run` to create it, or create a role named `Muted` that denies Send Messages in the channels it applies to, then try again.",
          );
        }
        const present = request.action === "mute";
        const result = await this.members.setRole(
          target,
          role.id,
          present,
          describeReason(request),
        );
        this.assertOk(result, present ? "apply the mute role" : "remove the mute role");
        details["muteRoleId"] = role.id;
        if (!present) {
          relatedCaseNumber = await this.lastCaseNumber(guildId, target.id, "mute");
        }
        after = { ...this.captureState(target, request.action, false), muted: present };
        break;
      }
      case "quarantine":
      case "unquarantine": {
        // Containment, not punishment: the member's roles are captured so a
        // later `unquarantine` (or the recovery sweep) restores exactly what was
        // taken. The role itself is the security module's `Quarantined` role,
        // reached through the same member port `/mute` uses.
        const role = await this.members.quarantineRole();
        if (!role) {
          throw new ValidationError(
            "This server has no `Quarantined` role. Create one, or enable the security module and run `/setup run`, then try again.",
          );
        }
        const present = request.action === "quarantine";
        details["quarantineRoleId"] = role.id;
        if (present) {
          details["removedRoleIds"] = target.roleIds.filter((roleId) => roleId !== role.id);
        } else {
          relatedCaseNumber = await this.lastCaseNumber(guildId, target.id, "quarantine");
        }
        const result = await this.members.setRole(
          target,
          role.id,
          present,
          describeReason(request),
        );
        this.assertOk(result, present ? "quarantine the member" : "lift the quarantine");
        after = { ...this.captureState(target, request.action, false) };
        break;
      }
      default: {
        throw new ValidationError(`${request.action} cannot be applied to a member.`);
      }
    }

    return this.finishMemberAction(guildId, config, request, {
      before,
      after,
      durationMs,
      details,
      relatedCaseNumber,
      notes,
    });
  }

  /**
   * Closes a member action: case, threshold, DM, then audit and log.
   *
   * The case is written first because it is the source of truth for "/history";
   * the audit event and the log line then carry its number, so an operator can
   * go from a log line to the case in one step.
   */
  private async finishMemberAction(
    guildId: string,
    config: GuildConfig["moderation"],
    request: ModerationRequest,
    parts: {
      readonly before: ModerationOutcome["before"];
      readonly after: ModerationOutcome["after"];
      readonly durationMs: number | null;
      readonly details: Record<string, unknown>;
      readonly relatedCaseNumber: number | null;
      readonly notes: string[];
    },
  ): Promise<ModerationOutcome> {
    const definition = moderationActionDefinition(request.action);
    const expiresAt =
      definition?.reversible === true && parts.durationMs !== null
        ? new Date(Date.now() + parts.durationMs)
        : null;

    const target = request.target;

    const record = await this.recordCase(guildId, request, {
      before: parts.before,
      after: parts.after,
      durationMs: parts.durationMs,
      expiresAt,
      details: {
        ...parts.details,
        ...(parts.durationMs === null ? {} : { durationMs: parts.durationMs }),
      },
      relatedCaseNumber: parts.relatedCaseNumber,
    });

    // The warning count is read after the case is written, so a warning counts
    // itself, and the threshold can never disagree with `/warnings`.
    const warned = request.action === "warn" || request.action === "unwarn";
    const warningCount =
      warned && target.type === "member" ? await this.warningCount(guildId, target.id) : undefined;
    const thresholdReached =
      warningCount !== undefined && this.thresholdReached(config, warningCount);

    if (config.dmOnPunishment) {
      const delivered = await this.deliverNotice(request, expiresAt);
      if (!delivered) {
        parts.notes.push("They could not be reached by direct message.");
      }
    }

    if (thresholdReached) {
      parts.notes.push(
        `That member now has ${warningCount} warning(s), which reaches this server's threshold of ${config.warnThreshold}. Consider a timeout or a ban.`,
      );
    }

    return {
      action: request.action,
      scope: definition?.scope ?? "member",
      targetId: target.id,
      caseNumber: record.caseNumber,
      case: record,
      thresholdReached,
      ...(warningCount === undefined ? {} : { warningCount }),
      before: parts.before,
      after: parts.after,
      notes: parts.notes,
    };
  }

  /** Executes a purge: count-bounded, author-filterable, one case for the sweep. */
  private async executePurge(
    guildId: string,
    request: ModerationRequest,
  ): Promise<ModerationOutcome> {
    if (request.target.type !== "channel") {
      throw new ValidationError("purge requires a channel target");
    }
    const count = request.count ?? 0;
    if (count < MODERATION_LIMITS.minPurgeCount || count > MODERATION_LIMITS.maxPurgeCount) {
      throw new ValidationError(
        `A purge removes between ${MODERATION_LIMITS.minPurgeCount} and ${MODERATION_LIMITS.maxPurgeCount} messages.`,
      );
    }

    const target = request.target;
    const removed = await this.members.purgeMessages(target.id, {
      limit: count,
      authorId: request.authorId ?? null,
      // Discord cannot bulk-delete a message older than two weeks, so the cut-off
      // makes the reported count provisional-free instead of silently partial.
      maxAgeMs: MODERATION_LIMITS.purgeMaxAgeMs,
      keepPinned: true,
    });

    const before: ModerationOutcome["before"] = null;
    const after: ModerationOutcome["after"] = null;
    const record = await this.recordCase(guildId, request, {
      before,
      after,
      durationMs: null,
      expiresAt: null,
      details: {
        source: request.source ?? "command",
        channelName: target.name,
        requested: count,
        removed: removed.removed,
        ...(request.authorId ? { authorId: request.authorId } : {}),
      },
      relatedCaseNumber: null,
    });

    return {
      action: "purge",
      scope: "message",
      targetId: target.id,
      caseNumber: record.caseNumber,
      case: record,
      thresholdReached: false,
      before,
      after,
      purgedCount: removed.removed,
      notes:
        removed.removed < count
          ? [
              `Removed ${removed.removed} of the ${count} requested: pinned messages and anything older than 14 days are kept.`,
            ]
          : [],
    };
  }

  /**
   * Writes the case and the audit event.
   *
   * The audit event is written for *every* action, with the same actor
   * provenance, so "who did this, and why" is answerable from either store, and
   * an automated action is never indistinguishable from a human one.
   */
  private async recordCase(
    guildId: string,
    request: ModerationRequest,
    parts: {
      readonly before: ModerationOutcome["before"];
      readonly after: ModerationOutcome["after"];
      readonly durationMs: number | null;
      readonly expiresAt: Date | null;
      readonly details: Record<string, unknown>;
      readonly relatedCaseNumber: number | null;
    },
  ): Promise<ModerationCaseRecord> {
    const definition = moderationActionDefinition(request.action);
    const targetTag = request.target.type === "member" ? request.target.tag : request.target.name;

    const record = await this.cases.append({
      guildId,
      action: request.action,
      actor: request.actor,
      target: request.target,
      reason: request.reason,
      durationMs: parts.durationMs,
      expiresAt: parts.expiresAt,
      before: parts.before,
      after: parts.after,
      details: parts.details,
      relatedCaseNumber: parts.relatedCaseNumber,
    });

    this.logger.info("Moderation action recorded", {
      guildId,
      action: request.action,
      caseNumber: record.caseNumber,
      moderatorId: request.actor.id,
      moderatorKind: request.actor.kind,
      targetId: request.target.id,
    });

    await this.audit.record({
      guildId,
      action: `moderation.${request.action}`,
      category: "moderation",
      // A privileged decision is louder in the operator's log stream; a ban is
      // exactly the kind of event an operator wants to see without grepping.
      severity: request.actor.kind === "god" ? "privileged" : "info",
      actorId: request.actor.id,
      actorKind: request.actor.kind,
      targetType: request.target.type === "member" ? "member" : "channel",
      targetId: request.target.id,
      outcome: "success",
      before: parts.before,
      after: parts.after,
      details: {
        ...parts.details,
        caseNumber: record.caseNumber,
        ...(parts.relatedCaseNumber === null ? {} : { relatedCaseNumber: parts.relatedCaseNumber }),
      },
    });

    if (this.log) {
      await this.log.record({
        guildId,
        action: request.action,
        label: definition?.label ?? request.action,
        caseNumber: record.caseNumber,
        actor: request.actor,
        targetId: request.target.id,
        targetTag,
        reason: request.reason,
        durationMs: parts.durationMs,
        expiresAt: parts.expiresAt,
      });
    }

    return record;
  }

  /**
   * Refuses a target that must never be punished through the bot.
   *
   * Four cases, each with its own reason because the fix differs:
   * - self-moderation, which is almost always a mistake and always a bad look;
   * - the guild owner or an administrator, whom Discord protects;
   * - the God Access account, per the platform's own rule that the operator is
   *   never caught by the automation;
   * - a member whose highest role is at or above the bot's, because Discord would
   *   refuse and reporting a success would be a lie.
   */
  private guardTarget(guildId: string, actor: ModerationActor, target: MemberTarget): void {
    if (target.id === actor.id) {
      throw new ValidationError("You cannot moderate yourself.");
    }
    if (!target.sameGuild) {
      throw new ValidationError("That member belongs to another server.");
    }
    if (target.protectedMember) {
      throw new ValidationError(
        "That member is the server owner or an administrator. Discord protects them from the bot; a higher authority must act manually.",
      );
    }
    if (isGodAccount(target.id)) {
      throw new ValidationError("That account is protected and cannot be moderated.");
    }
    if (
      target.highestRolePosition !== null &&
      target.highestRolePosition >= target.botHighestRolePosition
    ) {
      throw new ValidationError(
        "That member's highest role is at or above mine, so Discord would refuse. Move my role higher first.",
      );
    }
    // The acting guild is passed in explicitly so the guard is auditable: a
    // target whose guild does not match can never reach the Discord call.
    this.logger.debug("Moderation target accepted", { guildId, targetId: target.id });
  }

  /** Refuses an action that needs a reason and does not have one. */
  private guardReason(action: ModerationAction, reason: string | null): void {
    if (REASON_REQUIRED.includes(action) && (reason === null || reason.trim().length === 0)) {
      throw new ValidationError(`A reason is required for ${action}.`);
    }
    if (reason !== null && reason.length > MODERATION_LIMITS.maxReasonLength) {
      throw new ValidationError(
        `A reason may be at most ${MODERATION_LIMITS.maxReasonLength} characters.`,
      );
    }
  }

  /**
   * Validates and defaults a punishment duration.
   *
   * Bounds live here rather than in the command, so an automated caller cannot
   * ask for a 300-day timeout that Discord would reject anyway.
   */
  private resolveDuration(action: ModerationAction, durationMs: number | null): number | null {
    if (action === "timeout") {
      if (durationMs === null) {
        throw new ValidationError("A timeout requires a duration.");
      }
      if (
        durationMs < MODERATION_LIMITS.minTimeoutMs ||
        durationMs > MODERATION_LIMITS.maxTimeoutMs
      ) {
        throw new ValidationError(
          `A timeout lasts between ${MODERATION_LIMITS.minTimeoutMs / 1_000} seconds and 28 days.`,
        );
      }
      return durationMs;
    }
    if (action === "mute") {
      if (durationMs === null) {
        return null;
      }
      if (durationMs < MODERATION_LIMITS.minMuteMs || durationMs > MODERATION_LIMITS.maxMuteMs) {
        throw new ValidationError("A mute lasts between 1 minute and 365 days.");
      }
      return durationMs;
    }
    // A quarantine is a containment window, applied with the same `Quarantined`
    // role as `/security`'s raid response, so it obeys the mute bounds rather
    // than inventing a second set.
    if (action === "quarantine") {
      if (durationMs === null) {
        return null;
      }
      if (durationMs < MODERATION_LIMITS.minMuteMs || durationMs > MODERATION_LIMITS.maxMuteMs) {
        throw new ValidationError("A quarantine lasts between 1 minute and 365 days.");
      }
      return durationMs;
    }
    return null;
  }

  /** @returns true when the warning count has reached the configured threshold. */
  private thresholdReached(config: GuildConfig["moderation"], warningCount: number): boolean {
    // `0` means "no automatic threshold", which is why it is excluded rather than
    // treated as "everyone is already over it".
    return config.warnThreshold > 0 && warningCount >= config.warnThreshold;
  }

  /** Captures the member state stored as `before`/`after` on the case. */
  private captureState(
    target: MemberTarget,
    action: ModerationAction,
    banned: boolean,
  ): ModerationTargetState {
    const mutedByAction = action === "mute" ? true : action === "unmute" ? false : target.muted;
    const quarantineByAction =
      action === "quarantine" ? true : action === "unquarantine" ? false : target.quarantined;
    return {
      roleIds: [...target.roleIds],
      timedOutUntil: target.timedOutUntil?.toISOString() ?? null,
      muted: mutedByAction,
      quarantined: quarantineByAction,
      banned,
      tag: target.tag,
    };
  }

  /**
   * Refuses an action that would not change anything.
   *
   * `/mute` on a member who already holds the `Muted` role, `/unmute` on one who
   * does not, and `/timeout` on one who is already timed out past the requested
   * deadline all produced a *new case*, a new audit event and a new log line while
   * changing nothing. That noise is what made the case history unreadable: a
   * member's record filled up with pairs of actions that cancelled out. The check
   * runs before the Discord call, so a refusal leaves no trace at all.
   *
   * Only the idempotent member actions are covered. A ban on an already-banned
   * member, for instance, is still recorded because Discord reports it as an
   * error and the moderator needs to know the ban did not apply.
   */
  private async guardMemberState(request: ModerationRequest, target: MemberTarget): Promise<void> {
    if (
      request.action !== "mute" &&
      request.action !== "unmute" &&
      request.action !== "timeout" &&
      request.action !== "untimeout" &&
      request.action !== "quarantine" &&
      request.action !== "unquarantine"
    ) {
      return;
    }

    const state = await this.members.readState(target.id);
    if (!state) {
      // A member who left between parsing and acting is caught by the action
      // itself, which reports it with a better message than this guard could.
      return;
    }

    switch (request.action) {
      case "mute": {
        if (state.muted) {
          throw new ValidationError(
            `${target.tag} is already muted. Use \`/unmute\` first if you want to change the duration.`,
          );
        }
        return;
      }
      case "unmute": {
        if (!state.muted) {
          throw new ValidationError(`${target.tag} is not muted.`);
        }
        return;
      }
      case "timeout": {
        if (state.timedOutUntil !== null) {
          throw new ValidationError(
            `${target.tag} is already timed out until <t:${Math.floor(Date.parse(state.timedOutUntil) / 1_000)}:f>. Use \`/untimeout\` first to change it.`,
          );
        }
        return;
      }
      case "untimeout": {
        if (state.timedOutUntil === null) {
          throw new ValidationError(`${target.tag} is not timed out.`);
        }
        return;
      }
      case "quarantine": {
        if (state.quarantined) {
          throw new ValidationError(`${target.tag} is already quarantined.`);
        }
        return;
      }
      case "unquarantine": {
        if (!state.quarantined) {
          throw new ValidationError(`${target.tag} is not quarantined.`);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * @returns the warning case number to remove, or `null` when none qualifies.
   *
   * When `requested` is `null`, the oldest active warning is removed (the
   * historical behaviour a member expects from "clear one warning"). When a case
   * number is named, it must be one of the target's *active* warnings — an
   * already-cancelled warning (or a number that is not a `warn` at all) is
   * refused — so a moderator can remove an *older* warning by ID instead of being
   * forced oldest-first.
   *
   * Correctness note: "active" means a `warn` with no `unwarn` whose
   * `relatedCaseNumber` points at it. Comparing warning *case numbers* against
   * `unwarn` case numbers would be wrong — an `unwarn` is itself a numbered case,
   * and its number has no relation to the warning it cancels.
   */
  private async warnCaseToRemove(
    guildId: string,
    targetId: string,
    requested: number | null,
  ): Promise<number | null> {
    // Warning case numbers oldest-first (deterministic), and the `unwarn` records
    // so we can read which warning each one cancelled via `relatedCaseNumber`.
    const [warningNumbers, removals] = await Promise.all([
      this.cases.listNumbers(guildId, {
        targetId,
        action: "warn",
        limit: MODERATION_LIMITS.maxHistoryEntries,
      }),
      this.cases.list(guildId, {
        targetId,
        action: "unwarn",
        limit: MODERATION_LIMITS.maxHistoryEntries,
      }),
    ]);

    const cancelled = new Set(
      removals
        .map((record) => record.relatedCaseNumber)
        .filter((value): value is number => value !== null),
    );
    const active = warningNumbers.filter((caseNumber) => !cancelled.has(caseNumber));

    if (requested === null) {
      return active[0] ?? null;
    }

    if (!active.includes(requested)) {
      throw new ValidationError(`Case #${requested} is not an active warning for that member.`, {
        caseNumber: requested,
      });
    }
    return requested;
  }

  /** @returns the most recent case number of an action for a target, or `null`. */
  private async lastCaseNumber(
    guildId: string,
    targetId: string,
    action: ModerationAction,
  ): Promise<number | null> {
    const cases = await this.cases.list(guildId, { targetId, action, limit: 1 });
    return cases[0]?.caseNumber ?? null;
  }

  /** Sends the "you were punished" notice; `false` when it could not be sent. */
  private async deliverNotice(
    request: ModerationRequest,
    expiresAt: Date | null,
  ): Promise<boolean> {
    if (request.target.type !== "member") {
      return true;
    }
    const definition = moderationActionDefinition(request.action);
    const lines = [
      `You received a **${definition?.label ?? request.action}** in this server.`,
      request.reason ? `Reason: ${request.reason}` : null,
      expiresAt ? `It expires <t:${Math.floor(expiresAt.getTime() / 1_000)}:R>.` : null,
      "If you believe this was a mistake, contact the server's staff.",
    ].filter((line): line is string => line !== null);

    const result = await this.members.directMessage(request.target.id, lines.join("\n"));
    return result.ok;
  }

  /** Converts a failed Discord call into a user-facing validation error. */
  private assertOk(result: { ok: boolean; detail?: string }, what: string): void {
    if (!result.ok) {
      throw new ValidationError(result.detail ?? `I could not ${what}.`);
    }
  }
}

/** Softban message deletion window, in seconds (Discord's maximum is 604800). */
const SOFTBAN_DELETE_SECONDS = 7 * 24 * 60 * 60;

/** @returns the audit reason sent to Discord for an action. */
function describeReason(request: ModerationRequest): string {
  const actor = request.actor.tag ?? request.actor.id;
  const reason = request.reason?.trim();
  return reason && reason.length > 0 ? `${actor}: ${reason}` : actor;
}

/** @returns true when `userId` is the compiled-in God Access account. */
function isGodAccount(userId: string): boolean {
  // Read through the permission service's own list rather than re-declaring the
  // ID here, so there is still exactly one definition of the authority.
  return GOD_ACCESS_USER_IDS.includes(userId);
}
