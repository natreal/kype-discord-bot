/**
 * Maintenance mode.
 *
 * A guild-scoped pause switch, stored in the guild configuration so it survives a
 * restart and appears in the audit trail like every other configuration change.
 *
 * The service answers the two questions the dispatch layer has to ask:
 * - is this guild paused right now? (`isActive` / `status`)
 * - may *this* member keep working anyway? (`inspect` / `isExempt`)
 *
 * Exemption is deliberately narrow: God Access, the guild owner, members holding
 * Discord's `Administrator`, and holders of the granular `server.settings`
 * permission. The last one is the point of the rule: whoever can turn maintenance
 * off must be able to reach `/maintenance off` while it is on. Nobody else is
 * exempt — staff are paused too, because maintenance is about the bot's
 * availability, not about rank.
 *
 * Expiry is evaluated on read (`until` is compared with the clock), never by
 * mutating stored state from a hot path. `/maintenance status` therefore reports an
 * elapsed window as expired even if the bot was offline when it ended.
 */
import { PermissionFlagsBits, type GuildMember } from "discord.js";

import type { AuthorizationService, PermissionRequest } from "../authorization/index.js";
import type { ConfigService, ConfigWriteActor, GuildConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { PermissionService } from "../permissions/index.js";

/** Embed title used wherever the bot explains that it is paused. */
export const MAINTENANCE_TITLE = "Maintenance in progress";

/** Requirement that makes a member able to manage (and bypass) maintenance. */
const SETTINGS_HOLDER: PermissionRequest = { custom: ["server.settings"] };

/** The stored state, plus the two derived facts callers care about. */
export interface MaintenanceStatus {
  /** True when maintenance is engaged *now* (enabled and not past `until`). */
  readonly active: boolean;
  /**
   * True when maintenance was enabled but its `until` moment has passed. The flag
   * is intentionally not cleared on read: the operator's intent is history, and
   * clearing it would be a configuration write triggered by a read.
   */
  readonly expired: boolean;
  /** The persisted section as-is. */
  readonly state: GuildConfig["maintenance"];
  /** Milliseconds until automatic resume, or `null` when it must be turned off. */
  readonly remainingMs: number | null;
}

/** The answer the dispatch layer needs for one member. */
export interface MaintenanceGate {
  readonly status: MaintenanceStatus;
  /** True when this member may keep using the bot while maintenance is on. */
  readonly exempt: boolean;
}

export interface EnableMaintenanceOptions {
  /** Automatic resume delay; omitted or `0` means "until turned off". */
  readonly minutes?: number | undefined;
  /** Reason shown to members. */
  readonly reason?: string | undefined;
  readonly actor: ConfigWriteActor;
}

export interface MaintenanceServiceOptions {
  readonly config: ConfigService;
  readonly permissions: PermissionService;
  /**
   * Central authorization layer, used to resolve `server.settings` through the
   * guild's role → class bindings. Omitted in minimal harnesses, in which case
   * only God Access, the guild owner and Administrators bypass maintenance.
   */
  readonly authorization?: AuthorizationService;
  readonly logger: Logger;
  /** Clock injection, so expiry is testable without waiting. */
  readonly now?: () => number;
}

export class MaintenanceService {
  private readonly config: ConfigService;
  private readonly permissions: PermissionService;
  private readonly authorization: AuthorizationService | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;

  public constructor(options: MaintenanceServiceOptions) {
    this.config = options.config;
    this.permissions = options.permissions;
    this.authorization = options.authorization;
    this.logger = options.logger.child("maintenance");
    this.now = options.now ?? Date.now;
  }

  /** @returns the maintenance state of a guild, with expiry already evaluated. */
  public async status(guildId: string): Promise<MaintenanceStatus> {
    // `peek` is deliberate: this runs on every interaction (and every autocomplete
    // keystroke), so it must not create or rename the guild row.
    const config = await this.config.peek(guildId);
    return this.describe(config.maintenance);
  }

  /** @returns true when the guild is paused right now. */
  public async isActive(guildId: string): Promise<boolean> {
    const { active } = await this.status(guildId);
    return active;
  }

  /**
   * Answers both dispatch questions in one configuration read.
   *
   * A `null` member (an unresolvable cache entry) is *not* exempt: the gate fails
   * closed, because "I could not tell who this is" must never mean "let them in".
   */
  public async inspect(guildId: string, member: GuildMember | null): Promise<MaintenanceGate> {
    const status = await this.status(guildId);
    if (!status.active || !member) {
      return { status, exempt: false };
    }
    return { status, exempt: await this.isExempt(member) };
  }

  /** @returns true when `member` may operate while maintenance is enabled. */
  public async isExempt(member: GuildMember): Promise<boolean> {
    // God Access bypasses every gate in the platform; maintenance is no exception.
    if (this.permissions.isGodAccess(member)) {
      return true;
    }
    // The owner and Administrators already hold Discord's full authority.
    if (member.guild.ownerId === member.id) {
      return true;
    }
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return true;
    }
    // `server.settings` is the same permission `/maintenance` itself requires, so
    // the bypass set and the management set are one set by construction.
    if (!this.authorization) {
      return false;
    }
    return this.authorization.can(member, SETTINGS_HOLDER, "maintenance:bypass");
  }

  /**
   * Enables maintenance and returns the resulting state.
   *
   * Re-enabling restarts the window (`since` and `until` are recomputed) rather
   * than extending the previous one, so "on for 30 minutes" always means thirty
   * minutes from the moment it was typed.
   */
  public async enable(
    guildId: string,
    options: EnableMaintenanceOptions,
  ): Promise<MaintenanceStatus> {
    const startedAt = new Date(this.now());
    const minutes = options.minutes ?? 0;
    const until =
      minutes > 0 ? new Date(startedAt.getTime() + minutes * 60_000).toISOString() : null;

    const config = await this.config.updateSection(
      guildId,
      "maintenance",
      {
        enabled: true,
        reason: (options.reason ?? "").trim(),
        since: startedAt.toISOString(),
        until,
        by: options.actor.id,
      },
      options.actor,
    );

    this.logger.info("Maintenance mode enabled", {
      guildId,
      by: options.actor.id,
      until,
    });

    return this.describe(config.maintenance);
  }

  /** Disables maintenance and clears the window. */
  public async disable(guildId: string, actor: ConfigWriteActor): Promise<MaintenanceStatus> {
    const config = await this.config.updateSection(
      guildId,
      "maintenance",
      { enabled: false, reason: "", since: null, until: null, by: null },
      actor,
    );

    this.logger.info("Maintenance mode disabled", { guildId, by: actor.id });
    return this.describe(config.maintenance);
  }

  /** Computes the derived facts from a stored section. */
  private describe(state: GuildConfig["maintenance"]): MaintenanceStatus {
    const now = this.now();
    const until = state.until === null ? null : Date.parse(state.until);
    // An unparseable `until` is treated as "no automatic resume" rather than as an
    // instantly-expired window: a typo must not silently re-enable the bot.
    const expiresAt = until !== null && Number.isFinite(until) ? until : null;
    const expired = state.enabled && expiresAt !== null && expiresAt <= now;

    return {
      active: state.enabled && !expired,
      expired,
      state,
      remainingMs: state.enabled && expiresAt !== null ? Math.max(0, expiresAt - now) : null,
    };
  }
}

/**
 * The user-facing explanation of a pause.
 *
 * Kept next to the service (and free of discord.js types) so the command, the
 * interaction handler and any future surface phrase it identically.
 */
export function maintenanceMessage(status: MaintenanceStatus): string {
  const lines = [
    "The bot is being maintained in this server, so commands, ticket actions and AI replies are paused.",
  ];

  if (status.state.reason.length > 0) {
    lines.push("", `**Reason:** ${status.state.reason}`);
  }

  const until = status.state.until === null ? null : Date.parse(status.state.until);
  if (until !== null && Number.isFinite(until)) {
    lines.push(`**Expected back:** <t:${Math.floor(until / 1_000)}:f>`);
  }

  lines.push("", "Please try again later.");
  return lines.join("\n");
}
