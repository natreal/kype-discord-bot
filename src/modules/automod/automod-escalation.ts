/**
 * Automod escalation.
 *
 * The ladder is *data*, from `automod.escalation`: trigger count → action. Given
 * a member's trigger history it answers "what should happen now?", and it always
 * answers with an action from the moderation module's vocabulary — never with a
 * Discord call of its own. That is the V5 constraint expressed in code: automod
 * decides *whether* to punish, `ModerationService` is the only thing that
 * actually does it.
 */
import type { ModerationAction } from "../moderation/moderation-actions.js";

/** Actions the escalation ladder may select. */
export const ESCALATION_ACTIONS = ["warn", "mute", "timeout", "note", "none"] as const;

export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** One rung of the ladder. */
export interface EscalationStep {
  /** Trigger count at or above which this rung applies. */
  readonly triggers: number;
  readonly action: EscalationAction;
  /** Punishment length; ignored by `warn` and `note`. */
  readonly durationMs: number;
}

/** What the ladder decided. */
export interface EscalationDecision {
  readonly action: EscalationAction;
  /** Moderation action to execute, or `null` when the step is `none`. */
  readonly moderationAction: ModerationAction | null;
  readonly durationMs: number | null;
  readonly step: EscalationStep | null;
}

/**
 * Selects the rung for a trigger count.
 *
 * The ladder is sorted by `triggers` ascending, and the *highest* rung at or
 * below the count wins: a member on their sixth trigger with rungs at 1, 3 and 5
 * gets the 5 rung, not the 1 rung. An empty ladder is a valid configuration and
 * means "record the trigger, punish nobody", which is what a server still
 * calibrating its thresholds actually wants.
 */
export function escalationDecision(
  steps: readonly EscalationStep[],
  triggerCount: number,
): EscalationDecision {
  const applicable = [...steps]
    .filter((step) => step.triggers <= triggerCount)
    .sort((left, right) => left.triggers - right.triggers);
  const step = applicable[applicable.length - 1] ?? null;
  if (step === null) {
    return { action: "none", moderationAction: null, durationMs: null, step: null };
  }
  return {
    action: step.action,
    moderationAction: toModerationAction(step.action),
    durationMs: step.action === "mute" || step.action === "timeout" ? step.durationMs : null,
    step,
  };
}

/** Maps an escalation action onto the moderation action it executes. */
function toModerationAction(action: EscalationAction): ModerationAction | null {
  switch (action) {
    case "warn":
      return "warn";
    case "mute":
      return "mute";
    case "timeout":
      return "timeout";
    case "note":
      return "note";
    case "none":
      return null;
  }
}
