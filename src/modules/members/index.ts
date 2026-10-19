/**
 * Public surface of the members module.
 *
 * Re-exported so `app.ts` and the event handlers import from one path, and so the
 * discord.js adapter stays an implementation detail of the file that constructs it.
 */
export { membersModule, MEMBERS_MODULE_NAME, MEMBERS_RESOURCES } from "./members.module.js";
export {
  MemberOnboardingService,
  renderWelcome,
  type MemberConfigReader,
  type MemberOnboardingServiceDeps,
} from "./members.service.js";
export { DiscordMemberOnboardingActions } from "./discord-member-onboarding-actions.js";
export type {
  GuildMemberOnboardingActions,
  MemberActionResult,
  MemberJoinOutcome,
  MemberJoinRequest,
  MemberOnboardingActionAdapter,
} from "./members.types.js";
