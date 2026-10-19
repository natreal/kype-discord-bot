export {
  isBotModule,
  type BotModule,
  type ModuleContext,
  type ModuleTicketContext,
  type SetupAction,
  type SetupActionResult,
} from "./module.types.js";
export { DiscordSetuper } from "./setuper.js";
export {
  SETUP_RESOURCE_TYPES,
  isSetupResourceType,
  type EnsureCategoryOptions,
  type EnsureRoleOptions,
  type EnsureTextChannelOptions,
  type ResolvedSetupResource,
  type ReuseResult,
  type SetupActionResultEntry,
  type SetupPermissionOverwrite,
  type SetupPermissionTarget,
  type SetupReport,
  type SetupResource,
  type SetupResourceDefinition,
  type SetupResourceIdentity,
  type SetupResourceRecord,
  type SetupResourceType,
  type Setuper,
  type TrackedResolution,
} from "./setup.types.js";
export {
  SETUP_MODULE_NAME,
  SetupService,
  type SetupModuleResolver,
  type SetupScope,
  type SetupServiceOptions,
  type SetuperFactory,
} from "./setup.service.js";
export { botModules, findModule } from "./registry.js";
export { CORE_RESOURCES, coreModule } from "./core/core.module.js";
export { LOGGING_RESOURCES, loggingModule } from "./logging/logging.module.js";
export { MODERATION_RESOURCES, moderationModule } from "./moderation/moderation.module.js";
export { MEMBERS_MODULE_NAME, MEMBERS_RESOURCES, membersModule } from "./members/members.module.js";
export { SECURITY_RESOURCES, securityModule } from "./security/security.module.js";
export {
  SCHEDULER_MODULE_NAME,
  SCHEDULER_RESOURCES,
  schedulerModule,
} from "./scheduler/scheduler.module.js";
export {
  TICKET_DEFAULT_CATEGORIES,
  TICKET_RESOURCES,
  ticketModule,
} from "./tickets/ticket.module.js";
export {
  AiToolRegistry,
  aiModule,
  type AiTool,
  type AiToolActionsPort,
  type AiToolCategory,
  type AiToolContext,
  type AiToolResult,
} from "./ai/ai.module.js";
export {
  ALL_AI_CATEGORIES,
  AI_TOOL_CATEGORIES,
  SENSITIVE_CATEGORIES,
  STRICT_CATEGORIES,
  buildToolMenu,
  type AiMode,
  type AiToolCategoryName,
  type AiToolMenu,
} from "./ai/tool-menu.js";
export { AI_TOOLS, toolsByName } from "./ai/ai-tools.js";
export {
  AiAgentService,
  MAX_TOOL_CALLS,
  type AiAgentOptions,
  type AiAgentReport,
  type AiAgentRequest,
} from "./ai/ai-agent.service.js";
export {
  AiMemoryService,
  type AiMemoryServiceOptions,
  type AiMemoryResult,
} from "./ai/ai-memory.service.js";
export { PrismaAiGuildMemoryRepository } from "./ai/ai-memory.repository.js";
export {
  AI_MEMORY_KINDS,
  AI_MEMORY_LIMITS,
  type AiGuildMemoryKind,
  type AiGuildMemoryRecord,
  type AiGuildMemoryRepository,
} from "./ai/ai-memory.types.js";
export * from "./setup/index.js";
