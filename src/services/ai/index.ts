/**
 * AI transport layer.
 *
 * The public surface is deliberately narrow: the client (fetch-only, provider
 * agnostic) and the gateway (retry, budget, cost logging) are exported here, and
 * nothing else. Callers never import `fetch` or a provider SDK directly, so the
 * whole layer is replaceable with fakes in tests and swappable between vendors at
 * runtime by configuration alone.
 */
export {
  OpenAiCompatibleClient,
  type AiChatMessage,
  type AiClientFailureReason,
  type AiClientOptions,
  type AiClientRequest,
  type AiToolCall,
  type AiToolDeclaration,
  type AiUsage,
  type CompletionResult,
} from "./openai-compatible.client.js";
export {
  AiGateway,
  type AiBudgetState,
  type AiGatewayError,
  type AiGatewayFailureReason,
  type AiGatewayOk,
  type AiGatewayOptions,
  type AiGatewayResult,
  type AiModelLevel,
  type AiProvider,
} from "./ai.gateway.js";
export {
  AiSettingsService,
  PrismaAiProviderSettingsRepository,
  AI_PROVIDER_SETTINGS_KEY,
  envDefaultsFrom,
  type AiEnvDefaults,
  type AiProviderConfig,
  type AiProviderConfigRedacted,
  type AiProviderSettingsRepository,
  type AiProviderSettingsRow,
  type AiProviderSettingsPatch,
  type AiSettingsServiceOptions,
} from "./ai-settings.service.js";
