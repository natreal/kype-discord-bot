/**
 * Test helper: builds a valid raw environment object.
 *
 * Tests that exercise configuration validation should tweak a copy of this
 * rather than relying on the developer's real `.env`.
 */
import { createConfig, type AppConfig } from "../src/config/config.js";
import type { RawEnv } from "../src/config/env.schema.js";

/** Raw environment values accepted by every test. */
export const VALID_RAW_ENV = {
  NODE_ENV: "test",
  DISCORD_TOKEN: "test-token-not-a-real-secret",
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_DEV_GUILD_ID: "",
  DATABASE_URL: "postgresql://test:test@localhost:5432/discord_bot_test?schema=public",
  LOG_LEVEL: "error",
} satisfies RawEnv;

/** Builds a `RawEnv` with overrides applied on top of the valid baseline. */
export function rawEnv(overrides: Partial<RawEnv> = {}): RawEnv {
  return { ...VALID_RAW_ENV, ...overrides };
}

/**
 * Builds a validated `AppConfig`.
 *
 * `loadEnvFiles: false` keeps tests hermetic: they never read the developer's
 * `.env`, so results are identical on every machine and in CI.
 */
export function testConfig(overrides: Partial<RawEnv> = {}): AppConfig {
  return createConfig(rawEnv(overrides), { loadEnvFiles: false });
}
