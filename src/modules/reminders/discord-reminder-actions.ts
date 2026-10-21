/**
 * discord.js adapter for the reminder port.
 *
 * Kept in its own file so the service never imports discord.js: the service is the
 * part with the interesting behaviour, and it is tested without a client. This file is
 * deliberately dumb — it performs the call and lets failures propagate, because the
 * scheduler is the thing that decides whether to retry.
 */
import type { Guild } from "discord.js";

import type { ReminderActions } from "./reminder.service.js";

export class DiscordReminderActions implements ReminderActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async sendMessage(channelId: string, content: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) {
      // Thrown rather than swallowed: "the channel is gone or not writable" is a real
      // failure the operator should see in `/scheduler list`, not a silent no-op.
      throw new Error(`Channel ${channelId} cannot receive the reminder.`);
    }
    await channel.send({ content, allowedMentions: { parse: ["users", "roles"] } });
  }

  public async memberExists(guildId: string, userId: string): Promise<boolean> {
    // The cache first: a reminder usually fires for a member the bot has already seen,
    // and a membership check should not cost a REST call on every delivery.
    if (this.guild.id !== guildId) {
      return false;
    }
    if (this.guild.members.cache.has(userId)) {
      return true;
    }
    const member = await this.guild.members.fetch(userId).catch(() => null);
    return member !== null;
  }
}
