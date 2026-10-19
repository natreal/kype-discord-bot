/**
 * Bridges gateway events to the guild's Discord log channel.
 *
 * `/settings logging` has declared `events.memberJoin`, `events.messageDelete`,
 * `events.roleChanges` and friends since V2, but nothing ever *read* them: the
 * toggles were stored, displayed by `/settings view`, and ignored. The visible
 * symptom was a log channel that stayed empty while every toggle claimed to be on.
 *
 * This port is the missing reader. An event handler observes something and calls
 * `emit`, which does two things:
 *
 * 1. checks the guild's toggle for that event and returns silently when it is off;
 * 2. writes a structured record whose category is `logging` and whose payload sits
 *    under `guildLog`, which is exactly what `GuildLogSink` looks for.
 *
 * Routing by category rather than by a direct call keeps the contract between this
 * module and the sink explicit, and means a handler never needs a Discord channel
 * object — only the facts worth logging.
 */
import type { Logger } from "../../services/logger/index.js";
import { readCachedLogging } from "../../services/config/index.js";

/** Log category that routes a record to the guild log sink. */
export const GUILD_LOG_CATEGORY = "logging";

/** Metadata key carrying the structured guild event. */
export const GUILD_LOG_METADATA_KEY = "guildLog";

/**
 * The event families a guild can toggle.
 *
 * Deliberately the same names as `logging.events` in the configuration schema, so a
 * rename in one place is a compile error in the other rather than a toggle that
 * silently stops matching.
 */
export type GuildLogEvent =
  "memberJoin" | "memberLeave" | "messageDelete" | "messageEdit" | "roleChanges" | "channelChanges";

/** What an event handler hands over: the toggle, and what to render. */
export interface GuildLogEventPayload {
  readonly guildId: string;
  readonly event: GuildLogEvent;
  /** Short headline, e.g. `Member joined`. */
  readonly title: string;
  /** The body lines shown in the embed. */
  readonly lines: readonly string[];
  /** Who caused it, when Discord reports an actor. */
  readonly actorId?: string | null;
  /** The subject of the event: the member, message, role or channel. */
  readonly targetId?: string | null;
}

/** Whether a guild wants one event family delivered. */
export type GuildLogToggleReader = (guildId: string, event: GuildLogEvent) => boolean;

export class GuildLogPort {
  private readonly logger: Logger;

  public constructor(logger: Logger) {
    // The category must live in the logger's *context*, not in record metadata:
    // `GuildLogSink` routes records by `record.context.category`, and the logger
    // only populates `context` from the `withContext` bound logger. Setting the
    // category in metadata would make the sink discard every event.
    this.logger = logger.withContext({ category: GUILD_LOG_CATEGORY }).child("guild-log");
  }

  /**
   * Records one guild event, if the guild asked for that family.
   *
   * Never throws: a logging failure must not break the event handler that produced
   * it, for the same reason the sink never throws on delivery.
   */
  public emit(payload: GuildLogEventPayload): void {
    const enabled = readGuildLogToggle(payload.guildId, payload.event);
    if (!enabled) {
      return;
    }
    this.logger.info(`${payload.event}: ${payload.title}`, {
      guildId: payload.guildId,
      event: payload.event,
      ...(payload.actorId ? { actorId: payload.actorId } : {}),
      ...(payload.targetId ? { targetId: payload.targetId } : {}),
      [GUILD_LOG_METADATA_KEY]: payload,
    });
  }
}

/** Every event family the log sink renders. */
export const GUILD_LOG_EVENTS: readonly GuildLogEvent[] = [
  "memberJoin",
  "memberLeave",
  "messageDelete",
  "messageEdit",
  "roleChanges",
  "channelChanges",
];

/**
 * @returns whether a guild wants one event family delivered to its log channel.
 *
 * Reads the same cached projection the moderation sink uses, so this stays a
 * synchronous map lookup on the event hot path. When the configuration has never
 * been read — a guild the process has not served yet — the schema's own default is
 * assumed, which is "on": a log channel that stays silent because the cache is cold
 * would be indistinguishable from the bug this port exists to fix.
 */
export function readGuildLogToggle(guildId: string, event: GuildLogEvent): boolean {
  const cached = readCachedLogging(guildId);
  if (!cached) {
    return true;
  }
  return cached.events[event] ?? true;
}

/** Re-exported so callers do not need two imports for one concept. */
