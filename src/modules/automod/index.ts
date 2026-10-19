/**
 * Automod module (V5).
 *
 * Detection lives here; punishment does not. The module's public surface is the
 * evaluator (pure), the window (pure), the escalation ladder (pure) and one
 * service that delegates every sanction to `ModerationService` — the V4 module
 * that remains the only thing allowed to act on a member.
 */
export {
  ESCALATION_ACTIONS,
  escalationDecision,
  type EscalationAction,
  type EscalationDecision,
  type EscalationStep,
} from "./automod-escalation.js";
export {
  countEmojis,
  countLinks,
  evaluate,
  hasInvite,
  uppercaseRatio,
} from "./automod.evaluator.js";
export {
  AUTOMOD_RULE_DEFINITIONS,
  AUTOMOD_RULES,
  automodRuleDefinition,
  isAutomodRule,
  type AutomodRule,
  type AutomodRuleDefinition,
  type AutomodTrigger,
} from "./automod-rules.js";
export {
  AUTOMOD_ACTOR_ID,
  AUTOMOD_AUDIT_CATEGORY,
  AutomodService,
  describeMatches,
  type AutomodExemption,
  type AutomodOutcome,
  type AutomodServiceOptions,
} from "./automod.service.js";
export type {
  AutomodMatch,
  AutomodMessageObservation,
  AutomodObservation,
  AutomodReactionObservation,
  AutomodVerdict,
} from "./automod.types.js";
export { SlidingWindow, normalizeContent, type WindowSnapshot } from "./automod-window.js";
