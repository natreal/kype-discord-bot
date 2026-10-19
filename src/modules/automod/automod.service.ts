/**
 * Automod service: detect, escalate, delegate.
 *
 * This service is deliberately *not* a second moderation implementation. Its whole
 * job is to answer "should something happen to this member?" and, if so, to turn
 * that answer into a `ModerationRequest` and hand it to `ModerationService` —
 * which remains the only thing in the platform that can punish anybody.
 *
 * The consequences of that decision, all of them requirements rather than
 * niceties:
 *
 * - **one audit trail.** The action is recorded through `ModerationService`, so
 *   the audit event is `moderation.<action>` with `source: "automation"` in its
 *   details and an actor of kind `system`. There is no parallel `automod.mute`
 *   event an operator would have to know about, and no way for automod to act
 *   without an audit row — it cannot, because it has no Discord write access.
 * - **one permission model.** `ModerationService` applies `moderation.enabled`,
 *   the hierarchy guards and the duration bounds. Automod cannot widen them.
 * - **automod's own decisions are audited separately.** Detection, exemption and
 *   escalation *choice* are recorded as `automod.trigger` events, so "why did the
 *   bot warn this member?" is answerable even when automod chose to punish
 *   nobody, which a moderation case alone would not show.
 *
 * Exemptions live here rather than in the evaluator: a member automod cannot judge
 * is a *policy* of the service, and a `security.lockdown` holder is exempt so a
 * moderator explaining a rule in `#general` is not punished by the rule they are
 * explaining.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import type { GuildConfig } from "../../services/config/index.js";
import type { ModerationService } from "../moderation/moderation.service.js";
import { systemActor, type ModerationOutcome } from "../moderation/moderation.types.js";
import type { GuildMemberActions } from "../moderation/member-actions.js";
import { escalationDecision, type EscalationStep } from "./automod-escalation.js";
import { evaluate } from "./automod.evaluator.js";
import { automodRuleDefinition, type AutomodRule } from "./automod-rules.js";
import type { AutomodMatch, AutomodObservation } from "./automod.types.js";
import { SlidingWindow } from "./automod-window.js";

/** Name recorded as the actor of an automated action. */
export const AUTOMOD_ACTOR_ID = "automod";

/** Audit category for automod's own decisions. */
export const AUTOMOD_AUDIT_CATEGORY = "automod";

/** How many distinct authors automod tracks before evicting the oldest. */
const MAX_TRACKED_AUTHORS = 5_000;

/** What automod did, for the caller to render or log. */
export interface AutomodOutcome {
  readonly verdict: "clean" | "exempt" | "triggered";
  readonly exemptReason: "bot" | "owner" | "administrator" | "lockdown-holder" | null;
  readonly matches: readonly AutomodMatch[];
  /** The punishment executed through `ModerationService`, when there was one. */
  readonly moderation: ModerationOutcome | null;
  /** The action the ladder selected, for the confirmation line. */
  readonly action: EscalationStep["action"] | null;
  /** Total triggers this member has accumulated, from the case history. */
  readonly triggerCount: number;
  /** Non-fatal notes (DM not delivered, mute role missing, ...). */
  readonly notes: readonly string[];
}

/** Why automod refused to judge an author, beyond what the evaluator checks. */
export interface AutomodExemption {
  /** Discord permission check: does this member hold `security.lockdown`? */
  readonly holdsSecurityPermission: (guildId: string, userId: string) => Promise<boolean>;
}

export interface AutomodServiceOptions {
  readonly logger: Logger;
  readonly audit: AuditEventService;
  /** The one thing allowed to punish. Automod only ever *calls* it. */
  readonly moderation: ModerationService;
  /** Guild-bound automod settings, read per call. */
  readonly settings: (guildId: string) => Promise<GuildConfig["automod"]>;
  /** Moderation module switch, so automod can report a disabled module honestly. */
  readonly moderationEnabled: (guildId: string) => Promise<boolean>;
  /** Guard used to exempt the people who configure automod. */
  readonly exemption?: AutomodExemption;
  readonly members: GuildMemberActions;
}

export class AutomodService {
  private readonly logger: Logger;
  private readonly audit: AuditEventService;
  private readonly moderation: ModerationService;
  private readonly settings: AutomodServiceOptions["settings"];
  private readonly moderationEnabled: AutomodServiceOptions["moderationEnabled"];
  private readonly exemption: AutomodExemption | undefined;
  private readonly members: GuildMemberActions;
  /** One window per guild, sized by that guild's own `windowSeconds`. */
  private readonly windows = new Map<string, { window: SlidingWindow; windowMs: number }>();

