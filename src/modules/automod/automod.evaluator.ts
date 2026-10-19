/**
 * The automod evaluator.
 *
 * `evaluate()` is pure: same observation + same configuration + same window ⇒
 * same verdict, with no I/O and no ambient clock. Everything the messages actually
 * contain — mentions, links, invites, caps, emojis, repetition — is measured here,
 * so a rule can be tested by handing it a string rather than by driving Discord.
 *
 * Three rules that shape the implementation:
 *
 * 1. **Bots are never judged.** An automod that punishes a bot's own webhook
 *    output (a feed, a status message) is an automod an operator turns off. The
 *    verdict says *why* nothing was judged rather than silently returning clean.
 * 2. **Owners and administrators are never judged either.** They are the people
 *    who would have to undo the punishment, and Discord protects them anyway.
 * 3. **Invites are judged before generic links.** An invite is a link, so a server
 *    with `anti-link` off and `anti-invite` on would otherwise be told "too many
 *    links" by a rule it did not enable. The specific rule wins.
 */
import type { GuildConfig } from "../../services/config/index.js";
import { AUTOMOD_RULES, automodRuleDefinition, type AutomodRule } from "./automod-rules.js";
import type { WindowSnapshot } from "./automod-window.js";
import type {
  AutomodMatch,
  AutomodMessageObservation,
  AutomodObservation,
  AutomodVerdict,
} from "./automod.types.js";

/** A bare URL, which is what `anti-link` counts. */
const URL_PATTERN = "https?://[^\\s<>\"']+";

/** Any Discord invite form: `discord.gg/x`, `discord.com/invite/x`, `dsc.gg/x`. */
const INVITE_PATTERN =
  "(?:discord(?:app)?\\.(?:gg|com|me)/(?:invite/)?|dsc\\.gg/|discord\\.me/)[a-z0-9-]+";

/**
 * Unicode emoji, counted alongside `<:name:id>` custom emojis.
 *
 * Split into two alternatives rather than one class: the variation selector
 * (`FE0F`) is a combining character, and mixing it into a class of emoji ranges
 * makes the pattern ambiguous to read and to lint.
 */
const UNICODE_EMOJI_PATTERN =
  "[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]|\\u{FE0F}";

/** Custom Discord emoji markup, `<:name:123>` / `<a:name:123>`. */
const CUSTOM_EMOJI_PATTERN = "<a?:\\w+:\\d+>";

/**
 * Judges one observation.
 *
 * @param observation what was seen (a message or a reaction)
 * @param config the guild's full configuration; the `automod` section drives it
 * @param window the author's sliding window, already updated by the service
 * @returns the verdict, listing every rule that fired
 */
export function evaluate(
  observation: AutomodObservation,
  config: GuildConfig["automod"],
  window: WindowSnapshot,
): AutomodVerdict {
  if (observation.botAuthor) {
    return { clean: true, matches: [], exemptReason: "bot" };
  }
  if (observation.authorIsOwner) {
    return { clean: true, matches: [], exemptReason: "owner" };
  }
  if (observation.authorIsAdministrator) {
    return { clean: true, matches: [], exemptReason: "administrator" };
  }

  const enabled = (rule: AutomodRule): boolean =>
    config.rules[automodRuleDefinition(rule)?.setting ?? "antiSpam"];

  const matches: AutomodMatch[] = [];

  // Order matters: the invite check runs before the generic link check so a
  // server that only enabled `anti-invite` never hears about `anti-link`.
  if (observation.kind === "message" && enabled("anti-invite")) {
    const match = matchInvite(observation);
    if (match) {
      matches.push(match);
    }
  }

  for (const rule of AUTOMOD_RULES) {
    if (!enabled(rule) || rule === "anti-invite") {
      continue;
    }
    const match =
      observation.kind === "message"
        ? matchMessageRule(rule, observation, config, window)
        : matchReactionRule(rule, observation, config, window);
    if (match) {
      matches.push(match);
    }
  }

  return { clean: matches.length === 0, matches, exemptReason: null };
}

