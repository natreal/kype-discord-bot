/**
 * Security contracts.
 *
 * The security module is the *containment* module: it decides that a raid or a
 * nuke is happening and reacts to it. It never punishes anybody on its own — a
 * quarantine is applied through `ModerationService` (the V4 module that owns
 * sanctions), and a nuke response strips Discord permissions instead of banning.
 *
 * Two types carry that split:
 *
 * - {@link SecurityIncident} — one raid/nuke episode, persisted so a restart
 *   cannot silently lift a lockdown;
 * - {@link SecurityLogEvent} — the line an operator reads in the security channel,
 *   with the who/what/when/object/before-after/action the V5 brief asks for.
 */
import type { NukeActionKind, NukeVerdict } from "./anti-nuke.detector.js";
import type { RaidVerdict } from "./anti-raid.detector.js";

/** Kind of episode. */
export type SecurityIncidentKind = "raid" | "nuke";

/** Where an incident stands. */
export type SecurityIncidentStatus = "active" | "resolved";

/** A persisted episode. */
export interface SecurityIncident {
  readonly id: string;
  readonly guildId: string;
  readonly kind: SecurityIncidentKind;
  readonly status: SecurityIncidentStatus;
  readonly summary: string;
  readonly details: unknown;
  readonly targetedIds: readonly string[];
  readonly startedAt: Date;
  readonly expiresAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
}

/** Everything needed to open an incident. */
export interface SecurityIncidentDraft {
  readonly guildId: string;
  readonly kind: SecurityIncidentKind;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly targetedIds: readonly string[];
  readonly expiresAt: Date | null;
}

/** Persistence port, so the service is testable without PostgreSQL. */
export interface SecurityIncidentRepository {
  open(draft: SecurityIncidentDraft): Promise<SecurityIncident>;
  /** @returns the guild's active incident of `kind`, or `null`. */
  active(guildId: string, kind: SecurityIncidentKind): Promise<SecurityIncident | null>;
  /** @returns every active incident of a guild, oldest first. */
  listActive(guildId: string): Promise<SecurityIncident[]>;
  /** @returns active incidents whose `expiresAt` has passed, oldest first. */
  listExpired(now: Date): Promise<SecurityIncident[]>;
  resolve(id: string, resolvedBy: string): Promise<SecurityIncident | null>;
}

/** Severity of a security log line. */
export type SecurityLogSeverity = "info" | "warning" | "critical";

/**
 * The who / what / when / on what / before-after / action line.
 *
 * Every field is optional except the action and the summary, because a security
 * log that refuses to record an event it does not fully understand is worse than
 * one that records what it knows.
 */
export interface SecurityLogEvent {
  readonly guildId: string;
  /** Stable identifier, e.g. `automod.trigger`, `security.raid-detected`. */
  readonly action: string;
  readonly severity: SecurityLogSeverity;
  /** One-line headline posted as the embed title. */
  readonly summary: string;
  /** Who: the account responsible, when one is known. */
  readonly actorId?: string | null;
  readonly actorTag?: string | null;
  /** When: defaults to the delivery time when absent. */
  readonly at?: Date | null;
  /** On what: the affected object (`channel:#general`, `role:Admin`, ...). */
  readonly target?: string | null;
  /** Before / after, as a short pair of strings. */
  readonly before?: string | null;
  readonly after?: string | null;
  /** What the module did about it. */
  readonly response?: string | null;
  /** Extra, already-redacted fields rendered as a list. */
  readonly details?: Readonly<Record<string, string | number>>;
}

/** Delivery port for the security log channel. Never throws. */
export interface SecurityLogPort {
  record(event: SecurityLogEvent): Promise<void>;
}

/** A raid episode, as the service tracked it. */
export interface RaidEpisode {
  readonly incident: SecurityIncident;
  readonly verdict: RaidVerdict;
  /** Accounts restricted as part of the response. */
  readonly quarantinedIds: readonly string[];
  /** True when the server was locked down for this episode. */
  readonly lockdown: boolean;
}

/** A nuke episode, as the service tracked it. */
export interface NukeEpisode {
  readonly incident: SecurityIncident;
  readonly verdict: NukeVerdict;
  readonly action: NukeActionKind;
  /** The account whose permissions were removed. */
  readonly actorId: string;
  /** Roles actually removed from that account. */
  readonly strippedRoleIds: readonly string[];
}