  public constructor(options: AutomodServiceOptions) {
    this.logger = options.logger.child("automod");
    this.audit = options.audit;
    this.moderation = options.moderation;
    this.settings = options.settings;
    this.moderationEnabled = options.moderationEnabled;
    this.exemption = options.exemption;
    this.members = options.members;
  }

  /**
   * Judges one observation and acts on the verdict.
   *
   * Never throws: automod runs on the hot path of every message, and a rule that
   * fails must not take the message handler down with it.
   */
  public async observe(observation: AutomodObservation): Promise<AutomodOutcome> {
    try {
      return await this.judge(observation);
    } catch (error) {
      this.logger.error("Automod failed to judge an observation", {
        guildId: observation.guildId,
        authorId: observation.authorId,
        error: String(error),
      });
      return this.idle("clean", null);
    }
  }

  /** Clears a member's window, so a punished member starts from a clean slate. */
  public reset(guildId: string, authorId: string): void {
    this.windows.get(guildId)?.window.reset(authorId);
  }

  private async judge(observation: AutomodObservation): Promise<AutomodOutcome> {
    const config = await this.settings(observation.guildId);
    if (!config.enabled) {
      return this.idle("clean", null);
    }

    // The moderators who configure automod must not be its first victims, and a
    // member with `security.lockdown` is staff by definition.
    if (this.exemption && !observation.botAuthor) {
      const holds = await this.exemption.holdsSecurityPermission(
        observation.guildId,
        observation.authorId,
      );
      if (holds) {
        return this.idle("exempt", "lockdown-holder");
      }
    }

    const window = this.windowFor(observation.guildId, config.windowSeconds);
    const snapshot = window.record(observation);
    // A bounded map: a raid on a large server must not grow memory per author
    // forever, and the oldest author is the one least likely to still be active.
    if (window.size > MAX_TRACKED_AUTHORS) {
      window.evictOldest();
    }

    const verdict = evaluate(observation, config, snapshot);
    if (verdict.exemptReason !== null) {
      return this.idle("exempt", verdict.exemptReason);
    }
    if (verdict.clean) {
      return this.idle("clean", null);
    }

    const triggerCount = await this.triggerCount(observation.guildId, observation.authorId);
    const decision = escalationDecision(config.escalation, triggerCount);

    await this.audit.record({
      guildId: observation.guildId,
      action: "automod.trigger",
      category: AUTOMOD_AUDIT_CATEGORY,
      severity: decision.moderationAction === null ? "info" : "warn",
      actorId: AUTOMOD_ACTOR_ID,
      actorKind: "system",
      targetType: observation.kind === "message" ? "message" : "reaction",
      targetId: observation.messageId,
      outcome: "success",
      details: {
        rules: verdict.matches.map((match) => match.rule),
        observed: verdict.matches.map((match) => match.observed),
        channelId: observation.channelId,
        channelName: observation.channelName,
        authorId: observation.authorId,
        triggerCount,
        selectedAction: decision.action,
      },
    });

    const notes: string[] = [];
    let moderation: ModerationOutcome | null = null;
    const shouldRecord = decision.moderationAction !== null || config.warnOnFirstTrigger;
    if (shouldRecord) {
      // A ladder rung of `none` (or an empty ladder) still records the trigger as
      // a note when the server asked for it: an operator calibrating thresholds
      // wants the case, and a member who is not punished yet was promised one.
      const action = decision.moderationAction ?? "note";
      moderation = await this.escalate(
        observation,
        verdict.matches,
        action,
        decision.durationMs,
        triggerCount,
        notes,
      );
    }

    return {
      verdict: "triggered",
      exemptReason: null,
      matches: verdict.matches,
      moderation,
      action: decision.action,
      triggerCount,
      notes,
    };
  }

