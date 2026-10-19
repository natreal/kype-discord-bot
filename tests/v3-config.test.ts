/**
 * V3 configuration tests.
 *
 * The guarantees under test are the ones the brief makes non-negotiable:
 * defaults exist, guilds are isolated, validation rejects bad input, provenance is
 * reported, and every write is revisioned and audited.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/utils/errors.js";
import { GUILD_A, GUILD_B, USER_ID, createV3Harness } from "../helpers/v3-harness.js";

describe("V3 configuration scoping", () => {
  it("creates default configuration for a guild that has never been seen", async () => {
    const { config } = createV3Harness();

    const value = await config.get(GUILD_A, "Guild A");

    expect(value.language).toBe("en");
    expect(value.moderation.warnThreshold).toBe(3);
    expect(value.logging.enabled).toBe(false);
  });

  it("reports provenance: defaults versus explicitly configured", async () => {
    const { config } = createV3Harness();

    const before = await config.read(GUILD_A, "Guild A");
    expect(before.configuredSections).toEqual([]);
    expect(before.valid).toBe(true);

    await config.update(
      GUILD_A,
      { moderation: { warnThreshold: 5 } },
      { id: USER_ID, kind: "user" },
    );
    const after = await config.read(GUILD_A, "Guild A");

    expect(after.configuredSections).toEqual(["moderation"]);
    expect(after.overriddenPaths).toContain("moderation.warnThreshold");
  });

  it("keeps configuration isolated between two guilds", async () => {
    const { config } = createV3Harness();

    await config.update(GUILD_A, { language: "fr", moderation: { enabled: false } });
    const guildB = await config.get(GUILD_B, "Guild B");

    expect(guildB.language).toBe("en");
    expect(guildB.moderation.enabled).toBe(true);
    expect(await config.configuredSections(GUILD_B)).toEqual([]);
  });

  it("keeps two guilds' writes separate when they run concurrently", async () => {
    const { config, database } = createV3Harness();

    await Promise.all([
      config.update(GUILD_A, { language: "fr" }),
      config.update(GUILD_B, { language: "en", ai: { enabled: true } }),
    ]);

    expect((await config.get(GUILD_A)).language).toBe("fr");
    expect((await config.get(GUILD_A)).ai.enabled).toBe(false);
    expect((await config.get(GUILD_B)).ai.enabled).toBe(true);
    // One config row per (guild, section): no cross-contamination, no duplication.
    expect(database.configSections.size).toBe(3);
  });
});

describe("V3 configuration validation", () => {
  it("rejects an invalid value with a validation error", async () => {
    const { config } = createV3Harness();

    await expect(config.update(GUILD_A, { moderation: { warnThreshold: 999 } })).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects an unknown section", async () => {
    const { config } = createV3Harness();

    await expect(config.update(GUILD_A, { nope: true } as never)).rejects.toThrow(
      /Unknown configuration sections/,
    );
  });

  it("does not persist a section that failed validation", async () => {
    const { config, database } = createV3Harness();

    await config.update(GUILD_A, { moderation: { warnThreshold: 5 } });
    await expect(config.update(GUILD_A, { moderation: { warnThreshold: -1 } })).rejects.toThrow(
      ValidationError,
    );

    expect((await config.get(GUILD_A)).moderation.warnThreshold).toBe(5);
    expect(database.configSections.has(`${GUILD_A}:security`)).toBe(false);
  });

  it("falls back to the default for a stored section that is corrupt", async () => {
    const { config, database } = createV3Harness();
    await config.get(GUILD_A, "Guild A");

    // Simulates a hand-edited row, or a value written by an older schema.
    await database.configRepository.save(GUILD_A, "moderation", { warnThreshold: "bad" }, null);

    const result = await config.read(GUILD_A, "Guild A");
    expect(result.config.moderation.warnThreshold).toBe(3);
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toMatch(/moderation/);
  });

  it("computes a precise diff of changed paths", async () => {
    const { config } = createV3Harness();

    const before = await config.get(GUILD_A);
    const after = await config.update(GUILD_A, {
      logging: { enabled: true, events: { memberJoin: false } },
    });

    expect(config.diff(before, after).sort()).toEqual([
      "logging.enabled",
      "logging.events.memberJoin",
    ]);
  });
});

describe("V3 configuration auditing", () => {
  it("records a revision and an audit event for every write", async () => {
    const { config, database, auditEvents } = createV3Harness();

    await config.update(
      GUILD_A,
      { moderation: { warnThreshold: 7 } },
      { id: USER_ID, kind: "user" },
    );

    expect(database.configRevisions).toHaveLength(1);
    expect(database.configRevisions[0]).toMatchObject({
      guildId: GUILD_A,
      section: "moderation",
      actorId: USER_ID,
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      guildId: GUILD_A,
      action: "config.update",
      category: "config",
      actorId: USER_ID,
    });
  });

  it("marks a write by the owner account as privileged", async () => {
    const { config, auditEvents } = createV3Harness();

    await config.update(GUILD_A, { language: "fr" }, { id: "905909797927411732", kind: "god" });

    expect(auditEvents[0]?.severity).toBe("privileged");
    expect(auditEvents[0]?.actorKind).toBe("god");
  });

  it("resets a single section without touching the others", async () => {
    const { config } = createV3Harness();

    await config.update(GUILD_A, { language: "fr", moderation: { warnThreshold: 9 } });
    const after = await config.resetSection(GUILD_A, "moderation");

    expect(after.moderation.warnThreshold).toBe(3);
    // The other explicit section survives, which is what "reset one area" means.
    expect(after.language).toBe("fr");
  });

  it("migrates a V2-era stored configuration on first read", async () => {
    const { config, database } = createV3Harness();
    // A V2 installation only has `guild_settings.modules`.
    database.seedGuildSettings(GUILD_A, { language: "fr", moderation: { warnThreshold: 8 } });

    const value = await config.get(GUILD_A, "Guild A");

    expect(value.language).toBe("fr");
    expect(value.moderation.warnThreshold).toBe(8);
  });
});
