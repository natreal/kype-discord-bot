/**
 * Environment validation tests.
 *
 * These prove the core guarantee of the configuration layer: a misconfigured
 * deployment fails immediately, with an actionable message, and without ever
 * leaking secret values.
 */
import { describe, expect, it } from "vitest";

import { createConfig, redactConfig, redactConnectionString } from "../../src/config/config.js";
import { envSchema } from "../../src/config/env.schema.js";
import { ConfigError } from "../../src/utils/errors.js";
import { rawEnv, testConfig } from "../helpers/config.js";

describe("environment validation", () => {
  it("accepts a valid environment and exposes a typed config layer", () => {
    const config = testConfig();

    expect(config.environment).toBe("test");
    expect(config.isTest).toBe(true);
    expect(config.isProduction).toBe(false);
    expect(config.discord.token).toBe("test-token-not-a-real-secret");
    expect(config.discord.clientId).toBe("123456789012345678");
    expect(config.discord.devGuildId).toBeUndefined();
    expect(config.database.url).toContain("discord_bot_test");
    expect(config.logging.level).toBe("error");
  });

  it("applies defaults for optional values", () => {
    const parsed = envSchema.parse({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "123456789012345678",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });

    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing token with an actionable message", () => {
    const { DISCORD_TOKEN: _removed, ...withoutToken } = rawEnv();

    expect(() => createConfig(withoutToken, { loadEnvFiles: false })).toThrow(ConfigError);

    try {
      createConfig(withoutToken, { loadEnvFiles: false });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.kind).toBe("config");
      expect(configError.message).toBe("Invalid environment configuration");
      expect(Object.keys(configError.metadata ?? {})).toContain("DISCORD_TOKEN");
    }
  });

  it("rejects a client ID that is not a snowflake", () => {
    expect(() =>
      createConfig(rawEnv({ DISCORD_CLIENT_ID: "not-an-id" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-PostgreSQL DATABASE_URL", () => {
    try {
      createConfig(rawEnv({ DATABASE_URL: "mysql://localhost:3306/db" }), { loadEnvFiles: false });
      throw new Error("expected configuration validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).metadata ?? {};
      // The raw value is never echoed back: only the field and the reason.
      expect(issues["DATABASE_URL"]).toContain("PostgreSQL");
    }
  });

  it("treats an empty DISCORD_DEV_GUILD_ID as unset", () => {
    const config = testConfig({ DISCORD_DEV_GUILD_ID: "" });
    expect(config.discord.devGuildId).toBeUndefined();
  });

  it("defaults automatic command deployment to off", () => {
    const config = testConfig();

    // The foundation shipped out-of-band deployment, so an existing installation
    // must not start registering commands just because it upgraded.
    expect(config.discord.autoDeployCommands).toBe(false);
    expect(config.discord.deployScope).toBe("global");
  });

  it('reads a truthful boolean instead of coercing the string "false"', () => {
    // `z.coerce.boolean()` treats "false" as truthy, which would silently enable a
    // feature an operator explicitly disabled.
    expect(testConfig({ COMMANDS_AUTO_DEPLOY: "false" }).discord.autoDeployCommands).toBe(false);
    expect(testConfig({ COMMANDS_AUTO_DEPLOY: "true" }).discord.autoDeployCommands).toBe(true);
    expect(testConfig({ COMMANDS_AUTO_DEPLOY: "1" }).discord.autoDeployCommands).toBe(true);
    expect(testConfig({ COMMANDS_AUTO_DEPLOY: "no" }).discord.autoDeployCommands).toBe(false);
  });

  it("rejects an unknown deployment scope instead of guessing", () => {
    expect(() =>
      createConfig(rawEnv({ COMMANDS_DEPLOY_SCOPE: "guilds" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
  });

  it("defaults the deployment scope to global so commands are never listed twice", () => {
    // Discord treats command names as unique within a scope, not across scopes, so
    // the same command registered globally *and* per guild appears twice in every
    // server's picker. A default must not produce that, so `global+guilds` is only
    // reachable by asking for it.
    expect(testConfig().discord.deployScope).toBe("global");
    expect(testConfig({ DISCORD_DEV_GUILD_ID: "" }).discord.deployScope).toBe("global");
  });

  it("accepts each documented deployment scope", () => {
    for (const scope of ["global", "global+guilds", "dev-guild"] as const) {
      expect(testConfig({ COMMANDS_DEPLOY_SCOPE: scope }).discord.deployScope).toBe(scope);
    }
  });

  it("shows the deployment settings in the redacted configuration", () => {
    const redacted = JSON.stringify(redactConfig(testConfig({ COMMANDS_AUTO_DEPLOY: "true" })));

    expect(redacted).toContain("autoDeployCommands");
    expect(redacted).toContain("deployScope");
  });

  it("keeps secrets out of the redacted configuration", () => {
    const config = testConfig();
    const redacted = JSON.stringify(redactConfig(config));

    expect(redacted).not.toContain("test-token-not-a-real-secret");
    expect(redacted).not.toContain("test:test");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts credentials from a connection string", () => {
    const redacted = redactConnectionString("postgresql://user:secret@localhost:5432/db");
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("localhost");
  });

  it("defaults the AI keyword and token budget to safe values, and stays optional", () => {
    const config = testConfig();
    expect(config.ai.baseUrl).toBeUndefined();
    expect(config.ai.apiKey).toBeUndefined();
    expect(config.ai.defaultTrigger).toBe("kype");
    expect(config.ai.dailyTokenBudget).toBe(0);
    expect(config.ai.requestTimeoutMs).toBe(20_000);
  });

  it("reads AI environment variables and masks the API key in the redacted config", () => {
    const config = testConfig({
      AI_BASE_URL: "http://localhost:11434/v1",
      AI_API_KEY: "secret-key",
      AI_MODEL_FAST: "llama3",
      AI_DEFAULT_TRIGGER: "bot",
      AI_DAILY_TOKEN_BUDGET: "100000",
    });
    expect(config.ai.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.ai.apiKey).toBe("secret-key");
    expect(config.ai.modelFast).toBe("llama3");
    expect(config.ai.defaultTrigger).toBe("bot");
    expect(config.ai.dailyTokenBudget).toBe(100_000);

    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain("secret-key");
    expect(redacted).toContain("[redacted]");
  });
});
