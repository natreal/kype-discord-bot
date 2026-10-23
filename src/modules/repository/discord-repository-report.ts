/**
 * Discord delivery of the report.
 *
 * An adapter, and a deliberately dumb one: it resolves the channel, asks the pure
 * builder for the content, and sends. It holds the client rather than a `Channel`,
 * because the channel is resolved per delivery — the same way `GuildLogSink`
 * resolves the log channel — so moving the report between channels, or a channel
 * that is briefly unavailable, never leaves the bot posting nowhere.
 */
import { ChannelType, EmbedBuilder, type Client, type TextChannel } from "discord.js";

import type { Logger } from "../../services/logger/index.js";
import type { ProgressEvent, RepositoryReading } from "../../services/anyps5/repository.types.js";
import type { SnapshotRecord } from "./repository.types.js";
import type { RepositoryReportPort } from "./repository.service.js";
import { buildReportContent } from "./repository-report.content.js";

export interface DiscordRepositoryReportOptions {
  readonly client: Client;
  readonly logger: Logger;
  /** Channel the report is posted to; `null` disables posting but keeps the history. */
  readonly channelId: string | null;
  /** Reads the recent snapshots for the trend footer. */
  readonly history: () => Promise<SnapshotRecord[]>;
}

export class DiscordRepositoryReport implements RepositoryReportPort {
  private readonly client: Client;
  private readonly logger: Logger;
  private readonly channelId: string | null;
  private readonly history: () => Promise<SnapshotRecord[]>;

  public constructor(options: DiscordRepositoryReportOptions) {
    this.client = options.client;
    this.logger = options.logger.child("repository-report");
    this.channelId = options.channelId;
    this.history = options.history;
  }

  /**
   * Publishes one report.
   *
   * @param events the events claimed for this refresh, which become the "what
   * changed" block. Passed in rather than re-derived, so the message can never
   * disagree with what was recorded as announced.
   * @returns `false` when there is no channel configured: the snapshot is still
   * stored, which is the part that matters for the history.
   */
  public async publish(
    reading: RepositoryReading,
    previous: SnapshotRecord | null,
    events: readonly ProgressEvent[],
  ): Promise<boolean> {
    if (this.channelId === null) {
      this.logger.debug("No repository report channel configured; snapshot stored only");
      return false;
    }

    const channel = await this.resolveChannel();
    if (channel === null) {
      this.logger.warn("The repository report channel is missing or not writable", {
        channelId: this.channelId,
      });
      return false;
    }

    const content = buildReportContent(reading, previous, events, await this.history());
    await channel.send({
      embeds: [renderEmbed(content)],
      // The report names pull-request authors and must never ping them.
      allowedMentions: { parse: [] },
    });
    return true;
  }

  private async resolveChannel(): Promise<TextChannel | null> {
    if (this.channelId === null) {
      return null;
    }
    const cached = this.client.channels.cache.get(this.channelId);
    const channel = cached ?? (await this.client.channels.fetch(this.channelId).catch(() => null));
    return channel !== null && channel.type === ChannelType.GuildText ? channel : null;
  }
}

/** Builds the embed from the pure content. Kept tiny so the layout lives in one file. */
export function renderEmbed(content: {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly metrics: readonly { readonly name: string; readonly value: string }[];
  readonly changes: string | null;
  readonly footer: string;
  readonly changed: boolean;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(content.changed ? 0x2ea043 : 0x5865f2)
    .setTitle(content.title)
    .setURL(content.url)
    .setDescription(content.description)
    .setFooter({ text: content.footer })
    .setTimestamp();

  const metrics = content.metrics.slice(0, 2);
  embed.addFields(metrics.map((metric) => ({ ...metric, inline: true })));
  for (const metric of content.metrics.slice(2)) {
    embed.addFields({ name: metric.name, value: metric.value });
  }
  if (content.changes !== null) {
    embed.addFields({ name: "What changed", value: content.changes });
  }
  return embed;
}
