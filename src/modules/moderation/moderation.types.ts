/**
 * Moderation contracts.
 *
 * These types are the seam that makes moderation callable from three very
 * different places — a slash command, a future automated source (automod) and a
 * future AI assistant — without any of them having to know about discord.js
 * interactions:
 *
 *   ModerationActor   who is acting, and on whose behalf
 *   ModerationTarget  who/what is acted upon, with the member state we need
 *   ModerationOutcome what happened, and which case recorded it
 *
 * A command therefore builds an actor from the interaction and calls the service;
 * an automated caller builds an actor with `kind: "system"`. Nothing else differs.
 */
import type { ModerationAction, ModerationScope } from "./moderation-actions.js";
import type { Permission } from "../../services/authorization/permissions.js";
import type { ModerationCaseRecord, ModerationTargetState } from "./moderation-case.repository.js";

/**
 * Who is performing the action.
 *
 * `kind` mirrors the audit trail's actor vocabulary (`user`, `system`, `god`) so
 * one action produces one provenance in every store, and so an automated action
 * is never mistaken for a human one in the log channel or in `/history`.
 */
export interface ModerationActor {
  readonly id: string;
  readonly kind: "user" | "system" | "god";
  /** Display handle, used in log output. `null` for a non-Discord actor. */
  readonly tag?: string | null;
}

/** Builds an actor for a Discord user, marking the God Access account. */
export function userActor(id: string, tag: string | null, isGod: boolean): ModerationActor {
  return { id, kind: isGod ? "god" : "user", tag };
}

/** Builds the actor for an automated action (automod, scheduled work). */
export function systemActor(name: string): ModerationActor {
  return { id: name, kind: "system", tag: `system:${name}` };
}

/**
 * What an action is applied to.
 *
 * A member target carries the state the Discord call needs (roles, ban state,
 * timeout) so a single service call can enforce the hierarchy rules and produce
 * the before/after payload of the case without re-reading the member.
 */
export interface MemberTarget {
  readonly type: "member";
  readonly id: string;
  /** Display handle for user-facing text. */
  readonly tag: string;
  /** Whether the member is currently in the guild (false for a ban by ID). */
  readonly present: boolean;
  /** True when the target belongs to the guild the action is executed in. */
  readonly sameGuild: boolean;
  /** Guild owner / Administrator / God Access: never punishable through the bot. */
  readonly protectedMember: boolean;
  /** Discord permission bitfield of the *bot*, for hierarchy comparisons. */
  readonly botPermissions: bigint;
  /** Highest role position of the target, `null` when not a guild member. */
  readonly highestRolePosition: number | null;
  /** Highest role position of the bot in this guild. */
  readonly botHighestRolePosition: number;
  /** Current timeout expiry, when the member is timed out. */
  readonly timedOutUntil: Date | null;
  /** True when the member holds the mute role, when a mute role is configured. */
  readonly muted: boolean;
  /** True when the member holds the security module's quarantine role. */
  readonly quarantined: boolean;
  /** True when the member already holds the Discord ban flag. */
  readonly banned: boolean;
  /** Role IDs that a mute must remove and restore, declared by the caller. */
  readonly roleIds: readonly string[];
}

/** A purge is applied to a channel, not a member. */
export interface ChannelTarget {
  readonly type: "channel";
  readonly id: string;
  readonly name: string;
}

export type ModerationTarget = MemberTarget | ChannelTarget;

/**
 * What a caller asks the service to do.
 *
 * Deliberately a plain data record: it can be built from a slash command, from an
 * event handler or by a future AI tool call.
 */
export interface ModerationRequest {
  readonly action: ModerationAction;
  readonly actor: ModerationActor;
  readonly target: ModerationTarget;
  readonly reason: string | null;
  /** Punishment length in milliseconds, for temporary actions. */
  readonly durationMs?: number | null;
  /** For `purge`: how many messages to remove. */
  readonly count?: number | null;
  /** For `purge`: restrict the sweep to one author. */
  readonly authorId?: string | null;
  /**
   * For `unwarn`: the case number of the specific warning to remove.
   *
   * When omitted (or `null`), the oldest active warning is removed, preserving
   * the historical behaviour. A caller that names a case number that is not an
   * active `warn` for the target is refused, so a moderator can remove an
   * *older* warning without being forced oldest-first.
   */
  readonly caseNumber?: number | null;
  /**
   * Provenance of the call, recorded on the case.
   *
   * `command` is a human using a slash command; `automation` and `ai` are
   * reserved for the phases after V4 and are recorded verbatim, so a future
   * operator can tell why a member was punished.
   */
  readonly source?: "command" | "automation" | "ai";
}

/** What the service returns to its caller. */
export interface ModerationOutcome {
  readonly action: ModerationAction;
  readonly scope: ModerationScope;
  readonly targetId: string | null;
  /** `case #` assigned to the action. */
  readonly caseNumber: number;
  /** Persisted case, echoed so the caller can render or audit it. */
  readonly case: ModerationCaseRecord;
  /** True when the action crossed the configured warning threshold. */
  readonly thresholdReached: boolean;
  /** The warning count after the action, for `warn` and `unwarn`. */
  readonly warningCount?: number;
  /** Member state captured before and after the action. */
  readonly before: ModerationTargetState | null;
  readonly after: ModerationTargetState | null;
  /** Message count actually removed, for `purge`. */
  readonly purgedCount?: number;
  /** Non-fatal notes (DM could not be delivered, mute role missing, ...). */
  readonly notes: readonly string[];
}

/** Permission set a moderation action requires, as the authorization layer wants it. */
export interface ModerationPermissionRequirement {
  readonly custom: readonly Permission[];
}
