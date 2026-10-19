/**
 * The AI tool menu, built deterministically from the guild's `ai.mode`.
 *
 * The menu is a pure function of configuration so it is trivially testable and
 * cannot be influenced by the model: given a mode (and, for `custom`, the ticked
 * categories) it selects exactly which of the registered tools the agent may
 * offer. The model only ever *chooses from* this menu; it never expands it, which
 * is what keeps "the AI cannot improvise a capability" a structural fact rather
 * than a prompt instruction.
 */
import type { AiTool } from "./ai.module.js";

/** The three agent surfaces. */
export type AiMode = "strict" | "large" | "custom";

/**
 * The category vocabulary. It is the single source of "what groups exist": a tool
 * declares a category from here, and `buildToolMenu` gates by it, so a tool can
 * never be silently dropped by a typo in a category string anywhere else.
 */
export const AI_TOOL_CATEGORIES = [
  "roles",
  "channels",
  "messages",
  "summary",
  "history",
  "moderation",
  "memory",
  "recommendation",
  "permissions",
  "threads",
  "tickets",
  "webhooks",
  "categories",
  "destructive",
] as const;

export type AiToolCategoryName = (typeof AI_TOOL_CATEGORIES)[number];

/**
 * Categories whose tools are *safe* by construction: they read state or produce
 * reversible, low-risk effects (create a role, send a message, remember a note).
 * `strict` mode exposes only these.
 *
 * The order matters for `/ai tools` rendering: it is the digest order.
 */
export const STRICT_CATEGORIES: readonly AiToolCategoryName[] = [
  "roles",
  "channels",
  "messages",
  "summary",
  "history",
  "memory",
  "recommendation",
];

/**
 * Categories with genuinely sensitive effects — bans, kicks, purges, permission
 * and channel deletion. Enabled *by default* in `large` mode, exactly as the
 * brief requires: "full control if the permissions allow it". The deterministic
 * layer still re-checks the author's granular permissions per tool, so enabling
 * the category widens the *menu*, never the *authority* of any single caller.
 */
export const SENSITIVE_CATEGORIES: readonly AiToolCategoryName[] = [
  "moderation",
  "permissions",
  "threads",
  "tickets",
  "webhooks",
  "categories",
  "destructive",
];

/** Every category the system knows, in stable display order. */
export const ALL_AI_CATEGORIES: readonly AiToolCategoryName[] = [
  ...STRICT_CATEGORIES,
  ...SENSITIVE_CATEGORIES,
];

/** A resolved tool menu. */
export interface AiToolMenu {
  readonly mode: AiMode;
  readonly tools: readonly AiTool<unknown, unknown>[];
  readonly categories: readonly AiToolCategoryName[];
}

/**
 * Selects the active tool menu from a guild's AI configuration.
 *
 * @param registryTools The full registry contents.
 * @param mode The guild's `ai.mode`.
 * @param enabledCategories The guild's `ai.enabledCategories` (custom only).
 * @returns the tools the agent may offer, in registry order.
 */
export function buildToolMenu(
  registryTools: readonly AiTool<unknown, unknown>[],
  mode: AiMode,
  enabledCategories: readonly string[] = [],
): AiToolMenu {
  if (mode === "custom") {
    const ticked = new Set(enabledCategories);
    const tools = registryTools.filter((tool) => ticked.has(tool.category));
    const categories = ALL_AI_CATEGORIES.filter((category) => ticked.has(category));
    return { mode, tools, categories };
  }

  const allowed: ReadonlySet<AiToolCategoryName> =
    mode === "large" ? new Set(ALL_AI_CATEGORIES) : new Set(STRICT_CATEGORIES);

  const tools = registryTools.filter((tool) => allowed.has(tool.category));
  const categories = ALL_AI_CATEGORIES.filter((category) => allowed.has(category));
  return { mode, tools, categories };
}

/** @returns human-readable labels for the mode and category lists. */
export function categoriesIn(mode: AiMode, enabledCategories: readonly string[]): readonly AiToolCategoryName[] {
  return buildToolMenu([], mode, enabledCategories).categories;
}
