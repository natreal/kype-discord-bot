/**
 * `guildMemberRemove` — the member-leave log event.
 *
 * `memberLeave` has been a `/settings logging` toggle since V2 and never had a
 * handler behind it, so a guild that turned it on still saw an empty log channel.
 * This is the handler that makes the toggle mean something.
 *
 * Discord gives a `PartialGuildMember` here when the member was not cached, so every
 * field is read defensively: an uncached leave is still a leave, and dropping it
 * would make the log lie by omission.
 */
import { defineEvent } from "./event.types.js";
import { describeMemberLines } from "./guild-log.helpers.js";

export default defineEvent({
  name: "guildMemberRemove",
  execute: (member, { services }) => {
    services.guildLog.emit({
      guildId: member.guild.id,
      event: "memberLeave",
      title: "Member left",
      lines: describeMemberLines(member.guild, member),
      targetId: member.id,
      actorId: null,
    });
  },
});
