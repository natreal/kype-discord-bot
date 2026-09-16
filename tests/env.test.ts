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
});
