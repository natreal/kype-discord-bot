/**
 * `messageUpdate` — the message-edit log event.
 *
 * The edit is the interesting case for moderation: `before` is Discord's *cached*
 * copy, so a message that was edited before the bot saw it arrives here with the new
 * body only. Rather than pretend otherwise, the handler logs what it can prove and
 * says so — an "old" body that was never observed is rendered as unavailable instead
 * of being invented.
 *
 * Edits that change nothing are dropped: Discord emits `messageUpdate` for embed
 * refreshes and link previews, which would otherwise flood the log channel.
 */
import { defineEvent } from "./event.types.js";
import { compact, describeChannel, excerpt, field } from "./guild-log.helpers.js";

export default defineEvent({
  name: "messageUpdate",
  execute: (before, after, { services }) => {
    if (!after.inGuild()) {
      return;
    }
    const guild = after.guild;
    if (!guild) {
      return;
    }
    if (after.author?.bot) {
      return;
    }

    const beforeContent = before.content ?? null;
    const afterContent = after.content ?? null;
    if (beforeContent !== null && beforeContent === afterContent) {
      // An embed refresh or a link-preview fill-in: the text did not change.
      return;
    }

    services.guildLog.emit({
      guildId: guild.id,
      event: "messageEdit",
      title: "Message edited",
      lines: compact([
        field("Channel", describeChannel(after.channel)),
        field("Author", after.author ? `<@${after.author.id}> (\`${after.author.tag}\`)` : null),
        field("Jump", `[go to message](https://discord.com/channels/${guild.id}/${after.channelId}/${after.id})`),
        field("Before", beforeContent === null ? "*not cached*" : excerpt(beforeContent)),
        field("After", afterContent === null ? "*not cached*" : excerpt(afterContent)),
      ]),
      targetId: after.id,
      actorId: after.author?.id ?? null,
    });
  },
});
