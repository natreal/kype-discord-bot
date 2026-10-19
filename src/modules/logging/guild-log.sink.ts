/**
 * Delivers guild events — joins, leaves, deletes, edits, role and channel changes —
 * to a guild's Discord log channel.
 *
 * The sibling of `ModerationLogSink`, and deliberately a separate sink: moderation
 * records are red because they demand attention, while these are the routine stream
 * an administrator reads when reconstructing what happened. Mixing them would make a
 * `ban` indistinguishable from a `member joined` at a glance.
 *
 * It shares the moderation sink's two guarantees — never throwing, and resolving the
 * channel per record — and adds a third that matters here: an event family the guild
 * turned off is dropped *before* reaching this sink, by `GuildLogPort`.
 *
 * Rendering is pure, so each event family's formatting is a unit test rather than a
 * Discord round trip.
 */
import { ChannelType, EmbedBuilder, type Guild, type TextChannel } from "discord.js";

import type { LogRecord, LogSink } from "../../services/logger/types.js";
import type { Logger } from "../../services/logger/index.js";
import type { BotClient } from "../../client/client.types.js";
import {
  GUILD_LOG_CATEGORY,
  GUILD_LOG_METADATA_KEY,
  type GuildLogEventPayload,
} from "./guild-log.port.js";
import { getLogChannelConfigReader } from "./moderation-log.sink.js";

/** Looks up one guild by ID, without trusting the record's own guild field. */
export type GuildResolver = (guildId: string) => Guild | null;

export interface GuildLogSinkOptions {
  readonly client: BotClient | GuildResolver;
  readonly logger: Logger;
  /** Milliseconds before a channel lookup is abandoned. */
  readonly timeoutMs?: number;
}

/** Colour per event family, so a channel scan separates them at a glance. */
const EVENT_COLORS: Readonly<Record<string, number>> = {
  memberJoin: 0x57f287,
  memberLeave: 0xed4245,
  messageDelete: 0xfee75c,
  messageEdit: 0xfee75c,
  roleChanges: 0x5865f2,
  channelChanges: 0x5865f2,
};

/** Discord refuses an embed description longer than this. */
const MAX_BODY_LENGTH = 4_096;

/** The channel name `setup` creates for the log stream, shared with the other sinks. */
const DEFAULT_LOG_CHANNEL_NAME = "server-logs";

export class GuildLogSink implements LogSink {
  public readonly name = "discord:guild-events";

  private readonly resolveGuild: GuildResolver;
  private readonly logger: Logger;

  public constructor(options: GuildLogSinkOptions) {
    const resolver = options.client;
    this.resolveGuild =
      typeof resolver === "function"
        ? resolver
        : (guildId: string) => resolver.guilds.cache.get(guildId) ?? null;
    this.logger = options.logger.child("guild-log-sink");
  }

  /** Called by the logger for every record; only guild events are posted. */
  public write(record: LogRecord): void {
    const payload = asGuildEvent(record);
    if (!payload) {
      return;
    }
    // Fire and forget: `write` is synchronous by contract, and a Discord call is
    // not. Failures are logged, never propagated into the event handler.
    void this.deliver(payload).catch((error: unknown) => {
      this.logger.warn("Failed to deliver a guild log line", {
        error: String(error),
        event: payload.event,
      });
    });
  }

  /** Delivers one guild event to the guild's configured log channel. */
  private async deliver(payload: GuildLogEventPayload): Promise<void> {
    const guild = this.resolveGuild(payload.guildId);
    if (!guild) {
      return;
    }
    const channel = await this.logChannel(guild);
    if (!channel) {
      this.logger.debug("No log channel to deliver to", { guildId: payload.guildId });
      return;
    }
    // A missing permission is the most common reason a log channel "does not work",
    // and it is silent otherwise: say so once per delivery rather than never.
    const me = guild.members.me;
    if (me && !channel.permissionsFor(me).has("SendMessages")) {
      this.logger.warn("Cannot write to the log channel: missing Send Messages", {
        guildId: payload.guildId,
        channelId: channel.id,
      });
      return;
    }
    await channel.send({ embeds: [renderGuildEvent(payload)] });
  }

  /**
   * Resolves the log channel of a guild.
   *
   * The configured channel ID first — through the reader the bootstrap installs, so
   * `/settings logging` is honoured — then the name `setup` created, for a guild
   * whose configuration has not been read yet.
   */
  private async logChannel(guild: Guild): Promise<TextChannel | null> {
    const configured = getLogChannelConfigReader()?.(guild.id)?.channelId ?? null;
    if (configured) {
      const cached = guild.channels.cache.get(configured);
      if (cached && cached.type === ChannelType.GuildText) {
        return cached;
      }
      const fetched = await guild.channels.fetch(configured).catch(() => null);
      if (fetched && fetched.type === ChannelType.GuildText) {
        return fetched;
      }
    }

    const byName = guild.channels.cache.find(
      (candidate) =>
        candidate.type === ChannelType.GuildText &&
        candidate.name.trim().toLowerCase() === DEFAULT_LOG_CHANNEL_NAME,
    );
    return (byName as TextChannel | undefined) ?? null;
  }
}

/** @returns the payload when the record carries a guild event, otherwise `null`. */
function asGuildEvent(record: LogRecord): GuildLogEventPayload | null {
  if (record.context?.category !== GUILD_LOG_CATEGORY) {
    return null;
  }
  const payload = record.metadata?.[GUILD_LOG_METADATA_KEY];
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return payload as GuildLogEventPayload;
}

/** Renders one guild event as an embed. Pure, so every family is unit-testable. */
export function renderGuildEvent(payload: GuildLogEventPayload): EmbedBuilder {
  const body = payload.lines.join("\n");
  return new EmbedBuilder()
    .setColor(EVENT_COLORS[payload.event] ?? 0x5865f2)
    .setTitle(payload.title)
    .setDescription(body.length === 0 ? "—" : truncate(body, MAX_BODY_LENGTH))
    .setTimestamp();
}

/** @returns the text, shortened to fit a Discord embed description. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
