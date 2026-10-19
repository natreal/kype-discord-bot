/**
 * Bridges the moderation service to the platform logger and the Discord log sink.
 *
 * The service is deliberately unaware of both: it calls `ModerationLogPort`, and
 * this adapter decides that a log line goes to the structured logger (always) and
 * to the guild's Discord log channel (through `ModerationLogSink`, when logging
 * is enabled for that guild).
 *
 * The logger record carries the category `moderation` and the structured event
 * under `moderationLog`, which is exactly what the sink looks for — so routing
 * stays a contract between two modules rather than a hardcoded call.
 */
import type { Logger } from "../../services/logger/index.js";
import type { ModerationLogEvent, ModerationLogPort } from "../moderation/moderation.service.js";

/** Log category used to route moderation records to the Discord sink. */
export const MODERATION_LOG_CATEGORY = "moderation";

/** Metadata key carrying the structured moderation event. */
export const MODERATION_LOG_METADATA_KEY = "moderationLog";

export class LoggerModerationLogPort implements ModerationLogPort {
  private readonly logger: Logger;

  public constructor(logger: Logger) {
    // Same rule as `GuildLogPort`: the category must be in the logger context, not
    // the metadata, because `ModerationLogSink` routes by `record.context.category`.
    this.logger = logger.withContext({ category: MODERATION_LOG_CATEGORY }).child("moderation-log");
  }

  public record(event: ModerationLogEvent): Promise<void> {
    this.logger.info(`Moderation: ${event.label} (case #${event.caseNumber})`, {
      guildId: event.guildId,
      caseNumber: event.caseNumber,
      action: event.action,
      moderatorId: event.actor.id,
      moderatorKind: event.actor.kind,
      targetId: event.targetId,
      [MODERATION_LOG_METADATA_KEY]: event,
    });
    return Promise.resolve();
  }
}
