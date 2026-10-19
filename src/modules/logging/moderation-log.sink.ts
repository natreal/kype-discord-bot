/**
 * A log sink that delivers moderation records to a guild's Discord log channel.
 *
 * This is the piece that turns `/settings logging` from configuration into an
 * actual outcome: the platform tracked a log channel and a set of log toggles
 * since V2, but nothing ever wrote to it. The sink is deliberately narrow — it
 * accepts *moderation* records only — because that is the postable category V4
 * owns; member, message and security events belong to their own modules and will
 * bring their own formatters.
 *
 * Two guarantees, both inherited from the logger contract:
 * - it never throws, so a Discord outage cannot break the action being logged;
 * - it resolves the channel per record, so renaming or moving the log channel (or
 *   enabling logging later) takes effect immediately, with no restart.
 */
import { ChannelType, EmbedBuilder, type Guild, type TextChannel } from "discord.js";

import type { LogRecord, LogSink } from "../../services/logger/types.js";
import type { Logger } from "../../services/logger/index.js";
import type { BotClient } from "../../client/client.types.js";
import type { ModerationLogEvent } from "../moderation/moderation.service.js";
import { BOT_NAME } from "../../config/constants.js";

/** Looks up one guild by ID, without trusting the record's own guild field. */
export type GuildResolver = (guildId: string) => Guild | null;

export interface ModerationLogSinkOptions {
  readonly client: BotClient | GuildResolver;
  readonly logger: Logger;
  /** Milliseconds before a channel lookup is abandoned. */
  readonly timeoutMs?: number;
}

/** Colour used for every moderation log line. */
const MODERATION_COLOR = 0xed4245;

export class ModerationLogSink implements LogSink {
  public readonly name = "discord:moderation";

