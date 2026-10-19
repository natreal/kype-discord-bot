/**
 * Keyword trigger resolution and whole-word matching tests.
 */
import { describe, expect, it } from "vitest";

import { resolveTrigger, startsWithKeyword } from "../src/modules/ai/keyword.js";

describe("resolveTrigger", () => {
  it("prefers the guild override over the process default", () => {
    expect(resolveTrigger("bot", "kype")).toBe("bot");
  });

  it("falls back to the default when the guild has no override", () => {
    expect(resolveTrigger(null, "kype")).toBe("kype");
  });

  it("is case-insensitive", () => {
    expect(resolveTrigger("KYPE", "kype")).toBe("kype");
  });
});

describe("startsWithKeyword", () => {
  it("fires only when the keyword is at the very start as a whole word", () => {
    expect(startsWithKeyword("kype fais un rôle", "kype")).toBe("fais un rôle");
    expect(startsWithKeyword("kype", "kype")).toBe("");
  });

  it("ignores a keyword that is not at the start", () => {
    expect(startsWithKeyword("bonjour kype", "kype")).toBeNull();
  });

  it("ignores a keyword that is a prefix of a longer word", () => {
    expect(startsWithKeyword("kypex est ici", "kype")).toBeNull();
  });
});
