/**
 * `messageDelete` — the message-deletion log event.
 *
 * `messageDelete` has been a `/settings logging` toggle since V2 with no handler
 * behind it. Two cases are deliberately distinguished, because they read very
 * differently to a moderator investigating a deleted message:
 *
 * - a message that was still cached, which has an author and a body;
 * - a bulk delete, where Discord emits one `messageDeleteBulk` instead.
 *
 * A *partial* message (uncached) has no author or content, and that is logged as
 * such rather than guessed at: claiming an unknown author deleted their own message
 * would be worse than saying the author is unknown.
 */
import { defineEvent } from "./event.types.js";
import { compact, describeChannel, excerpt, field } from "./guild-log.helpers.js";

export default defineEvent({
  name: "messageDelete",
  execute: (message, { services }) => {
    if (!message.inGuild()) {
      return;
    }
    const guild = message.guild;
    if (!guild) {
      return;
    }

    // The bot's own deletions are noise: every automod trigger, every purge and
    // every expiry already produced a moderation case that says more.
    if (message.author?.id === message.client.user?.id) {
      return;
    }

    services.guildLog.emit({
      guildId: guild.id,
      event: "messageDelete",
      title: "Message deleted",
      lines: compact([
        field("Channel", describeChannel(message.channel)),
        field("Author", message.author ? `<@${message.author.id}> (\`${message.author.tag}\`)` : null),
        field("Message", `\`${message.id}\``),
        field("Content", message.content ? excerpt(message.content) : null),
      ]),
      targetId: message.id,
      actorId: message.author?.id ?? null,
    });
  },
});
