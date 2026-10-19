/**
 * Security service: anti-raid, anti-nuke, lockdown and recovery.
 *
 * The three V5 requirements this file exists to satisfy:
 *
 * 1. **A nuke is stopped in flight, not merely logged.** When `detectNuke()` trips,
 *    the responsible account's roles are stripped immediately, before the next
 *    destructive call. Logging first and acting after would let the nuke finish.
 * 2. **The author is never banned automatically.** They are de-permissioned and
 *    escalated to a human, per the brief: an automated ban of a compromised
 *    administrator is irreversible in the wrong direction.
 * 3. **A lockdown is reversible without a human remembering.** Every episode is
 *    persisted with an `expiresAt`; `recoverGuild()` lifts the lockdown when the
 *    window has passed, and `/security unlock` lifts it on demand for a holder of
 *    `security.lockdown`.
 *
 * Containment of *members* goes through `ModerationService` (quarantine), so the
 * ban on duplicating sanction logic holds: this module decides *who* and *when*,
 * never *how*.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import type { GuildConfig } from "../../services/config/index.js";
import type { ModerationService } from "../moderation/moderation.service.js";
import { systemActor } from "../moderation/moderation.types.js";
import type { GuildMemberActions } from "../moderation/member-actions.js";
import {
  detectNuke,
  isWhitelisted,
  type NukeActionObservation,
  type NukeVerdict,
} from "./anti-nuke.detector.js";
import { detectRaid, type RaidJoinObservation, type RaidVerdict } from "./anti-raid.detector.js";
import type {
  NukeEpisode,
  RaidEpisode,
  SecurityIncident,
  SecurityIncidentRepository,
  SecurityLogPort,
} from "./security.types.js";

/** Name recorded as the actor of an automated containment action. */
export const SECURITY_ACTOR_ID = "security";

/** Audit category for security's own decisions. */
export const SECURITY_AUDIT_CATEGORY = "security";

/** How many joins and audit entries are remembered per guild. */
const MAX_TRACKED_ENTRIES = 500;

/** Discord operations the security module needs, kept behind one port. */
export interface GuildSecurityActions {
  /** Locks every text channel for `@everyone`, returning what changed. */
  lock(reason: string): Promise<{
    readonly ok: boolean;
    readonly changed: readonly string[];
    readonly detail?: string;
  }>;
  /** Restores the channels a lockdown changed. */
  unlock(reason: string): Promise<{
    readonly ok: boolean;
    readonly changed: readonly string[];
    readonly detail?: string;
  }>;
  /** @returns the guild's quarantine role, or `null` when it has none. */
  quarantineRole(): Promise<{ id: string; name: string; position: number } | null>;
  /**
   * @returns the guild's mute role, or `null` when it has none.
   *
   * Containment must not lift a moderator's mute as a side effect: the keep-list for
   * a role strip needs the Muted role too, and reading it here keeps security from
   * hardcoding a role name that moderation owns.
   */
  muteRole(): Promise<{ id: string; name: string; position: number } | null>;
  /** @returns the guild owner's ID. */
  ownerId(): string;
  /** @returns the bot's own user ID, so its own audit entries are ignored. */
  botId(): string;
  /** @returns role IDs of a member, used to tell "already contained" from "not". */
  roleIdsOf(userId: string): Promise<readonly string[]>;
}

export interface SecurityServiceOptions {
  readonly logger: Logger;
  readonly audit: AuditEventService;
  /** The only thing allowed to quarantine. */
  readonly moderation: ModerationService;
  readonly members: GuildMemberActions;
  /** Guild-bound Discord containment operations. */
  readonly actions: GuildSecurityActions;
  /** Per-call reader of the guild's `security` section. */
  readonly settings: (guildId: string) => Promise<GuildConfig["security"]>;
  /** Per-call reader of the guild's `automod`+`moderation` switches. */
  readonly moderationEnabled: (guildId: string) => Promise<boolean>;
  readonly incidents: SecurityIncidentRepository;
  readonly log: SecurityLogPort;
  /** Injected clock, so a test controls "now" without faking timers. */
  readonly now?: () => number;
}

