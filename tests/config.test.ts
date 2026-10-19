/**
 * Guild configuration tests.
 *
 * The key guarantees: configuration always has safe defaults, is guild-specific,
 * and rejects invalid values before they are persisted.
 */
import { describe, expect, it, vi } from "vitest";

import { ConfigService } from "../../src/services/config/config.service.js";
import { PrismaGuildConfigRepository } from "../../src/services/config/guild-config.repository.js";
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
  const service = new ConfigService({
    database: database as unknown as DatabaseService,
    logger,
    repository: database.configRepository,
  });
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
    expect(config.tickets.memberTicketLimit).toBe(3);
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
    // The per-member ticket ceiling is a bounded integer, so a zero or a runaway value
    // is rejected before it reaches the database.
    expect(() => guildConfigSchema.parse({ tickets: { memberTicketLimit: 0 } })).toThrow();
    expect(() => guildConfigSchema.parse({ tickets: { memberTicketLimit: 26 } })).toThrow();
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

  it("peeks configuration without creating a guild row", async () => {
    const { service, database } = createService();

    // The maintenance gate runs on every interaction, autocomplete included: a read
    // there must not write to `guilds`.
    const config = await service.peek("111111111111111111");

    expect(config.language).toBe("en");
    expect(config.maintenance.enabled).toBe(false);
    expect(database.guilds.size).toBe(0);
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

describe("PrismaGuildConfigRepository.ensureGuild", () => {
  /** Captures the upsert payload instead of talking to PostgreSQL. */
  function createRepository(): { repository: PrismaGuildConfigRepository; calls: unknown[] } {
    const calls: unknown[] = [];
    const prisma = {
      guild: {
        upsert(args: unknown) {
          calls.push(args);
          return Promise.resolve({});
        },
      },
    };
    return {
      repository: new PrismaGuildConfigRepository(prisma as never),
      calls,
    };
  }

  it("updates the name when the caller knows it", async () => {
    const { repository, calls } = createRepository();

    await repository.ensureGuild("111111111111111111", "Real Guild");

    expect(calls[0]).toMatchObject({ update: { name: "Real Guild" } });
  });

  it("does not rename a guild to the placeholder", async () => {
    const { repository, calls } = createRepository();

    // Interaction paths pass no name; that must not overwrite display data.
    await repository.ensureGuild("111111111111111111", "unknown");

    expect(calls[0]).toMatchObject({ update: {} });
  });
});
