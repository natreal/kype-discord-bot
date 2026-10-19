/**
 * Moderation module (V4).
 *
 * Owns the moderation domain: the action vocabulary, the case history and the
 * service every caller goes through. Setup-time resources stay declared by
 * `moderation.module.ts`; this barrel is the *runtime* surface.
 */
export {
  MODERATION_ACTIONS,
  MODERATION_ACTION_DEFINITIONS,
  MODERATION_LIMITS,
  MODERATION_SCOPES,
  SENIOR_ONLY_ACTIONS,
  isModerationAction,
  moderationActionDefinition,
  type ModerationAction,
  type ModerationActionDefinition,
  type ModerationScope,
} from "./moderation-actions.js";
export {
  PrismaModerationCaseRepository,
  type ModerationCaseDraft,
  type ModerationCaseQuery,
  type ModerationCaseRecord,
  type ModerationCaseRepository,
  type ModerationTargetState,
  type SweepResolution,
} from "./moderation-case.repository.js";
export { DiscordMemberActions } from "./discord-member-actions.js";
export type {
  GuildMemberActions,
  GuildMemberActionAdapter,
  MemberActionResult,
} from "./member-actions.js";
export {
  ModerationService,
  type ModerationLiftResult,
  type ModerationLogEvent,
  type ModerationServiceOptions,
} from "./moderation.service.js";
export type { ModerationLogPort, ModerationSettingsReader } from "./moderation.service.js";
export {
  userActor,
  systemActor,
  type ChannelTarget,
  type MemberTarget,
  type ModerationActor,
  type ModerationOutcome,
  type ModerationRequest,
  type ModerationTarget,
} from "./moderation.types.js";
