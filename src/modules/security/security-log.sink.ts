/**
 * The security log: a channel of its own, distinct from the moderation log.
 *
 * The V4 moderation log answers "what did a moderator do to a member". The security
 * log answers a different question — "what is happening to *the server* right now" —
 * and mixing the two would bury a raid alert between two warning notices. The
 * channel is `#bot-security`, created by the security module's setup actions, and
 * this port is the only thing that writes to it.
 *
 * The format is the one the V5 brief asks for, in that order:
 *
 *   qui / quoi / quand / sur quel objet / avant-après / action prise
 *
 * Every field is rendered even when it is empty, with an explicit `—`, so a reader
 * can tell "nothing was recorded" from "this module forgot to record it".
 */
import { EmbedBuilder, type Guild, type GuildBasedChannel } from "discord.js";

import { BOT_NAME } from "../../config/constants.js";
import type { BotClient } from "../../client/client.types.js";
import type { Logger } from "../../services/logger/index.js";
import type { SecurityLogEvent, SecurityLogPort, SecurityLogSeverity } from "./security.types.js";

/** Channel name `setup` creates for security alerts. */
export const SECURITY_LOG_CHANNEL_NAME = "bot-security";

/** Looks up one guild by ID, without trusting the event's own guild field. */
export type GuildResolver = (guildId: string) => Guild | null;

/** Embed colours per severity, so a critical line is visible at a glance. */
const SEVERITY_COLOR: Readonly<Record<SecurityLogSeverity, number>> = {
  info: 0x5865f2,
  warning: 0xfee75c,
  critical: 0xed4245,
};

/** How long a delivery may take before the sink gives up on it. */
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Resolves the security channel of a guild.
 *
 * Like the moderation sink, the channel is resolved by recorded ID when the
 * bootstrap has one, and by name otherwise — so the very first alert of a fresh
 * installation still lands somewhere a human will look.
 */
export class SecurityLogSink implements SecurityLogPort {
  private readonly resolveGuild: GuildResolver;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  /** Configured channel IDs, keyed by guild. A cache, never a source of truth. */
  private readonly overrides = new Map<string, string>();

  public constructor(options: {
    readonly client: BotClient | GuildResolver;
    readonly logger: Logger;
    readonly timeoutMs?: number;
  }) {
    const resolver = options.client;
    this.resolveGuild =
      typeof resolver === "function"
        ? resolver
        : (guildId: string) => resolver.guilds.cache.get(guildId) ?? null;
    this.logger = options.logger.child("security-log");
    this.timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  }

  /** Registers the configured security channel of a guild, from its config. */
  public setChannelOverride(guildId: string, channelId: string | null): void {
    if (channelId === null) {
      this.overrides.delete(guildId);
      return;
    }
    this.overrides.set(guildId, channelId);
  }

  public async record(event: SecurityLogEvent): Promise<void> {
    const channel = this.resolveChannel(event.guildId);
    if (!channel) {
      return;
    }
    try {
      await Promise.race([
        channel.send({ embeds: [renderSecurityEvent(event)] }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      // A Discord outage must never surface as a security-module failure.
      this.logger.warn("Could not post a security log line", {
        guildId: event.guildId,
        action: event.action,
        error: String(error),
      });
    }
  }

  private resolveChannel(guildId: string) {
    const guild = this.resolveGuild(guildId);
    if (!guild) {
      return null;
    }
    const override = this.overrides.get(guildId);
    if (override) {
      const channel = guild.channels.cache.get(override);
      const sendable = asSendable(channel);
      if (sendable) {
        return sendable;
      }
    }
    for (const channel of guild.channels.cache.values()) {
      const sendable = asSendable(channel);
      if (sendable && channel.name.trim().toLowerCase() === SECURITY_LOG_CHANNEL_NAME) {
        return sendable;
      }
    }
    return null;
  }
}

/** @returns the channel when it can be posted in, otherwise `null`. */
function asSendable(
  channel: GuildBasedChannel | undefined,
): { send: (options: { embeds: EmbedBuilder[] }) => Promise<unknown> } | null {
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    return null;
  }
  return channel;
}

/** Renders one security event as the embed posted to `#bot-security`. */
export function renderSecurityEvent(event: SecurityLogEvent): EmbedBuilder {
  const at = event.at ?? new Date();
  const who = event.actorId
    ? `${event.actorTag ? `\`${event.actorTag}\` ` : ""}<@${event.actorId}> (\`${event.actorId}\`)`
    : "—";

  return new EmbedBuilder()
    .setColor(SEVERITY_COLOR[event.severity])
    .setAuthor({ name: `Security · ${event.action}` })
    .setTitle(truncate(event.summary, 256))
    .addFields(
      {
        name: "Who",
        value: truncate(who, 1_024),
        inline: true,
      },
      {
        name: "When",
        value: `<t:${Math.floor(at.getTime() / 1_000)}:F>`,
        inline: true,
      },
      {
        name: "On what",
        value: truncate(event.target ?? "—", 1_024),
        inline: true,
      },
      {
        name: "Before → after",
        value: truncate(`${event.before ?? "—"} → ${event.after ?? "—"}`, 1_024),
      },
      {
        name: "Action taken",
        value: truncate(event.response ?? "— logged only —", 1_024),
      },
    )
    .setFooter({ text: `${BOT_NAME} · guild ${event.guildId}` })
    .setTimestamp(at);
}

/** Appends the structured details as a compact line, when there are any. */
export function renderSecurityDetails(
  details: Readonly<Record<string, string | number>> | undefined,
): string | null {
  if (!details) {
    return null;
  }
  const entries = Object.entries(details);
  return entries.length === 0
    ? null
    : entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

/** Truncates to a Discord-safe length without cutting mid-emoji. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
