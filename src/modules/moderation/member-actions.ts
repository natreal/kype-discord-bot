/**
 * Member-level Discord operations required by moderation.
 *
 * The platform had no such abstraction: `Setuper` creates channels and roles, and
 * `PermissionService` answers authorization questions, but nothing could act *on a
 * member*. That absence is why moderation could not be written testably before.
 *
 * Keeping it as an interface has three payoffs:
 * - the service is unit-testable against a fake adapter, exactly like the setup
 *   resource service;
 * - a future AI/automod caller uses the same port, so automation never needs a
 *   second implementation of "remove a role and restore it";
 * - the hierarchical rules (role position, bot permissions, guild owner) are
 *   enforced in one place for every caller.
 */
import type { Guild } from "discord.js";

import type { MemberTarget } from "./moderation.types.js";

/**
 * The mutable state of a member, as Discord currently reports it.
 *
 * Deliberately smaller than `MemberTarget`: this answers "would this action change
 * anything?", not "is this action allowed?".
 */
export interface MemberState {
  /** ISO timestamp of the timeout deadline, or `null` when not timed out. */
  readonly timedOutUntil: string | null;
  /** True when the member currently holds the guild's mute role. */
  readonly muted: boolean;
  /** True when the member currently holds the quarantine role. */
  readonly quarantined: boolean;
}

/** Result of one Discord mutation, so callers can report partial success. */
export interface MemberActionResult {
  /** True when the Discord call was accepted. */
  readonly ok: boolean;
  /** Set when `ok` is false: a short, user-safe reason. */
  readonly detail?: string;
}

export interface GuildMemberActions {
  /** Reads the target with every fact the service needs to decide. */
  readTarget(guildId: string, userId: string): Promise<MemberTarget | null>;
  /** Reads a banned user that is not in the guild; `null` when not banned. */
  readBannedTarget(guildId: string, userId: string): Promise<MemberTarget | null>;
  /**
   * Applies a timeout for the given duration.
   *
   * `durationMs` is the *duration* from now, not an absolute timestamp:
   * discord.js's `GuildMember.timeout()` adds it to `Date.now()` itself, so passing
   * an epoch here would double the offset and produce `communication_disabled_until`
   * decades in the future (Discord replies `INVALID_COMMUNICATION_DISABLED_TIMESTAMP`).
   */
  timeout(target: MemberTarget, durationMs: number, reason: string): Promise<MemberActionResult>;
  /** Removes a timeout. */
  removeTimeout(target: MemberTarget, reason: string): Promise<MemberActionResult>;
  /** Kicks the member and returns the number of messages removed by Discord. */
  kick(target: MemberTarget, reason: string): Promise<MemberActionResult>;
  /** Bans the user (works for a member or for a user ID not in the guild). */
  ban(
    target: MemberTarget,
    reason: string,
    options: { readonly deleteMessageSeconds: number },
  ): Promise<MemberActionResult>;
  /** Lifts a ban. */
  unban(target: MemberTarget, reason: string): Promise<MemberActionResult>;
  /** @returns the guild's configured mute role, or `null` when none exists. */
  muteRole(): Promise<{ id: string; name: string; position: number } | null>;
  /**
   * @returns the mutable state of a member *as Discord currently reports it*, or
   * `null` when they are no longer in the guild.
   *
   * The service needs this before an idempotent action so it can refuse a no-op.
   * A `MemberTarget` is a snapshot taken when the command was parsed; by the time
   * the action is about to run the member may have been muted by someone else, so
   * the decision has to be made against fresh state rather than the snapshot.
   */
  readState(userId: string): Promise<MemberState | null>;
  /** Adds or removes a role. */
  setRole(
    target: MemberTarget,
    roleId: string,
    present: boolean,
    reason: string,
  ): Promise<MemberActionResult>;
  /** @returns the security module's `Quarantined` role, or `null` when absent. */
  quarantineRole(): Promise<{ id: string; name: string; position: number } | null>;
  /**
   * Removes every role of a member except the quarantine role and the managed
   * ones, and returns what was removed.
   *
   * This is the one operation anti-nuke cannot express with `setRole`: stopping a
   * nuke in progress means dropping an account's authority *now*, in a single
   * call, and a per-role loop would leave a window in which the account still has
   * the next permission it intends to abuse.
   */
  stripRoles(
    target: MemberTarget,
    options: { readonly keepRoleIds: readonly string[]; readonly reason: string },
  ): Promise<{
    readonly ok: boolean;
    readonly removed: readonly string[];
    readonly detail?: string;
  }>;
  /** @returns the DM channel, or `null` when the user cannot be reached. */
  directMessage(userId: string, content: string): Promise<MemberActionResult>;
  /** Bulk-deletes recent messages in a channel, honouring a pinned exemption. */
  purgeMessages(
    channelId: string,
    options: {
      readonly limit: number;
      readonly authorId?: string | null;
      readonly maxAgeMs: number;
      readonly keepPinned: boolean;
    },
  ): Promise<{ readonly removed: number }>;
}

/** Adapter factory, injected into the service so tests can substitute a fake. */
export type GuildMemberActionAdapter = (guild: Guild) => GuildMemberActions;