export class SecurityService {
  private readonly logger: Logger;
  private readonly audit: AuditEventService;
  private readonly moderation: ModerationService;
  private readonly members: GuildMemberActions;
  private readonly actions: GuildSecurityActions;
  private readonly settings: SecurityServiceOptions["settings"];
  private readonly moderationEnabled: SecurityServiceOptions["moderationEnabled"];
  private readonly incidents: SecurityIncidentRepository;
  private readonly log: SecurityLogPort;
  private readonly now: () => number;
  /** Join history per guild, oldest first. Bounded by `MAX_TRACKED_ENTRIES`. */
  private readonly joins = new Map<string, RaidJoinObservation[]>();
  /** Destructive-action history per guild, keyed by actor. */
  private readonly nukeActions = new Map<string, NukeActionObservation[]>();

  public constructor(options: SecurityServiceOptions) {
    this.logger = options.logger.child("security");
    this.audit = options.audit;
    this.moderation = options.moderation;
    this.members = options.members;
    this.actions = options.actions;
    this.settings = options.settings;
    this.moderationEnabled = options.moderationEnabled;
    this.incidents = options.incidents;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
  }

  /** @returns the guild's security configuration, for `/security status`. */
  public config(guildId: string): Promise<GuildConfig["security"]> {
    return this.settings(guildId);
  }

  /** @returns the guild's active incidents, oldest first. */
  public activeIncidents(guildId: string): Promise<SecurityIncident[]> {
    return this.incidents.listActive(guildId);
  }

  /**
   * Judges one join and reacts when it belongs to a raid.
   *
   * Never throws: a join happens on the Discord gateway, and a security failure
   * must not turn a raid into a gateway error that hides it.
   */
  public async observeJoin(observation: RaidJoinObservation): Promise<RaidEpisode | null> {
    try {
      return await this.judgeJoin(observation);
    } catch (error) {
      this.logger.error("Anti-raid failed to judge a join", {
        guildId: observation.guildId,
        userId: observation.userId,
        error: String(error),
      });
      return null;
    }
  }

  private async judgeJoin(observation: RaidJoinObservation): Promise<RaidEpisode | null> {
    const config = await this.settings(observation.guildId);
    if (!config.enabled || !config.antiRaid.enabled) {
      return null;
    }

    const windowMs = config.antiRaid.windowSeconds * 1_000;
    const history = (this.joins.get(observation.guildId) ?? []).filter(
      (join) => observation.joinedAtMs - join.joinedAtMs < windowMs,
    );
    const verdict = detectRaid(history, observation, config.antiRaid);
    history.push(observation);
    while (history.length > MAX_TRACKED_ENTRIES) {
      history.shift();
    }
    this.joins.set(observation.guildId, history);

    // A member who joins during a verification window is contained even when the
    // burst threshold was not crossed: `verifyNewMembers` is a standing policy,
    // not a reaction to this particular verdict.
    const verify =
      config.antiRaid.verifyNewMembers && (observation.isNewAccount || verdict.likelyRaid);
    if (!verdict.likelyRaid && !verify) {
      if (verdict.burst) {
        await this.report({
          guildId: observation.guildId,
          action: "security.raid-watch",
          severity: "warning",
          summary: `Join rate elevated: ${verdict.detail}`,
          actorId: observation.userId,
          actorTag: observation.userTag,
          at: new Date(observation.joinedAtMs),
          response:
            "No action: the burst carries no raid signature (new accounts, suspicious names).",
          details: { joinsInWindow: verdict.joinsInWindow, windowSeconds: verdict.windowSeconds },
        });
      }
      return null;
    }

    return this.containRaid(observation, verdict, config);
  }

