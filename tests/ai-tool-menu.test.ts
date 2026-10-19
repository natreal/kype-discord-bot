/**
 * `buildToolMenu` tests: the deterministic, mode-gated tool selection.
 */
import { describe, expect, it } from "vitest";

import { AI_TOOLS } from "../src/modules/ai/ai-tools.js";
import {
  STRICT_CATEGORIES,
  SENSITIVE_CATEGORIES,
  buildToolMenu,
} from "../src/modules/ai/tool-menu.js";

describe("buildToolMenu", () => {
  it("strict mode exposes only safe categories", () => {
    const menu = buildToolMenu(AI_TOOLS, "strict");
    expect(menu.mode).toBe("strict");
    for (const tool of menu.tools) {
      expect(STRICT_CATEGORIES).toContain(tool.category);
    }
    // No sensitive (moderation) tool should leak into strict mode.
    expect(menu.tools.some((tool) => tool.category === "moderation")).toBe(false);
  });

  it("large mode includes the sensitive tools", () => {
    const menu = buildToolMenu(AI_TOOLS, "large");
    const names = new Set(menu.tools.map((tool) => tool.name));
    expect(names.has("ban")).toBe(true);
    expect(names.has("kick")).toBe(true);
    expect(names.has("timeout")).toBe(true);
    expect(names.has("purge")).toBe(true);
    expect(menu.mode).toBe("large");
  });

  it("large mode exposes strictly more tools than strict mode", () => {
    const strict = new Set(buildToolMenu(AI_TOOLS, "strict").tools.map((tool) => tool.name));
    const large = new Set(buildToolMenu(AI_TOOLS, "large").tools.map((tool) => tool.name));
    // Everything strict has, large has too...
    for (const name of strict) {
      expect(large.has(name)).toBe(true);
    }
    // ...plus the create/rename/destroy capabilities that only large unlocks.
    for (const name of [
      "delete_role",
      "create_category",
      "rename_category",
      "delete_category",
      "create_thread",
      "edit_thread",
      "delete_thread",
    ]) {
      expect(large.has(name)).toBe(true);
      expect(strict.has(name)).toBe(false);
    }
    expect(large.size).toBeGreaterThan(strict.size);
  });

  it("those large-only tools remain role/channel management, not out of menu", () => {
    // Regression guard: the management tools must be registered (an unregistered
    // tool is unreachable even in large mode).
    const large = buildToolMenu(AI_TOOLS, "large");
    const categories = new Set(large.tools.map((tool) => tool.category));
    expect(categories).toContain("categories");
    expect(categories).toContain("threads");
    expect(categories).toContain("destructive");
  });

  it("custom mode exposes only the ticked categories", () => {
    const menu = buildToolMenu(AI_TOOLS, "custom", ["roles"]);
    expect(menu.tools.length).toBeGreaterThan(0);
    for (const tool of menu.tools) {
      expect(tool.category).toBe("roles");
    }
  });

  it("custom mode with no categories exposes nothing", () => {
    const menu = buildToolMenu(AI_TOOLS, "custom", []);
    expect(menu.tools).toEqual([]);
  });

  it("reports large-mode categories include sensitive ones", () => {
    const menu = buildToolMenu(AI_TOOLS, "large");
    expect(menu.categories).toEqual(expect.arrayContaining(SENSITIVE_CATEGORIES));
  });
});
