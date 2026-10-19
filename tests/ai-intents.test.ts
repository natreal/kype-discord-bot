/**
 * Intent resolution tests: the deterministic synonym layer that turns a colloquial
 * verb ("obliterate") into a concrete action, and reports an ambiguous word instead
 * of guessing at what it means.
 */
import { describe, expect, it } from "vitest";

import {
  AMBIGUOUS_TERMS,
  INTENT_SYNONYMS,
  MODERATION_INTENTS,
  intentNote,
  resolveIntent,
} from "../src/modules/ai/keyword.js";

describe("resolveIntent", () => {
  it("maps a colloquial verb onto the canonical action", () => {
    const resolution = resolveIntent("obliterate that guy");

    expect(resolution?.confident).toBe(true);
    expect(resolution?.intents).toEqual(["ban"]);
    expect(resolution?.matchedTerms).toEqual(["obliterate"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolveIntent("   OBLITERATE   him  ")?.intents).toEqual(["ban"]);
  });

  it("matches a listed phrase as one term, not a stray word", () => {
    // "wipe the chat" is a purge; a bare "wipe" is not listed, so it stays untouched.
    expect(resolveIntent("wipe the chat")?.intents).toEqual(["purge"]);
    expect(resolveIntent("wipe him")).toBeNull();
  });

  it("returns null when the message names no action at all", () => {
    expect(resolveIntent("what channels do we have?")).toBeNull();
    expect(resolveIntent("")).toBeNull();
  });

  it("never fires on a word that merely contains a synonym", () => {
    expect(resolveIntent("the kickoff meeting")).toBeNull();
    expect(resolveIntent("kype")).toBeNull();
  });

  it("prefers an unambiguous verb over an ambiguous one", () => {
    const resolution = resolveIntent("obliterate and nuke him");

    expect(resolution?.confident).toBe(true);
    expect(resolution?.intents).toEqual(["ban"]);
  });

  it("reports every action of a two-verb request without asking", () => {
    const resolution = resolveIntent("kick then ban");

    expect(resolution?.confident).toBe(true);
    expect(resolution?.intents).toEqual(["ban", "kick"]);
  });

  it("asks instead of guessing when the verb could mean two actions", () => {
    const resolution = resolveIntent("nuke the messages");

    expect(resolution?.confident).toBe(false);
    expect(resolution?.intents).toEqual(["ban", "purge"]);
    expect(resolution?.clarification).toContain("ban");
    expect(resolution?.clarification).toContain("purge");
    expect(resolution?.matchedTerms).toEqual(["nuke"]);
  });
});

describe("intentNote", () => {
  it("translates a synonym for the model", () => {
    const resolution = resolveIntent("obliterate him");

    expect(resolution).not.toBeNull();
    expect(intentNote(resolution!)).toContain("obliterate");
    expect(intentNote(resolution!)).toContain("ban");
  });

  it("adds nothing when the message already used the canonical verb", () => {
    const resolution = resolveIntent("ban him");

    expect(resolution?.confident).toBe(true);
    expect(intentNote(resolution!)).toBeNull();
  });
});

describe("intent vocabulary", () => {
  it("only lists terms that resolve, and keeps ambiguity explicit", () => {
    for (const intent of MODERATION_INTENTS) {
      const terms = INTENT_SYNONYMS[intent];
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        // A listed term must actually resolve to its own intent.
        expect(resolveIntent(term)?.intents).toContain(intent);
      }
    }

    for (const [term, intents] of Object.entries(AMBIGUOUS_TERMS)) {
      // An ambiguous term must be genuinely ambiguous, otherwise it would only ever
      // add a pointless question.
      expect(intents.length).toBeGreaterThan(1);
      expect(resolveIntent(term)?.confident).toBe(false);
    }
  });
});