  /**
   * Contains a raid: quarantine the suspects, optionally lock the server down.
   *
   * The lockdown is the *guild-wide* response and is only applied when the
   * configuration asks for it, because locking a large server for a false positive
   * is expensive: everyone notices. Quarantining the suspects is the narrow
   * response and always happens when the burst carries a raid signature.
   */
  private async containRaid(
    observation: RaidJoinObservation,
    verdict: RaidVerdict,
    config: GuildConfig["security"],
  ): Promise<RaidEpisode> {
    const now = this.now();
    const existing = await this.incidents.active(observation.guildId, "raid");

    // Only the accounts that carry a signature are contained: an established
    // account that happened to join during the burst is left alone, because
    // punishing them is exactly the false positive that makes servers disable
    // anti-raid entirely.
    const suspects = [
      ...new Set([...verdict.newAccountIds, ...verdict.suspiciousNameIds, observation.userId]),
    ].filter(
      (userId) =>
        verdict.newAccountIds.includes(userId) ||
        verdict.suspiciousNameIds.includes(userId) ||
        userId === observation.userId,
    );

    const quarantinedIds = await this.quarantine(observation.guildId, suspects, verdict);

    const lockdown =
      config.antiRaid.lockdownOnRaid &&
      !(existing?.details as { lockdown?: boolean } | null)?.lockdown;
    let locked =
      existing !== null && Boolean((existing.details as { lockdown?: boolean } | null)?.lockdown);
    if (lockdown) {
      locked = await this.setLockdown(
        observation.guildId,
        true,
        `Raid detected: ${verdict.detail}`,
      );
    }

    const expiresAt = new Date(now + config.antiRaid.raidModeSeconds * 1_000);
    const incident =
      existing ??
      (await this.incidents.open({
        guildId: observation.guildId,
        kind: "raid",
        summary: `Raid detected: ${verdict.detail}`,
        details: { verdict, lockdown: locked },
        targetedIds: quarantinedIds,
        expiresAt,
      }));

    await this.audit.record({
      guildId: observation.guildId,
      action: "security.raid-detected",
      category: SECURITY_AUDIT_CATEGORY,
      severity: "privileged",
      actorId: SECURITY_ACTOR_ID,
      actorKind: "system",
      targetType: "guild",
      targetId: observation.guildId,
      outcome: "success",
      before: { lockdown: false, quarantined: 0 },
      after: { lockdown: locked, quarantined: quarantinedIds.length },
      details: {
        joinsInWindow: verdict.joinsInWindow,
        windowSeconds: verdict.windowSeconds,
        incidentId: incident.id,
        quarantinedIds,
      },
    });

    await this.report({
      guildId: observation.guildId,
      action: "security.raid-detected",
      severity: "critical",
      summary: `Raid detected — ${verdict.likelyRaid ? "burst with raid signatures" : "verification policy"}`,
      actorId: observation.userId,
      actorTag: observation.userTag,
      at: new Date(observation.joinedAtMs),
      target: `guild:${observation.guildId}`,
      before: `${verdict.joinsInWindow - 1} join(s) in the window`,
      after: `${verdict.joinsInWindow} join(s) in ${verdict.windowSeconds}s`,
      response: [
        quarantinedIds.length > 0
          ? `${quarantinedIds.length} account(s) quarantined`
          : "no account quarantined",
        locked ? "server locked down" : "no lockdown",
        `recovery at <t:${Math.floor(expiresAt.getTime() / 1_000)}:R>`,
      ].join(", "),
      details: {
        newAccounts: verdict.newAccountIds.length,
        suspiciousNames: verdict.suspiciousNameIds.length,
        joinsInWindow: verdict.joinsInWindow,
      },
    });

    return { incident, verdict, quarantinedIds, lockdown: locked };
  }

  /**
   * Judges one destructive action and stops the account responsible.
   *
   * Never throws: this runs on the audit-log event, where a failure would be
   * invisible and would leave a nuke running.
   */
  public async observeNukeAction(observation: NukeActionObservation): Promise<NukeEpisode | null> {
    try {
      return await this.judgeNuke(observation);
    } catch (error) {
      this.logger.error("Anti-nuke failed to judge an action", {
        actorId: observation.actorId,
        kind: observation.kind,
        error: String(error),
      });
      return null;
    }
  }

