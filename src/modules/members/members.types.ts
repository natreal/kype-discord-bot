/**
 * Member onboarding types.
 *
 * The `members` configuration section has declared `welcomeEnabled`,
 * `welcomeChannelId`, `welcomeMessage` and `autoRoleIds` since V3, but nothing
 * ever read them: a member joining a server with an auto-role configured got
 * nothing, and the welcome message was never posted. These types describe the
 * two facts the module needs (what to say, which roles to grant) so the service
 * that reads them is testable without a Discord client.
 */
import type { Guild } from "discord.js";

/**
 * An onboarding request for one member who just joined, as observed by the
 * `guildMemberAdd` handler.
 *
 * `username`, `guildName` and `memberCount` are passed in rather than looked up
 * from a `GuildMember`, because the handler already holds the member and the
 * service must stay a pure function of its inputs to remain testable.
 */
export interface MemberJoinRequest {
  readonly guildId: string;
  readonly guildName: string;
  readonly userId: string;
  /** The user's display tag (`user.tag`), used by the `{user}` placeholder. */
  readonly userTag: string;
  /** The current member count, used by the `{count}` placeholder. */
  readonly memberCount: number;
}

/** What onboarding actually did, so the caller can log an accurate summary. */
export interface MemberJoinOutcome {
  /** Role IDs that were successfully applied. */
  readonly rolesApplied: readonly string[];
  /** Role IDs configured but not applied, with a short reason each. */
  readonly rolesSkipped: readonly { readonly roleId: string; readonly detail: string }[];
  /** Whether a welcome message was posted. */
  readonly welcomed: boolean;
}

/**
 * Discord operations member onboarding needs, bound to one guild.
 *
 * A port rather than a direct client, mirroring `GuildRoleActions` and
 * `GuildTicketActions`: the service decides *what* to do, and this adapter is
 * the only file that knows how to talk to Discord.
 */
export interface GuildMemberOnboardingActions {
  /** @returns whether the role exists and the bot can assign it. */
  canManageRole(roleId: string): Promise<boolean>;
  /** Adds one role to the member. */
  addRole(userId: string, roleId: string, reason: string): Promise<MemberActionResult>;
  /** Posts a welcome message to a channel. */
  postWelcome(channelId: string, content: string): Promise<MemberActionResult>;
}

/** Result of one Discord member mutation. */
export interface MemberActionResult {
  readonly ok: boolean;
  /** Set when `ok` is false: a short, user-safe reason. */
  readonly detail?: string;
}

/** Adapter factory, injected so tests can substitute a fake. */
export type MemberOnboardingActionAdapter = (guild: Guild) => GuildMemberOnboardingActions;
