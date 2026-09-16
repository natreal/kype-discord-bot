import { type z } from "zod";

import { loadEnvironmentFiles } from "./load-env.js";
import { envSchema, type Env, type Environment, type LogLevel, type RawEnv } from "./env.schema.js";
import { ConfigError } from "../utils/errors.js";
import { safeStringify } from "../utils/serialization.js";

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
  };

  readonly database: {
    readonly url: string;
  };

  readonly logging: {
    readonly level: LogLevel;
  };
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
    },
    database: {
      url: env.DATABASE_URL,
    },
    logging: {
      level: env.LOG_LEVEL,
    },
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
    },
    database: {
      url: config.database.url ? redactConnectionString(config.database.url) : "",
    },
    logging: {
      level: config.logging.level,
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