  private async judgeNuke(observation: NukeActionObservation): Promise<NukeEpisode | null> {
    const config = await this.settings(observation.guildId);
    if (!config.enabled || !config.antiNuke.enabled) {
      return null;
    }
    if (
      isWhitelisted(observation.actorId, {
        ownerId: this.actions.ownerId(),
        botId: this.actions.botId(),
        whitelistUserIds: config.antiNuke.whitelistUserIds,
      })
    ) {
      return null;
    }

    const windowMs = config.antiNuke.windowSeconds * 1_000;
    const key = `${observation.guildId}:${observation.actorId}`;
    const history = (this.nukeActions.get(key) ?? []).filter(
      (action) => observation.atMs - action.atMs < windowMs,
    );
    const verdict = detectNuke(history, observation, config.antiNuke);
    history.push(observation);
    while (history.length > MAX_TRACKED_ENTRIES) {
      history.shift();
    }
    this.nukeActions.set(key, history);

    if (!verdict.detected) {
      return null;
    }

    // Stopped here, before the next call. The roles come off first and the log
    // line is written after, because logging first would hand the account one more
    // destructive action for free.
    const stripped = config.antiNuke.stripPermissions
      ? await this.stripPermissions(observation, verdict)
      : { ok: false, removed: [], detail: "permission stripping is disabled" };

    const expiresAt = null;
    const incident = await this.incidents.open({
      guildId: observation.guildId,
      kind: "nuke",
      summary: `Nuke stopped: ${stripped.removed.length} role(s) removed from ${observation.actorTag ?? observation.actorId}`,
      details: { verdict, action: observation.kind, strippedRoleIds: stripped.removed },
      targetedIds: [observation.actorId],
      expiresAt,
    });

    await this.audit.record({
      guildId: observation.guildId,
      action: "security.nuke-detected",
      category: SECURITY_AUDIT_CATEGORY,
      severity: "privileged",
      actorId: observation.actorId,
      actorKind: "user",
      targetType: "member",
      targetId: observation.actorId,
      outcome: "success",
      before: { roleIds: "as held" },
      after: { roleIds: stripped.removed, removed: stripped.removed.length },
      details: {
        action: observation.kind,
        weight: verdict.weight,
        actions: verdict.actions,
        incidentId: incident.id,
        escalation: config.antiNuke.escalateToOwner,
      },
    });

    await this.report({
      guildId: observation.guildId,
      action: "security.nuke-detected",
      severity: "critical",
      summary: "Mass destructive action stopped",
      actorId: observation.actorId,
      actorTag: observation.actorTag,
      at: new Date(observation.atMs),
      target: observation.targetId
        ? `${observation.kind}:${observation.targetName ?? observation.targetId}`
        : observation.kind,
      before: `${verdict.actions - 1} destructive action(s) in ${verdict.windowSeconds}s`,
      after: verdict.detail,
      response: [
        stripped.ok
          ? `${stripped.removed.length} role(s) removed from the account`
          : `permissions NOT removed (${stripped.detail ?? "unknown reason"})`,
        config.antiNuke.escalateToOwner ? "owner alerted — review required" : null,
        "the account was NOT banned automatically",
      ]
        .filter((line): line is string => line !== null)
        .join(", "),
      details: {
        weight: verdict.weight,
        actions: verdict.actions,
        removedRoles: stripped.removed.length,
      },
    });

    return {
      incident,
      verdict,
      action: observation.kind,
      actorId: observation.actorId,
      strippedRoleIds: stripped.removed,
    };
  }