  private readonly resolveGuild: GuildResolver;
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  public constructor(options: ModerationLogSinkOptions) {
    const resolver = options.client;
    this.resolveGuild =
      typeof resolver === "function"
        ? resolver
        : (guildId: string) => resolver.guilds.cache.get(guildId) ?? null;
    this.logger = options.logger.child("log-sink");
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  /** Called by the logger for every record; only moderation events are posted. */
  public write(record: LogRecord): void {
    const event = asModerationEvent(record);
    if (!event) {
      return;
    }
    // Fire and forget: `write` is synchronous by contract, and a Discord call is
    // not. Failures are logged, never propagated.
    void this.deliver(event).catch((error: unknown) => {
      this.logger.warn("Failed to deliver a moderation log line", {
        error: String(error),
        caseNumber: event.caseNumber,
      });
    });
  }

  /** Delivers one moderation event to the guild's configured log channel. */
  private async deliver(event: ModerationLogEvent): Promise<void> {
    const guild = this.resolveGuild(event.guildId);
    if (!guild) {
      return;
    }

    const channel = await this.logChannel(guild);
    if (!channel) {
      return;
    }

    await channel.send({ embeds: [renderModeration(event)] });
  }

  /**
   * Resolves the log channel of a guild.
   *
   * Resolution order mirrors the setup system's own semantics: the recorded
   * channel ID first, then the expected name as a fallback. Nothing is cached,
   * so a rename or a repair is picked up on the next event.
   */
  private async logChannel(guild: Guild): Promise<TextChannel | null> {
    const configured = resolvedChannelId(guild.id);
    if (configured) {
      const cached = guild.channels.cache.get(configured);
      if (cached && cached.type === ChannelType.GuildText) {
        return cached;
      }
      const fetched = await withTimeout(
        guild.channels.fetch(configured).catch(() => null),
        this.timeoutMs,
      );
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

/** The channel name setup creates for the log stream. */
const DEFAULT_LOG_CHANNEL_NAME = "server-logs";

/** Log category the sink accepts: everything else is another module's business. */
const MODERATION_LOG_CATEGORY = "moderation";

/**
 * Metadata key carrying the structured event.
 *
 * The logger transports redacted key/value metadata, so the payload travels
 * there under a single namespaced key rather than spread across it: one key means
 * one shape to validate, and no risk of a moderation field being mistaken for a
 * logger field.
 */
const MODERATION_METADATA_KEY = "moderationLog";

/**
 * @returns the configured log channel ID of a guild.
 *
 * The guild's configuration is not reachable from a plain `Guild`, and reading
 * the database here would put an I/O call on the logging path. The sink therefore
 * resolves the channel by name (the identity `setup` created it with) and accepts
 * an explicit override, which the bootstrap supplies from the configuration it
 * already holds.
 */
/**
 * Configured log channel IDs, keyed by guild.
 *
 * Populated by the bootstrap from the configuration layer. This is a *cache of a
 * configuration value*, not a source of truth: a missing entry falls through to
 * the name lookup, which is exactly what happens before `/setup` has run.
 */
const LOG_CHANNEL_OVERRIDES = new Map<string, string>();

/**
 * Supplies a guild's logging configuration without an I/O call on the logging path.
 *
 * The sink cannot reach the database itself — `write` is synchronous by contract —
 * so the bootstrap hands it a reader that already holds the configuration. This is
 * what makes `/settings set setting:logging-channel-id` actually redirect the log
 * stream: before this existed the sink only ever searched for a channel *named*
 * `server-logs`, so a server that pointed logging at its own channel saw nothing.
 */
export type LogChannelConfigReader = (
  guildId: string,
) => { readonly enabled: boolean; readonly channelId: string | null; readonly securityChannelId: string | null } | null;

let readLogConfig: LogChannelConfigReader | null = null;

/** Installs the configuration reader the sink uses to resolve a guild's channel. */
export function setLogChannelConfigReader(reader: LogChannelConfigReader | null): void {
  readLogConfig = reader;
}

/** Registers the configured log channel of a guild, as read from its config. */
export function setLogChannelOverride(guildId: string, channelId: string | null): void {
  if (channelId === null) {
    LOG_CHANNEL_OVERRIDES.delete(guildId);
    return;
  }
  LOG_CHANNEL_OVERRIDES.set(guildId, channelId);
}

/** @returns the guild's configured channel ID, from the reader, then the override map. */
function resolvedChannelId(guildId: string): string | null {
  const fromConfig = readLogConfig?.(guildId)?.channelId ?? null;
  return fromConfig ?? LOG_CHANNEL_OVERRIDES.get(guildId) ?? null;
}

/** @returns the config reader the sink consults, or `null` when none is installed. */
export function getLogChannelConfigReader(): LogChannelConfigReader | null {
  return readLogConfig;
}

/** @returns a moderation event when the record carries one, otherwise `null`. */
function asModerationEvent(record: LogRecord): ModerationLogEvent | null {
  if (record.context?.category !== MODERATION_LOG_CATEGORY) {
    return null;
  }
  const payload = record.metadata?.[MODERATION_METADATA_KEY];
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  return payload as ModerationLogEvent;
}

/** Renders a moderation event as the embed posted to the log channel. */
export function renderModeration(event: ModerationLogEvent): EmbedBuilder {
  const actor =
    event.actor.kind === "system" ? `automation (${event.actor.id})` : `<@${event.actor.id}>`;
  return new EmbedBuilder()
    .setColor(MODERATION_COLOR)
    .setAuthor({ name: `${event.label} — case #${event.caseNumber}` })
    .setDescription(
      [
        `**Target:** ${event.targetId ? `<@${event.targetId}>` : "—"}${
          event.targetTag ? ` (\`${event.targetTag}\`)` : ""
        }`,
        `**Moderator:** ${actor}`,
        `**Reason:** ${event.reason ?? "No reason given."}`,
        event.durationMs === null ? null : `**Duration:** ${formatLogDuration(event.durationMs)}`,
        event.expiresAt
          ? `**Expires:** <t:${Math.floor(event.expiresAt.getTime() / 1_000)}:R>`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    )
    .setFooter({ text: `${BOT_NAME} · guild ${event.guildId}` })
    .setTimestamp();
}

/** @returns a duration like `10 minutes`, used only in the log embed. */
function formatLogDuration(durationMs: number): string {
  const minutes = durationMs / 60_000;
  if (minutes < 60) {
    return `${Math.round(minutes)} minute(s)`;
  }
  const hours = minutes / 60;
  return hours < 48 ? `${Math.round(hours)} hour(s)` : `${Math.round(hours / 24)} day(s)`;
}

/** @returns `value`, or rejects once `timeoutMs` has elapsed. */
async function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
