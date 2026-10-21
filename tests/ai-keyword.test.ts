/**
 * Keyword trigger resolution and whole-word matching tests.
 */
import { describe, expect, it } from "vitest";

import { replyRequest, resolveTrigger, startsWithKeyword } from "../src/modules/ai/keyword.js";

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

describe("replyRequest", () => {
  it("treats a reply to the bot as an address, keyword or not", () => {
    expect(replyRequest("et maintenant ?", { repliedToBot: true, trigger: "kype" })).toBe(
      "et maintenant ?",
    );
  });

  it("strips a leading keyword so the model never sees it as part of the request", () => {
    expect(replyRequest("kype ban @x", { repliedToBot: true, trigger: "kype" })).toBe("ban @x");
  });

  it("stays inert when the message does not reply to the bot", () => {
    expect(replyRequest("et maintenant ?", { repliedToBot: false, trigger: "kype" })).toBeNull();
  });

  it("ignores an empty reply rather than answering nothing", () => {
    expect(replyRequest("   ", { repliedToBot: true, trigger: "kype" })).toBeNull();
  });
});
