/**
 * Keyword triggering helpers, pure and side-effect free.
 *
 * Kept separate from the `messageCreate` handler so the trigger semantics — the
 * resolved word, the whole-word match — are unit-testable without importing an
 * event module (which registers a handler as a side effect).
 */

/**
 * @returns the effective trigger: a guild override takes precedence over the
 * process-wide default, so one deployment can serve many servers with different
 * wake words.
 */
export function resolveTrigger(guildTrigger: string | null, defaultTrigger: string): string {
  return (guildTrigger ?? defaultTrigger).toLowerCase();
}

/**
 * @returns the message content after the leading whole-word `keyword`, or `null`
 * when the message does not address the agent.
 *
 * The match is deliberately strict: the keyword must sit at the very start and be
 * followed by whitespace or end-of-string, so "kypex" or a mid-sentence mention
 * never fires the agent (the false-positive the original brief called out).
 */
export function startsWithKeyword(content: string, keyword: string): string | null {
  const normalized = content.trimStart();
  const lower = normalized.toLowerCase();
  if (!lower.startsWith(keyword)) {
    return null;
  }
  const after = normalized.slice(keyword.length);
  if (after.length > 0 && !/^\s/.test(after)) {
    return null;
  }
  return after.trim();
}
/**
 * Synonym → intent mapping.
 *
 * The model is reliable at *choosing* from a menu but unreliable at reading a
 * colloquial verb: "obliterate", "yeet" or "boot" name no tool, so a model left
 * alone paraphrases the request ("I would ban them") instead of acting. This
 * table is the deterministic translation layer between the words a human types
 * and the canonical action names the tool menu exposes.
 *
 * Three deliberate properties:
 * - it is data, not a prompt instruction, so the mapping cannot be talked out of
 *   by a model and is testable without a provider;
 * - it is narrow: only the terms listed here are translated, so an unknown word
 *   keeps reaching the model exactly as before;
 * - an ambiguous term is reported as ambiguous rather than guessed at, so the
 *   agent can ask one clarifying question instead of punishing the wrong thing.
 */

/** Canonical actions a synonym can resolve to (the verbs the tool menu exposes). */
export const MODERATION_INTENTS = ["ban", "kick", "timeout", "purge", "warn"] as const;

export type ModerationIntent = (typeof MODERATION_INTENTS)[number];

/**
 * Unambiguous synonyms, by canonical intent.
 *
 * Every term here means exactly one action, so a match is a statement about what
 * the user wants rather than a guess. Phrases are matched as whole phrases, which
 * is why "wipe the chat" is listed but a bare "wipe" is not: "wipe him" must not
 * be read as a purge.
 */
export const INTENT_SYNONYMS: Readonly<Record<ModerationIntent, readonly string[]>> = {
  ban: [
    "obliterate",
    "obliterated",
    "annihilate",
    "exterminate",
    "permaban",
    "banish",
    "yeet",
    "ban",
  ],
  kick: ["boot", "kick", "eject", "throw out"],
  timeout: ["mute", "silence", "shush", "gag", "time out", "timeout"],
  purge: ["purge", "prune", "bulk delete", "clear the chat", "wipe the chat"],
  warn: ["warn", "caution"],
};

/**
 * Terms whose meaning depends on the object they are aimed at.
 *
 * "nuke the messages" is a purge, "nuke that account" is a ban. Instead of picking
 * one reading and being wrong half the time, the resolver reports every candidate
 * and the caller asks. These terms are consulted only when no unambiguous synonym
 * matched, so "obliterate and nuke him" is still read as a single ban.
 */
export const AMBIGUOUS_TERMS: Readonly<Record<string, readonly ModerationIntent[]>> = {
  nuke: ["ban", "purge"],
  "get rid of": ["ban", "kick"],
};

/** What a message means in terms of the canonical actions. */
export interface IntentResolution {
  /** The terms that matched. */
  readonly matchedTerms: readonly string[];
  /** Every action those terms could mean. */
  readonly intents: readonly ModerationIntent[];
  /** True when exactly one action is implied and no ambiguous term was needed. */
  readonly confident: boolean;
  /** The question to ask the user when `confident` is false. */
  readonly clarification?: string;
}

/**
 * @returns the named action a message is asking for, or `null` when the message
 * names no known action — the common case: most messages are questions, not
 * commands, and must reach the model untouched.
 *
 * An unambiguous synonym always wins over an ambiguous one, so "obliterate" is a
 * ban even in a sentence that also says "nuke".
 */
export function resolveIntent(text: string): IntentResolution | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const matchedTerms: string[] = [];
  const intents = new Set<ModerationIntent>();

  for (const intent of MODERATION_INTENTS) {
    const term = INTENT_SYNONYMS[intent].find((candidate) => containsTerm(normalized, candidate));
    if (term === undefined) {
      continue;
    }
    matchedTerms.push(term);
    intents.add(intent);
  }

  if (intents.size > 0) {
    // One or more plain verbs ("kick then ban") is a clear request; the model
    // chooses the order, this layer does not ask about it.
    return { matchedTerms, intents: [...intents], confident: true };
  }

  for (const [term, candidates] of Object.entries(AMBIGUOUS_TERMS)) {
    if (!containsTerm(normalized, term)) {
      continue;
    }
    matchedTerms.push(term);
    for (const candidate of candidates) {
      intents.add(candidate);
    }
  }

  if (intents.size === 0) {
    return null;
  }

  const resolved = [...intents];
  if (resolved.length === 1) {
    return { matchedTerms, intents: resolved, confident: true };
  }

  return {
    matchedTerms,
    intents: resolved,
    confident: false,
    clarification: clarificationFor(matchedTerms[0] ?? text.trim(), resolved),
  };
}

/**
 * @returns a note to append to the prompt for the model, or `null` when the
 * message already used a canonical verb and there is nothing to translate.
 *
 * The note is phrased as an interpretation, not as a permission: the tool menu
 * and the permission checks still decide whether the action may happen, so a
 * wrong translation can only produce a refusal — never an unauthorised action.
 */
export function intentNote(resolution: IntentResolution): string | null {
  const translated = resolution.matchedTerms.filter(
    (term) => !(resolution.intents as readonly string[]).includes(term),
  );
  if (translated.length === 0) {
    return null;
  }
  const quoted = translated.map((term) => `"${term}"`).join(", ");
  return `[intent mapping: ${quoted} means ${resolution.intents.join(" / ")}. Call the matching tool instead of describing the action.]`;
}

/** @returns the clarifying question for an ambiguous term. */
function clarificationFor(term: string, intents: readonly ModerationIntent[]): string {
  const options = intents.map((intent) => `\`${intent}\``).join(" or ");
  return `"${term}" could mean ${options} — which one do you want? Name one and I'll do it.`;
}

/** @returns true when `term` occurs in `text` as a whole word or phrase. */
function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}
