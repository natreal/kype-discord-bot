export { ConfigService, type ConfigSection } from "./config.service.js";
export {
  SETUP_SECTIONS,
  aiConfigSchema,
  automationConfigSchema,
  defaultGuildConfig,
  guildConfigSchema,
  loggingConfigSchema,
  memberConfigSchema,
  moderationConfigSchema,
  securityConfigSchema,
  setupStateSchema,
  snowflakeSchema,
  supportedLanguageSchema,
  ticketConfigSchema,
  type GuildConfig,
  type SetupSection,
} from "./guild-config.schema.js";
export { deepMerge, isPlainObject } from "./merge.js";
