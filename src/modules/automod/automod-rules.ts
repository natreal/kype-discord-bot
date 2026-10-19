/**
 * Automod rule vocabulary and pure evaluation.
 *
 * The rules are *declarations*, not code paths: each one names the observation it
 * needs and the threshold it compares against, so the same table drives the
 * configuration (`/settings automod`), the evaluation and the security log line.
 * Adding a rule means adding one entry here, not a new branch in a message
 * handler.
 *
 * Two deliberate choices:
 *
 * 1. `observe()` is pure. It takes a plain {@link AutomodObservation} — no
 *    discord.js, no clock read beyond the timestamps already on the payload — and
 *    returns the rules that fired. That is what makes "does `anti-caps` fire on
 *    THIS message?" a unit test rather than a live experiment.
 * 2. Rate-based rules (`anti-spam`, `anti-flood`, `anti-mass-reactions`) read
 *    their history from an {@link AutomodWindow}, itself pure. The window lives
 *    in one place, so two rules can never disagree about what "the last 10
 *    seconds" means.
 */
import type { GuildConfig } from "../../services/config/index.js";

/** Every automod rule the platform understands. */
export const AUTOMOD_RULES = [
  "anti-spam",
  "anti-flood",
  "anti-mention-spam",
  "anti-link",
  "anti-invite",
  "anti-caps",
  "anti-repeated-messages",
  "anti-emoji-spam",
  "anti-mass-reactions",
] as const;

export type AutomodRule = (typeof AUTOMOD_RULES)[number];

/** @returns true when `value` is a known automod rule. */
export function isAutomodRule(value: unknown): value is AutomodRule {
  return typeof value === "string" && (AUTOMOD_RULES as readonly string[]).includes(value);
}

/** How a rule is observed: on a message, or on a reaction. */
export type AutomodTrigger = "message" | "reaction";

/** Static description of one rule. */
export interface AutomodRuleDefinition {
  readonly rule: AutomodRule;
  /** Human label used in `/automod status` and the security log. */
  readonly label: string;
  /** Default punishment the escalation ladder starts from. */
  readonly trigger: AutomodTrigger;
  /** Configuration key that enables it, inside `automod.rules`. */
  readonly setting: keyof GuildConfig["automod"]["rules"];
  /** Configuration key that holds its threshold, inside `automod.thresholds`. */
  readonly threshold: keyof GuildConfig["automod"]["thresholds"] | null;
  /** Whether the rule needs message history (a sliding window). */
  readonly windowed: boolean;
  readonly description: string;
}

/**
 * The rule table.
 *
 * `setting` is typed as a key of the rules object, so removing a toggle from the
 * configuration schema breaks the build here instead of silently disabling a rule.
 */
export const AUTOMOD_RULE_DEFINITIONS: Readonly<Record<AutomodRule, AutomodRuleDefinition>> = {
  "anti-spam": {
    rule: "anti-spam",
    label: "Anti-spam",
    trigger: "message",
    setting: "antiSpam",
    threshold: "spamMessages",
    windowed: true,
    description: "Too many messages in the window.",
  },
  "anti-flood": {
    rule: "anti-flood",
    label: "Anti-flood",
    trigger: "message",
    setting: "antiFlood",
    threshold: "floodChannels",
    windowed: true,
    description: "The same account posting across many channels at once.",
  },
  "anti-mention-spam": {
    rule: "anti-mention-spam",
    label: "Anti-mention-spam",
    trigger: "message",
    setting: "antiMentionSpam",
    threshold: "mentions",
    windowed: false,
    description: "Too many mentions in one message.",
  },
  "anti-link": {
    rule: "anti-link",
    label: "Anti-link",
    trigger: "message",
    setting: "antiLink",
    threshold: "links",
    windowed: false,
    description: "Too many links in one message.",
  },
  "anti-invite": {
    rule: "anti-invite",
    label: "Anti-invite",
    trigger: "message",
    setting: "antiInvite",
    threshold: null,
    windowed: false,
    description: "A Discord invite link, which is how raids are recruited.",
  },
  "anti-caps": {
    rule: "anti-caps",
    label: "Anti-caps",
    trigger: "message",
    setting: "antiCaps",
    threshold: "capsPercent",
    windowed: false,
    description: "Shouting: mostly uppercase text.",
  },
  "anti-repeated-messages": {
    rule: "anti-repeated-messages",
    label: "Anti-repeated messages",
    trigger: "message",
    setting: "antiRepeatedMessages",
    threshold: "repeatedMessages",
    windowed: true,
    description: "The same message posted over and over.",
  },
  "anti-emoji-spam": {
    rule: "anti-emoji-spam",
    label: "Anti-emoji-spam",
    trigger: "message",
    setting: "antiEmojiSpam",
    threshold: "emojis",
    windowed: false,
    description: "Too many emojis in one message.",
  },
  "anti-mass-reactions": {
    rule: "anti-mass-reactions",
    label: "Anti-mass-reactions",
    trigger: "reaction",
    setting: "antiMassReactions",
    threshold: "reactions",
    windowed: true,
    description: "Adding reactions far faster than a human can read.",
  },
};

/** @returns the definition of `rule`, or `undefined` when unknown. */
export function automodRuleDefinition(rule: string): AutomodRuleDefinition | undefined {
  return isAutomodRule(rule) ? AUTOMOD_RULE_DEFINITIONS[rule] : undefined;
}
