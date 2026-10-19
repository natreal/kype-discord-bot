/**
 * discord.js implementation of `GuildMemberOnboardingActions`.
 *
 * The only file in the members module that knows about discord.js, and
 * deliberately thin: one method maps to one API call and normalizes the outcome
 * into `{ ok, detail }` rather than throwing. A member who left before the role
 * could be added, or a welcome channel an administrator deleted, are ordinary
 * outcomes that must not turn a join into an error.
 *
 * `canManageRole` folds the same three Discord questions the role module asks —
 * does it exist, is it integration-managed, is it below my highest role — into
 * one boolean, because assigning a role the bot cannot manage would fail and the
 * failure would be indistinguishable from a transient error.
 */
import type { Guild } from "discord.js";

import type { GuildMemberOnboardingActions, MemberActionResult } from "./members.types.js";

export class DiscordMemberOnboardingActions implements GuildMemberOnboardingActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async canManageRole(roleId: string): Promise<boolean> {
    const role = await this.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      return false;
    }
    // A role owned by an integration (a bot role, a booster role) cannot be
    // assigned by hand, and Discord rejects the call.
    if (role.managed) {
      return false;
    }
    // Hierarchy: the bot may only touch roles strictly below its own highest.
    const me = this.guild.members.me;
    return me !== null && role.position < me.roles.highest.position;
  }

  public async addRole(
    userId: string,
    roleId: string,
    reason: string,
  ): Promise<MemberActionResult> {
    try {
      const member = await this.guild.members.fetch(userId);
      await member.roles.add(roleId, reason);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeMemberError(error) };
    }
  }

  public async postWelcome(channelId: string, content: string): Promise<MemberActionResult> {
    try {
      const channel = await this.guild.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return { ok: false, detail: "that channel is not a text channel" };
      }
      await channel.send(content);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeMemberError(error) };
    }
  }
}

/** Turns a discord.js failure into a sentence an administrator can act on. */
function describeMemberError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 50013) {
    return "I am missing the required permission";
  }
  if (code === 10007 || code === 10011 || code === 10003) {
    return "it no longer exists";
  }
  return error instanceof Error ? error.message : "Discord refused the change";
}
