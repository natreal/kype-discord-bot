import { type z } from "zod";

import { loadEnvironmentFiles } from "./load-env.js";
import {
  envSchema,
  type DeployScope,
  type Env,
  type Environment,
  type LogLevel,
  type RawEnv,
} from "./env.schema.js";
import { ConfigError } from "../utils/errors.js";
import { safeStringify } from "../utils/serialization.js";
import { readBuildInfo } from "../runtime/build-info.js";

/**
 * Typed application configuration.
 *
 * This is the only place in the project allowed to read `process.env`.
 * Consumers use the namespaced, strongly typed shape below:
 *
 * ```ts
 * config.environment
 * config.isProduction
 * config.discord.token
 * config.discord.clientId
 * config.database.url
 * config.logging.level
 * ```
 */
export interface AppConfig {
  readonly environment: Environment;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly isProduction: boolean;

  readonly discord: {
    readonly token: string;
    readonly clientId: string;
    readonly devGuildId: string | undefined;
    /**
     * Whether the bot registers its slash commands by itself.
     *
     * `false` keeps the foundation's out-of-band model (`npm run deploy:commands`);
     * `true` means every server that has the bot gets its commands, including
     * servers joined while the bot runs.
     */
    readonly autoDeployCommands: boolean;
    /** Scopes an automatic or scripted deployment targets. */
    readonly deployScope: DeployScope;
  };

  readonly database: {
    readonly url: string;
  };

  readonly logging: {
    readonly level: LogLevel;
  };

  /**
   * AI capabilities, all optional. `baseUrl`/`apiKey`/`modelFast`/`modelSmart`
   * are `undefined` when the operator has not configured a provider, which is the
   * signal the AI module keys on to stay inert rather than fail at startup.
   */
  readonly ai: {
    readonly baseUrl: string | undefined;
    readonly apiKey: string | undefined;
    readonly modelFast: string | undefined;
    readonly modelSmart: string | undefined;
    /** Hard daily token budget; `0` means unlimited. */
    readonly dailyTokenBudget: number;
    /** Per-request timeout in milliseconds. */
    readonly requestTimeoutMs: number;
    /** Default keyword trigger (a guild may override it). */
    readonly defaultTrigger: string;
    /** Optional persona/tone appended to the agent system prompt. */
    readonly persona: string | undefined;
  };

  /**
   * Which commit this build came from, stamped by `npm run build`.
   *
   * `null` when the stamp is missing (a `tsx` dev run, a fresh clone before the
   * first build). Verified after a deploy so "the bot restarted" can be told apart
   * from "the bot is running the code I pushed".
   */
  readonly build: {
    readonly commit: string;
    readonly subject: string;
    readonly builtAt: string;
    readonly dirty: boolean;
  } | null;
}

const SECRET_KEYS = ["token", "url"] as const;

/** Builds the public configuration object from validated environment values. */
function buildConfig(env: Env): AppConfig {
  return {
    environment: env.NODE_ENV,
    isDevelopment: env.NODE_ENV === "development",
    isTest: env.NODE_ENV === "test",
    isProduction: env.NODE_ENV === "production",
    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      devGuildId: env.DISCORD_DEV_GUILD_ID,
      autoDeployCommands: env.COMMANDS_AUTO_DEPLOY,
      deployScope: env.COMMANDS_DEPLOY_SCOPE,
    },
    database: {
      url: env.DATABASE_URL,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
    ai: {
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      modelFast: env.AI_MODEL_FAST,
      modelSmart: env.AI_MODEL_SMART,
      dailyTokenBudget: env.AI_DAILY_TOKEN_BUDGET,
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      defaultTrigger: env.AI_DEFAULT_TRIGGER,
      persona: env.AI_PERSONA,
    },
    build: readBuildInfo(),
  };
}

/**
 * Validates raw environment values and returns the typed configuration.
 *
 * @throws ConfigError with a redacted, field-by-field report when validation
 * fails. Reported values are never the raw secret; only the failing field names
 * and Zod messages are surfaced.
 */
export function createConfig(
  raw: RawEnv = process.env as RawEnv,
  options: { loadEnvFiles?: boolean } = {},
): AppConfig {
  if (options.loadEnvFiles !== false) {
    loadEnvironmentFiles();
  }

  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ConfigError("Invalid environment configuration", buildIssues(parsed.error));
  }

  return buildConfig(parsed.data);
}

/** Converts a Zod error into redacted, serializable issue descriptions. */
function buildIssues(error: z.ZodError): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    // Avoid duplicating the same field when multiple rules fail.
    issues[path] ??= issue.message;
  }
  return issues;
}

/**
 * Returns a copy of the configuration that is safe to log or serialize.
 * Secret values are replaced with a fixed placeholder.
 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    discord: {
      token: config.discord.token ? "[redacted]" : "",
      clientId: config.discord.clientId,
      devGuildId: config.discord.devGuildId ?? null,
      autoDeployCommands: config.discord.autoDeployCommands,
      deployScope: config.discord.deployScope,
    },
    database: {
      url: config.database.url ? redactConnectionString(config.database.url) : "",
    },
    logging: {
      level: config.logging.level,
    },
    ai: {
      baseUrl: config.ai.baseUrl ?? null,
      // The API key is a credential and must never survive into logs or
      // diagnostics, even redacted ones, so it collapses to a boolean presence.
      apiKey: config.ai.apiKey ? "[redacted]" : null,
      modelFast: config.ai.modelFast ?? null,
      modelSmart: config.ai.modelSmart ?? null,
      dailyTokenBudget: config.ai.dailyTokenBudget,
      requestTimeoutMs: config.ai.requestTimeoutMs,
      defaultTrigger: config.ai.defaultTrigger,
      persona: config.ai.persona ?? null,
    },
  } satisfies Record<string, unknown>;
}

/** Removes the userinfo (credentials) portion of a connection string. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return "[redacted]";
  }
}

/** Convenience helper used by diagnostics: never throws on cyclic input. */
export function describeConfigIssues(issues: Record<string, string>): string {
  return safeStringify(issues);
}

export { SECRET_KEYS };
