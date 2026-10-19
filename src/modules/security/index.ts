/**
 * Security module (V5).
 *
 * Anti-raid, anti-nuke, quarantine, lockdown and the security log. The module
 * *decides* and *contains*; every sanction against a member goes through
 * `ModerationService`, so the V4 module stays the only thing that punishes.
 */
export {
  NUKE_ACTION_KINDS,
  NUKE_ACTION_LABEL,
  NUKE_ACTION_WEIGHT,
  NUKE_RELEVANT_PERMISSIONS,
  describeBreakdown,
  detectNuke,
  isNukeActionKind,
  isWhitelisted,
  type NukeActionKind,
  type NukeActionObservation,
  type NukeVerdict,
} from "./anti-nuke.detector.js";
export {
  detectRaid,
  isNewAccount,
  isSuspiciousUsername,
  type RaidJoinObservation,
  type RaidVerdict,
} from "./anti-raid.detector.js";
export { DiscordSecurityActions, QUARANTINE_ROLE_NAME } from "./discord-security-actions.js";
export { PrismaSecurityIncidentRepository } from "./security-incident.repository.js";
export { SECURITY_ACTOR_ID, SECURITY_AUDIT_CATEGORY, SecurityService } from "./security.service.js";
export type { GuildSecurityActions, SecurityServiceOptions } from "./security.service.js";
export {
  SECURITY_LOG_CHANNEL_NAME,
  SecurityLogSink,
  renderSecurityDetails,
  renderSecurityEvent,
  type GuildResolver,
} from "./security-log.sink.js";
export type {
  NukeEpisode,
  RaidEpisode,
  SecurityIncident,
  SecurityIncidentDraft,
  SecurityIncidentKind,
  SecurityIncidentRepository,
  SecurityIncidentStatus,
  SecurityLogEvent,
  SecurityLogPort,
  SecurityLogSeverity,
} from "./security.types.js";