  /**
   * Executes the chosen action through the moderation service.
   *
   * A missing member (they left between the message and the action), a disabled
   * moderation module or a protected target is reported as a note rather than
   * thrown: the trigger is already recorded in the audit trail, and losing the
   * moderation case because the punishment could not be applied would be the
   * worst of both worlds.
   */
  private async escalate(
    observation: AutomodObservation,
    matches: readonly AutomodMatch[],
    action: NonNullable<ReturnType<typeof escalationDecision>["moderationAction"]>,
    durationMs: number | null,
    triggerCount: number,
    notes: string[],
  ): Promise<ModerationOutcome | null> {
    if (action !== "note" && !(await this.moderationEnabled(observation.guildId))) {
      notes.push(
        "Moderation is disabled in this server, so the trigger was recorded without a punishment.",
      );
    }

    const target = await this.members.readTarget(observation.guildId, observation.authorId);
    if (!target) {
      notes.push("The member left before the automated action could be applied.");
      return this.recordNote(observation, matches, triggerCount, action);
    }

    const reason = `${describeMatches(matches)} (trigger ${triggerCount})`;
    try {
      const outcome = await this.moderation.execute(observation.guildId, {
        action,
        // `system`, never `user`: an automated punishment must be
        // indistinguishable from a human one in *permissions*, and clearly
        // distinguishable from one in *provenance*.
        actor: systemActor(AUTOMOD_ACTOR_ID),
        target,
        reason: reason.slice(0, 500),
        ...(durationMs === null ? {} : { durationMs }),
        source: "automation",
      });
      notes.push(...outcome.notes);
      // The window is cleared only once an action actually landed: a rate rule
      // firing again during the punishment window would otherwise escalate the
      // same burst twice.
      this.reset(observation.guildId, observation.authorId);
      return outcome;
    } catch (error) {
      if (!notes.includes("The member left before the automated action could be applied.")) {
        notes.push(`Could not apply the automated action: ${errorText(error)}`);
      }
      return null;
    }
  }

  /**
   * Records "triggered, no punishment" as a `note` case.
   *
   * A note rather than a log line because `/history` is where a moderator looks
   * when a member asks "why was I warned?", and a trigger that left no trace
   * there is indistinguishable from a bug.
   */
  private async recordNote(
    observation: AutomodObservation,
    matches: readonly AutomodMatch[],
    triggerCount: number,
    intended: string,
  ): Promise<ModerationOutcome | null> {
    const target = await this.members.readTarget(observation.guildId, observation.authorId);
    if (!target) {
      return null;
    }
    try {
      return await this.moderation.execute(observation.guildId, {
        action: "note",
        actor: systemActor(AUTOMOD_ACTOR_ID),
        target,
        reason:
          `${describeMatches(matches)} — intended: ${intended} (trigger ${triggerCount})`.slice(
            0,
            500,
          ),
        source: "automation",
      });
    } catch (error) {
      this.logger.warn("Could not record an automod note", {
        guildId: observation.guildId,
        authorId: observation.authorId,
        error: String(error),
      });
      return null;
    }
  }

  /**
   * @returns how many times automod has already acted on this member.
   *
   * Read from the moderation case history rather than from an in-memory counter:
   * the count therefore survives a restart, and it cannot disagree with what
   * `/history` shows a moderator.
   */
  private async triggerCount(guildId: string, authorId: string): Promise<number> {
    const cases = await this.moderation.history(guildId, { targetId: authorId, limit: 100 });
    return cases.filter((record) => record.moderatorId === AUTOMOD_ACTOR_ID).length + 1;
  }

  /** @returns the guild's window, rebuilt when its configured length changed. */
  private windowFor(guildId: string, windowSeconds: number): SlidingWindow {
    const windowMs = windowSeconds * 1_000;
    const existing = this.windows.get(guildId);
    if (existing && existing.windowMs === windowMs) {
      return existing.window;
    }
    // A changed window length resets the bucket: mixing two window lengths would
    // make "5 messages in 10s" mean two different things inside one guild.
    const window = new SlidingWindow({ windowMs });
    this.windows.set(guildId, { window, windowMs });
    return window;
  }

  private idle(
    verdict: "clean" | "exempt",
    reason: AutomodOutcome["exemptReason"],
  ): AutomodOutcome {
    return {
      verdict,
      exemptReason: reason,
      matches: [],
      moderation: null,
      action: null,
      triggerCount: 0,
      notes: [],
    };
  }
}

/** @returns a short, log-safe description of what fired. */
export function describeMatches(matches: readonly AutomodMatch[]): string {
  return matches
    .map((match) => `${automodRuleDefinition(match.rule)?.label ?? match.rule}: ${match.detail}`)
    .join(" · ");
}

/** @returns the user-safe text of an error, without an internals leak. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AutomodRule, AutomodMatch };
