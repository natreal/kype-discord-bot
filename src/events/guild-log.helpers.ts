/**
 * Formatting helpers shared by the guild-log event handlers.
 *
 * Every log line in this bot is built from the same raw facts — a member, a channel,
 * an actor — and the temptation is to format them inline in each handler. Doing that
 * would produce six subtly different renderings of "who did what", so the formatting
 * lives here instead: the handlers observe, this file decides how the observation
 * reads, and a test can assert the wording without a Discord client.
 *
 * All helpers return plain strings, and all of them tolerate a partial payload — an
 * uncached member, a deleted channel — because dropping a log line is worse than
 * logging an incomplete one.
 */
import { ChannelType, type Guild, type GuildBasedChannel, type GuildMember, type PartialGuildMember } from "discord.js";

/** A timestamp Discord renders in the reader's own timezone. */
export function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1_000)}:f>`;
}

/** @returns a `**Label:** value` line, or `null` when there is nothing to show. */
export function field(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  return `**${label}:** ${value}`;
}

/** @returns the lines describing a member, used by join and leave alike. */
export function describeMemberLines(
  guild: Guild,
  member: GuildMember | PartialGuildMember,
): string[] {
  const joinedAt =
    member.joinedTimestamp === null || member.joinedTimestamp === undefined
      ? null
      : new Date(member.joinedTimestamp);
  const accountCreated = new Date(member.user.createdTimestamp);
  return compact([
    field("Member", `${member.user.tag} (<@${member.id}>)`),
    field("Account age", `<t:${Math.floor(accountCreated.getTime() / 1_000)}:R>`),
    field("Joined", joinedAt === null ? null : discordTimestamp(joinedAt)),
    field("Roles", describeRoles(guild, member)),
  ]);
}

/** @returns the member's role mentions, or `null` when they hold only `@everyone`. */
export function describeRoles(
  guild: Guild,
  member: GuildMember | PartialGuildMember,
): string | null {
  const roles = member.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((left, right) => right.position - left.position)
    .map((role) => `<@&${role.id}>`);
  return roles.length === 0 ? null : roles.join(", ");
}

/** @returns a channel mention plus its type, e.g. `#general (text)`. */
export function describeChannel(channel: GuildBasedChannel | null): string | null {
  if (!channel) {
    return null;
  }
  const name = "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;
  return `${channel.toString()} (\`${name}\`, ${channelTypeName(channel)})`;
}

/** @returns the channel type as a readable word. */
export function channelTypeName(channel: GuildBasedChannel): string {
  switch (channel.type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildForum:
      return "forum";
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return "thread";
    default:
      return "channel";
  }
}

/**
 * @returns a body of a message, trimmed to a readable excerpt.
 *
 * Discord refuses an embed description beyond a few thousand characters and a log
 * line that is a wall of text helps nobody. The limit is deliberately small: this is
 * an excerpt next to the message ID, not a transcript.
 */
export function excerpt(content: string, limit = 400): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "*empty*";
  }
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/** @returns only the entries that are not `null`, so no line prints as `undefined`. */
export function compact(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}