/** @returns the match for a message-scoped rule, or `null`. */
function matchMessageRule(
  rule: AutomodRule,
  observation: AutomodMessageObservation,
  config: GuildConfig["automod"],
  window: WindowSnapshot,
): AutomodMatch | null {
  const thresholds = config.thresholds;
  const seconds = config.windowSeconds;

  switch (rule) {
    case "anti-spam": {
      // `count` includes the message being judged, because the service records
      // before it evaluates: "5 messages in 10s" is 5, not 4.
      if (window.count < thresholds.spamMessages) {
        return null;
      }
      return {
        rule,
        observed: `${window.count} messages in ${seconds}s`,
        threshold: thresholds.spamMessages,
        detail: `Sent ${window.count} messages in ${seconds} seconds.`,
      };
    }
    case "anti-flood": {
      if (window.channels < thresholds.floodChannels) {
        return null;
      }
      return {
        rule,
        observed: `${window.channels} channels in ${seconds}s`,
        threshold: thresholds.floodChannels,
        detail: `Posted in ${window.channels} channels within ${seconds} seconds.`,
      };
    }
    case "anti-mention-spam": {
      if (observation.mentionCount < thresholds.mentions) {
        return null;
      }
      return {
        rule,
        observed: `${observation.mentionCount} mentions`,
        threshold: thresholds.mentions,
        detail: `Mentioned ${observation.mentionCount} people in one message.`,
      };
    }
    case "anti-link": {
      const links = countLinks(observation.content);
      if (links < thresholds.links) {
        return null;
      }
      return {
        rule,
        observed: `${links} links`,
        threshold: thresholds.links,
        detail: `Posted ${links} links in one message.`,
      };
    }
    case "anti-caps": {
      if (observation.content.trim().length < thresholds.capsMinLength) {
        return null;
      }
      const ratio = uppercaseRatio(observation.content);
      if (ratio.percent < thresholds.capsPercent) {
        return null;
      }
      return {
        rule,
        observed: `${ratio.percent}% uppercase`,
        threshold: thresholds.capsPercent,
        detail: `Message was ${ratio.percent}% uppercase.`,
      };
    }
    case "anti-repeated-messages": {
      if (window.identicalRun < thresholds.repeatedMessages) {
        return null;
      }
      return {
        rule,
        observed: `${window.identicalRun} identical`,
        threshold: thresholds.repeatedMessages,
        detail: `Posted the same message ${window.identicalRun} times.`,
      };
    }
    case "anti-emoji-spam": {
      const emojis = countEmojis(observation.content) + observation.emojiCount;
      if (emojis < thresholds.emojis) {
        return null;
      }
      return {
        rule,
        observed: `${emojis} emojis`,
        threshold: thresholds.emojis,
        detail: `Posted ${emojis} emojis in one message.`,
      };
    }
    // A reaction rule can never match a message; listed explicitly so adding a
    // rule without handling it is a type error rather than a silent no-op.
    case "anti-mass-reactions":
    default: {
      return null;
    }
  }
}

/** @returns the match for a reaction-scoped rule, or `null`. */
function matchReactionRule(
  rule: AutomodRule,
  _observation: AutomodObservation,
  config: GuildConfig["automod"],
  window: WindowSnapshot,
): AutomodMatch | null {
  if (rule !== "anti-mass-reactions") {
    return null;
  }
  if (window.count < config.thresholds.reactions) {
    return null;
  }
  return {
    rule,
    observed: `${window.count} reactions in ${config.windowSeconds}s`,
    threshold: config.thresholds.reactions,
    detail: `Added ${window.count} reactions in ${config.windowSeconds} seconds.`,
  };
}

/** @returns the invite match, when the message carries an invite link. */
function matchInvite(observation: AutomodMessageObservation): AutomodMatch | null {
  const match = new RegExp(INVITE_PATTERN, "i").exec(observation.content);
  if (!match) {
    return null;
  }
  // The code is quoted rather than the whole URL: a security log must not become
  // a clickable advertisement for the invite it is reporting.
  const code = match[0].split("/").pop() ?? match[0];
  return {
    rule: "anti-invite",
    observed: `invite ${code}`,
    threshold: 1,
    detail: `Posted a Discord invite link (\`${code}\`).`,
  };
}

/** @returns how many bare URLs the content contains. */
export function countLinks(content: string): number {
  return [...content.matchAll(new RegExp(URL_PATTERN, "gi"))].length;
}

/** @returns how many emojis (unicode or custom) the content contains. */
export function countEmojis(content: string): number {
  const unicode = [...content.matchAll(new RegExp(UNICODE_EMOJI_PATTERN, "gu"))].length;
  const custom = [...content.matchAll(new RegExp(CUSTOM_EMOJI_PATTERN, "g"))].length;
  return unicode + custom;
}

/**
 * @returns the share of uppercase letters, ignoring anything that is not a letter.
 *
 * Punctuation, digits and emoji are excluded on purpose: `WOW!!!!!111` is
 * shouting, and counting the `1`s as lowercase would let it pass.
 */
export function uppercaseRatio(content: string): { percent: number; letters: number } {
  const letters = [...content].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) {
    return { percent: 0, letters: 0 };
  }
  // A character is "uppercase" when it is unchanged by `toUpperCase` and changed
  // by `toLowerCase`; that excludes digits and scripts without case.
  const upper = letters.filter(
    (character) => character === character.toUpperCase() && character !== character.toLowerCase(),
  ).length;
  return { percent: Math.round((upper / letters.length) * 100), letters: letters.length };
}

/** @returns true when the content contains a Discord invite link. */
export function hasInvite(content: string): boolean {
  return new RegExp(INVITE_PATTERN, "i").test(content);
}
