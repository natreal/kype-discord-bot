/**
 * `guildMemberAdd` — the anti-raid trigger.
 *
 * Account facts Discord can supply cheaply are computed here (age, username
 * pattern) and the *decision* is left to `SecurityService`: a raid is a rate
 * question, and this handler sees one join at a time.
 *
 * `accountCreatedMs` comes from the snowflake itself rather than from
 * `user.createdTimestamp`, so the observation is identical whether the user object
 * is a full payload or a partial one.
 */
import type { GuildMember } from "discord.js";

import { defineEvent } from "./event.types.js";
import { describeMemberLines } from "./guild-log.helpers.js";
import type { AppServices } from "../services/container.js";
import { isNewAccount, isSuspiciousUsername } from "../modules/security/index.js";
import type { RaidJoinObservation } from "../modules/security/index.js";

export default defineEvent({
  name: "guildMemberAdd",
  execute: async (member, { services }) => {
    // The log line is emitted first, and independently of the security module: a
    // guild that never enabled anti-raid still expects `memberJoin` in its log
    // channel, and the security branch below can only ever skip.
    services.guildLog.emit({
      guildId: member.guild.id,
      event: "memberJoin",
      title: "Member joined",
      lines: describeMemberLines(member.guild, member),
      targetId: member.id,
      actorId: null,
    });

    // Onboarding (welcome + auto-roles) runs before the security branch and for
    // every human join: a guild with an auto-role configured expects it applied
    // whether or not it also runs anti-raid. Bots are skipped, because a bot's
    // roles are an authorization question owned by anti-nuke, not an onboarding one.
    if (!member.user.bot) {
      await onboardMember(member, services);
    }

    const security = services.securityForGuild(member.guild.id);
    if (!security) {
      return;
    }
    if (member.user.bot) {
      // A bot joining is handled by anti-nuke's `bot-add` action instead: it is an
      // *authorization* question (was this bot whitelisted?), not a raid question.
      return;
    }

    const joinedAtMs = member.joinedTimestamp ?? Date.now();
    const accountCreatedMs = createdAtFromSnowflake(member.user.id);
    const config = await security.config(member.guild.id);

    const observation: RaidJoinObservation = {
      guildId: member.guild.id,
      userId: member.user.id,
      userTag: member.user.tag,
      isNewAccount: isNewAccount(accountCreatedMs, joinedAtMs, config.antiRaid.minAccountAgeDays),
      accountCreatedMs,
      suspiciousUsername:
        config.antiRaid.suspiciousUsernameDetection && isSuspiciousUsername(member.user.username),
      joinedAtMs,
    };

    await security.observeJoin(observation);
  },
});

/**
 * Applies the guild's member onboarding — welcome message and auto-roles.
 *
 * Best-effort and never thrown: a join must still be logged (and anti-raid still
 * run) when a welcome channel was deleted or an auto-role sits above the bot, so
 * the failure is captured in the outcome and logged here rather than propagated.
 */
async function onboardMember(member: GuildMember, services: AppServices): Promise<void> {
  const onboarding = services.membersForGuild(member.guild.id);
  if (!onboarding) {
    return;
  }
  try {
    const outcome = await onboarding.onboard({
      guildId: member.guild.id,
      guildName: member.guild.name,
      userId: member.id,
      userTag: member.user.tag,
      memberCount: member.guild.memberCount,
    });
    if (outcome.rolesApplied.length > 0 || outcome.welcomed) {
      services.logger.child("members").info("Member onboarding applied", {
        guildId: member.guild.id,
        userId: member.id,
        rolesApplied: outcome.rolesApplied.length,
        welcomed: outcome.welcomed,
      });
    }
  } catch (error) {
    services.logger.warn("Member onboarding failed unexpectedly", {
      guildId: member.guild.id,
      userId: member.id,
      error: String(error),
    });
  }
}

/** Discord's epoch: every snowflake counts milliseconds from this instant. */
const DISCORD_EPOCH = 1_420_070_400_000n;

/** @returns the account creation time encoded in a Discord snowflake. */
function createdAtFromSnowflake(userId: string): number {
  return Number(BigInt(userId) / 4_194_304n + DISCORD_EPOCH);
}