  /**
   * Quarantines suspect accounts through the moderation module.
   *
   * The sanction is a `quarantine` — a real moderation action with a real case —
   * precisely so that a raid response shows up in `/history` like any other action,
   * and so the quarantine can be lifted with `/unquarantine` without this module
   * having to own a second undo path.
   */
  private async quarantine(
    guildId: string,
    userIds: readonly string[],
    verdict: RaidVerdict,
  ): Promise<string[]> {
    const quarantined: string[] = [];

    // Quarantine is a moderation action, so it obeys `moderation.enabled`. When the
    // server has it off, the raid is reported and the lockdown still applies, but
    // the accounts are not contained: silently containing them would contradict the
    // switch, and silently *not* reporting it would hide the gap.
    const allowed = await this.moderationEnabled(guildId);
    if (userIds.length > 0 && !allowed) {
      await this.report({
        guildId,
        action: "security.quarantine-skipped",
        severity: "warning",
        summary: "Raid containment skipped: moderation is disabled",
        response:
          "No account was quarantined. Enable moderation so the security module can contain raid accounts.",
        details: { accounts: userIds.length },
      });
      return quarantined;
    }

    for (const userId of userIds) {
      const target = await this.members.readTarget(guildId, userId);
      // Already contained, or gone: re-quarantining would write a second case for
      // the same person on every join of the same burst.
      if (!target || target.quarantined) {
        continue;
      }
      try {
        await this.moderation.execute(guildId, {
          action: "quarantine",
          actor: systemActor(SECURITY_ACTOR_ID),
          target,
          reason: `Anti-raid: ${verdict.detail}`,
          source: "automation",
        });
        quarantined.push(userId);
      } catch (error) {
        // A protected target (owner, administrator) or a missing `Quarantined`
        // role must not abort the containment of the accounts that *can* be
        // contained, so this is reported rather than thrown.
        await this.report({
          guildId,
          action: "security.quarantine-failed",
          severity: "warning",
          summary: "Could not quarantine an account",
          actorId: userId,
          response: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return quarantined;
  }

  /**
   * Removes the authority of a nuking account.
   *
   * Roles the guild considers staff (`whitelistRoleIds`) and the managed ones are
   * kept: stripping a support role does not stop a nuke, and stripping a bot's
   * managed role would break the account rather than the attack.
   */
  private async stripPermissions(
    observation: NukeActionObservation,
    verdict: NukeVerdict,
  ): Promise<{
    readonly ok: boolean;
    readonly removed: readonly string[];
    readonly detail?: string;
  }> {
    const config = await this.settings(observation.guildId);
    const target = await this.members.readTarget(observation.guildId, observation.actorId);
    if (!target) {
      return { ok: false, removed: [], detail: "the account already left the server" };
    }

    // The quarantine role is applied first when the guild has one: it is what keeps
    // the account reachable and visibly contained instead of merely role-less.
    const quarantineRole = await this.actions.quarantineRole();
    const keepRoleIds = [
      ...config.antiNuke.whitelistRoleIds,
      ...(quarantineRole ? [quarantineRole.id] : []),
    ];

    // A quarantine must not silently lift a mute. Without this, an anti-nuke run on an
    // already-muted account removed the Muted role, so the punishment the moderators
    // had applied ended as a side effect of a security action that never mentioned it.
    const muteRole = await this.actions.muteRole();
    if (muteRole) {
      keepRoleIds.push(muteRole.id);
    }

    const result = await this.members.stripRoles(target, {
      keepRoleIds,
      reason: `Anti-nuke: ${verdict.detail}`,
    });

    if (result.ok && quarantineRole) {
      // Best-effort: the role removal above is the containment, this is the label.
      await this.members
        .setRole(target, quarantineRole.id, true, `Anti-nuke containment`)
        .catch(() => undefined);
    }

    return result;
  }

  /**
   * Applies or lifts a lockdown, and reports what changed.
   *
   * A lockdown is *idempotent by measurement*: `lock()` reports the channels it
   * actually changed, so a second lockdown during the same raid changes nothing and
   * the log line says so instead of implying a second lockdown happened.
   *
   * @param actorId who asked for it; `"security"` when the module decided alone
   */
  public async setLockdown(
    guildId: string,
    locked: boolean,
    reason: string,
    actorId = SECURITY_ACTOR_ID,
  ): Promise<boolean> {
    const config = await this.settings(guildId);
    if (!config.enabled && locked) {
      // A *manual* unlock must stay possible with the module disabled: refusing it
      // would leave a server locked down because someone turned a switch off.
      return false;
    }

    const result = locked ? await this.actions.lock(reason) : await this.actions.unlock(reason);

    await this.audit.record({
      guildId,
      action: locked ? "security.lockdown" : "security.unlock",
      category: SECURITY_AUDIT_CATEGORY,
      severity: "privileged",
      actorId,
      actorKind: actorId === SECURITY_ACTOR_ID ? "system" : "user",
      targetType: "guild",
      targetId: guildId,
      outcome: result.ok ? "success" : "failure",
      before: { lockdown: !locked },
      after: { lockdown: locked, channels: result.changed.length },
      details: {
        reason,
        channels: result.changed,
        ...(result.detail ? { detail: result.detail } : {}),
      },
    });

    await this.report({
      guildId,
      action: locked ? "security.lockdown" : "security.unlock",
      severity: locked ? "critical" : "info",
      summary: locked ? "Server locked down" : "Server unlocked",
      actorId,
      before: locked ? "channels writable" : "channels locked",
      after: locked ? "channels locked" : "channels writable",
      response: result.ok
        ? `${result.changed.length} channel(s) updated`
        : `could not complete: ${result.detail ?? "unknown error"}`,
      details: { reason, channels: result.changed.length },
    });

    // @returns whether the requested *state* is now in force, so an unlock reports
    // success too — returning `locked` here would make every `/security unlock`
    // claim to have failed.
    return result.ok;
  }

  /**
   * Lifts every lockdown whose threat window has passed.
   *
   * This is the automatic recovery half of the brief. It is driven by the
   * persisted `expiresAt` rather than by a timer, so a restart during a raid does
   * not leave the server locked down forever — the next sweep of any guild finds
   * the expired incident and unlocks it.
   *
   * @returns the incidents recovered
   */
  public async recoverExpired(): Promise<SecurityIncident[]> {
    const expired = await this.incidents.listExpired(new Date(this.now()));
    const recovered: SecurityIncident[] = [];
    for (const incident of expired) {
      const resolved = await this.recover(incident.guildId, incident.id, "automatic expiry");
      if (resolved) {
        recovered.push(resolved);
      }
    }
    return recovered;
  }

  /** Resolves one incident and restores the guild, whoever asked for it. */
  public async recover(
    guildId: string,
    incidentId: string,
    resolvedBy: string,
  ): Promise<SecurityIncident | null> {
    const active = await this.incidents.listActive(guildId);
    const incident = active.find((candidate) => candidate.id === incidentId);
    if (!incident) {
      return null;
    }

    if (incident.kind === "raid") {
      await this.setLockdown(guildId, false, `Recovery: ${incident.summary}`, resolvedBy);
    }

    const resolved = await this.incidents.resolve(incident.id, resolvedBy);
    if (!resolved) {
      return null;
    }

    await this.audit.record({
      guildId,
      action: "security.recovered",
      category: SECURITY_AUDIT_CATEGORY,
      severity: "info",
      actorId: resolvedBy,
      actorKind: resolvedBy === "automatic expiry" ? "system" : "user",
      targetType: "guild",
      targetId: guildId,
      outcome: "success",
      before: { status: "active", kind: incident.kind },
      after: { status: "resolved" },
      details: { incidentId: incident.id, summary: incident.summary },
    });

    await this.report({
      guildId,
      action: "security.recovered",
      severity: "info",
      summary: `Threat window over — ${incident.kind} recovery`,
      actorId: resolvedBy === "automatic expiry" ? null : resolvedBy,
      before: `${incident.kind} containment active`,
      after: "server restored",
      response:
        incident.kind === "raid"
          ? "lockdown lifted"
          : "account permissions remain stripped until reviewed",
      details: { incidentId: incident.id },
    });

    return resolved;
  }

  /**
   * Unlocks on demand, for a holder of `security.lockdown`.
   *
   * Takes the actor so the audit trail names the human who decided the threat was
   * over, rather than attributing the decision to the module.
   */
  public async unlockByOperator(
    guildId: string,
    actorId: string,
    reason: string,
  ): Promise<{ readonly unlocked: boolean; readonly incidents: readonly SecurityIncident[] }> {
    const active = (await this.incidents.listActive(guildId)).filter(
      (incident) => incident.kind === "raid",
    );
    const unlocked = await this.setLockdown(guildId, false, reason, actorId);
    const resolved: SecurityIncident[] = [];
    for (const incident of active) {
      const record = await this.recover(guildId, incident.id, actorId);
      if (record) {
        resolved.push(record);
      }
    }
    return { unlocked, incidents: resolved };
  }

  /**
   * Delivers one security log line.
   *
   * Never throws: the security log is where an operator *diagnoses* a raid, and a
   * missing channel must not be able to stop the containment itself.
   */
  private async report(event: Parameters<SecurityLogPort["record"]>[0]): Promise<void> {
    try {
      await this.log.record(event);
    } catch (error) {
      this.logger.warn("Could not deliver a security log line", {
        guildId: event.guildId,
        action: event.action,
        error: String(error),
      });
    }
  }
}
