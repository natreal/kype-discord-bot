/**
 * AI module public surface.
 *
 * Everything an owner of the AI feature needs — the tool registry, the tools, the
 * menu builder, the agent and the memory service — is exported here. The Prisma
 * repository and concrete providers stay implementation details, so callers
 * depend on interfaces and can swap in fakes for tests.
 */
export {
  AiToolRegistry,
  aiModule,
  type AiTool,
  type AiToolActionsPort,
  type AiToolCategory,
  type AiToolContext,
  type AiToolResult,
} from "./ai.module.js";
export {
  AI_TOOL_CATEGORIES,
  ALL_AI_CATEGORIES,
  SENSITIVE_CATEGORIES,
  STRICT_CATEGORIES,
  buildToolMenu,
  type AiMode,
  type AiToolCategoryName,
  type AiToolMenu,
} from "./tool-menu.js";
export { AI_TOOLS, toolsByName } from "./ai-tools.js";
export {
  resolveTrigger,
  startsWithKeyword,
  resolveIntent,
  intentNote,
  MODERATION_INTENTS,
  INTENT_SYNONYMS,
  AMBIGUOUS_TERMS,
  type IntentResolution,
  type ModerationIntent,
} from "./keyword.js";
export {
  AiAgentService,
  MAX_TOOL_CALLS,
  type AiAgentOptions,
  type AiAgentReport,
  type AiAgentRequest,
} from "./ai-agent.service.js";
export {
  AiMemoryService,
  type AiMemoryServiceOptions,
  type AiMemoryResult,
} from "./ai-memory.service.js";
export { PrismaAiGuildMemoryRepository } from "./ai-memory.repository.js";
export { DiscordAiActions } from "./discord-ai-actions.js";
export { TicketAiActions } from "./ticket-ai-actions.js";
export {
  AI_MEMORY_KINDS,
  AI_MEMORY_LIMITS,
  type AiGuildMemoryKind,
  type AiGuildMemoryRecord,
  type AiGuildMemoryRepository,
} from "./ai-memory.types.js";
