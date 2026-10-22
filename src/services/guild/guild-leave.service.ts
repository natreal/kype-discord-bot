/**
 * Leaving a guild from Discord.
 *
 * `guild.leave()` is a single REST call, but the surrounding order matters: the
 * interaction reply has to reach Discord *before* the bot leaves, because once it
 * has left it has no access to the channel the command came from and an
 * unanswered interaction reads as "The application did not respond". The service
 * therefore owns the grace period, and only then performs the leave.
 *
 * The outcome is returned rather than thrown, so the caller can tell an operator
 * that the leave failed and the bot is still in the server. Guild data is not
 * touched here: retention is a deliberate operator decision, and
 * `guildDelete` already documents that leaving does not delete anything.
 */
import type { Guild } from "discord.js";

import type { Logger } from "../logger/index.js";
import { toError } from "../../utils/errors.js";

/** How long the reply is given to reach Discord before the bot leaves. */
export const DEFAULT_GUILD_LEAVE_DELAY_MS = 1_500;

/** Who asked the bot to leave, and why — recorded in the log line. */
export interface GuildLeaveRequest {
  /** The guild to leave, taken from the interaction rather than looked up. */
  readonly guild: Guild;
  readonly actorId: string;
  readonly actorTag: string;
  readonly reason?: string | undefined;
}

/** What actually happened, so the caller can report it honestly. */
export interface GuildLeaveOutcome {
  readonly ok: boolean;
  readonly guildId: string;
  readonly guildName: string;
  /** Present only when the leave failed; never shown to users verbatim. */
  readonly reason?: string | undefined;
}

export interface GuildLeaveOptions {
  readonly logger: Logger;
  /** Grace period before the leave, so the reply is delivered first. */
  readonly delayMs?: number | undefined;
  /** Injected sleep, so tests do not wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class GuildLeaveService {
  private readonly logger: Logger;
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: GuildLeaveOptions) {
    this.logger = options.logger.child("guild-leave");
    this.delayMs = options.delayMs ?? DEFAULT_GUILD_LEAVE_DELAY_MS;
    this.sleep = options.sleep ?? delay;
  }

  /**
   * Leaves the guild after the reply has had time to reach Discord.
   *
   * Never throws: a failed leave is an outcome with `ok: false`, because the
   * command still has to answer the operator and the process keeps serving every
   * other guild either way.
   */
  public async leave(request: GuildLeaveRequest): Promise<GuildLeaveOutcome> {
    const { guild } = request;
    this.logger.warn("Leaving guild on request", {
      actor: request.actorTag,
      actorId: request.actorId,
      guild: guild.name,
      guildId: guild.id,
      reason: request.reason ?? null,
    });

    // The reply is sent by the caller; without this pause the bot would leave
    // before Discord has flushed the interaction response.
    if (this.delayMs > 0) {
      await this.sleep(this.delayMs);
    }

    try {
      await guild.leave();
      this.logger.warn("Left guild", {
        actor: request.actorTag,
        actorId: request.actorId,
        guild: guild.name,
        guildId: guild.id,
      });
      return { ok: true, guildId: guild.id, guildName: guild.name };
    } catch (error) {
      this.logger.error("Failed to leave guild", error, {
        actor: request.actorTag,
        actorId: request.actorId,
        guild: guild.name,
        guildId: guild.id,
      });
      return {
        ok: false,
        guildId: guild.id,
        guildName: guild.name,
        reason: toError(error).message,
      };
    }
  }
}

/** @returns a promise resolved after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
