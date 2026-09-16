/**
 * Guild configuration tests.
 *
 * The key guarantees: configuration always has safe defaults, is guild-specific,
 * and rejects invalid values before they are persisted.
 */
import { describe, expect, it, vi } from "vitest";

import { ConfigService } from "../../src/services/config/config.service.js";
import {
  defaultGuildConfig,
  guildConfigSchema,
  SETUP_SECTIONS,
} from "../../src/services/config/guild-config.schema.js";
import { deepMerge } from "../../src/services/config/merge.js";
import { ValidationError } from "../../src/utils/errors.js";
import { memoryDatabaseStub } from "../helpers/database.js";
import type { DatabaseService } from "../../src/services/database/index.js";

function createService(): {
  service: ConfigService;
  database: ReturnType<typeof memoryDatabaseStub>;
} {
  const database = memoryDatabaseStub();
  const logger = {
    scope: "test",
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withContext: () => logger,
  };
  const service = new ConfigService(database as unknown as DatabaseService, logger);
  return { service, database };
}

describe("guild configuration defaults", () => {
  it("produces a complete, validated configuration from an empty object", () => {
    const config = defaultGuildConfig();

    expect(config.language).toBe("en");
    expect(config.logging.enabled).toBe(false);
    expect(config.logging.channelId).toBeNull();
    expect(config.logging.events.moderation).toBe(true);
    expect(config.moderation.enabled).toBe(true);
    expect(config.moderation.warnThreshold).toBe(3);
    expect(config.security.enabled).toBe(false);
    expect(config.security.antiRaid.joinsPerMinute).toBe(10);
    expect(config.ai.enabled).toBe(false);
    expect(config.tickets.enabled).toBe(false);
    expect(config.automation.timezone).toBe("UTC");
    expect(config.members.autoRoleIds).toEqual([]);
    expect(config.setup.completedSections).toEqual([]);
    expect(config.setup.resources).toEqual({});
    expect(config.setup.lastRunAt).toBeNull();
  });

  it("defaults are stable (no shared mutable state between calls)", () => {
    const first = defaultGuildConfig();
    first.members.autoRoleIds.push("111111111111111111");
    first.logging.events.moderation = false;

    const second = defaultGuildConfig();
    expect(second.members.autoRoleIds).toEqual([]);
    expect(second.logging.events.moderation).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(() => guildConfigSchema.parse({ moderation: { warnThreshold: -5 } })).toThrow();
    expect(() => guildConfigSchema.parse({ logging: { channelId: "not-a-snowflake" } })).toThrow();
    expect(() => guildConfigSchema.parse({ language: "klingon" })).toThrow();
  });

  it("exposes the sections the setup system orchestrates", () => {
    expect(SETUP_SECTIONS).toContain("logging");
    expect(SETUP_SECTIONS).toContain("security");
    expect(SETUP_SECTIONS).toContain("ai");
  });
});

describe("deepMerge", () => {
  it("merges nested objects and replaces arrays", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2, 3] }, { a: { c: 3 }, list: [9] });

    expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });

  it("ignores undefined values so partial updates cannot erase data", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: undefined })).toEqual({ a: 1, b: 2 });
  });
});

describe("ConfigService", () => {
  it("returns defaults for a guild that does not exist yet", async () => {
    const { service } = createService();
    const config = await service.get("111111111111111111", "Test Guild");

    expect(config.language).toBe("en");
    expect(config.moderation.warnThreshold).toBe(3);
  });

  it("persists updates per guild and merges partial changes", async () => {
    const { service } = createService();
    const guildId = "111111111111111111";

    await service.update(guildId, { logging: { enabled: true, channelId: "222222222222222222" } });
    const updated = await service.update(guildId, { logging: { enabled: false } });

    // Untouched fields survive a partial update.
    expect(updated.logging.channelId).toBe("222222222222222222");
    expect(updated.logging.enabled).toBe(false);
    expect(updated.logging.events.memberJoin).toBe(true);
  });

  it("keeps guild configuration isolated between guilds", async () => {
    const { service } = createService();

    await service.update("111111111111111111", { language: "fr" });
    const other = await service.get("222222222222222222", "Other Guild");

    expect(other.language).toBe("en");
  });

  it("rejects unknown configuration sections", async () => {
    const { service } = createService();

    await expect(
      service.update("111111111111111111", { doesNotExist: true } as never),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects invalid values with a validation error", async () => {
    const { service } = createService();

    await expect(
      service.update("111111111111111111", { moderation: { warnThreshold: 999 } }),
    ).rejects.toThrow(ValidationError);
  });

  it("falls back to defaults when stored configuration is corrupt", async () => {
    const { service, database } = createService();
    database.seedGuildSettings("111111111111111111", { moderation: { warnThreshold: "bad" } });

    const config = await service.get("111111111111111111", "Guild");
    expect(config.moderation.warnThreshold).toBe(3);
  });

  it("ensures a guild row exists on demand (idempotent)", async () => {
    const { service, database } = createService();

    await service.ensureGuild("111111111111111111", "Guild");
    await service.ensureGuild("111111111111111111", "Guild");

    expect(database.guilds.size).toBe(1);
  });
});
