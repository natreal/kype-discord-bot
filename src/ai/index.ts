/**
 * AI foundation.
 *
 * The AI system is deliberately NOT implemented yet. What exists here is the
 * safety boundary it must use when it lands:
 *
 *   AI  ->  controlled tool  ->  permission system  ->  validation
 *       ->  Discord action   ->  logging
 *
 * The AI never receives:
 * - a Discord client or REST instance,
 * - a database client,
 * - the ability to execute arbitrary code,
 * - the bot token or any other credential.
 *
 * It can only ask the registry to invoke a named, validated, permission-checked
 * tool. This keeps "AI moderation", "AI assistant" and future AI automation
 * inside the same auditable path as every other actor in the system.
 */
export {
  AiToolRegistry,
  type AiTool,
  type AiToolActionsPort,
  type AiToolCategory,
  type AiToolContext,
  type AiToolResult,
} from "../modules/ai/ai.module.js";
export { aiModule } from "../modules/ai/ai.module.js";
export { buildToolMenu, type AiMode, type AiToolMenu } from "../modules/ai/tool-menu.js";
export { AI_TOOLS } from "../modules/ai/ai-tools.js";
