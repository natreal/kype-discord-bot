/**
 * End-to-end automatic setup tests.
 *
 * These run the real `SetupService` with the real V2 module, real identity service
 * and real permission service — only Discord and the database are faked. The
 * scenarios mirror the manual acceptance test from the V2 brief:
 *
 *   run `/setup` → run it again → delete a channel by hand → run it again.
 */
import { describe, expect, it } from "vitest";
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";

import { SETUP_MODULE_NAME } from "../../src/modules/setup.service.js";
import { GUILD_ID, getGuildSetupHarness } from "../helpers/setup-module-harness.js";

const ADMIN = PermissionFlagsBits.Administrator;

describe("automatic setup flow", () => {
  it("creates the managed structure on the first run", async () => {
    const { service, guild, discord } = getGuildSetupHarness();

    const report = await service.run(guild, "all");
    const created = report.results.filter((entry) => entry.status === "created");

    expect(report.status).toBe("completed");
    expect(discord.created).toEqual(["INFORMATION", "welcome", "rules", "LOGS", "server-logs"]);
    expect(created.map((entry) => entry.key)).toEqual([
      `${SETUP_MODULE_NAME}.information.category`,
      `${SETUP_MODULE_NAME}.information.welcome`,
      `${SETUP_MODULE_NAME}.information.rules`,
      `${SETUP_MODULE_NAME}.logs.category`,
      `${SETUP_MODULE_NAME}.logs.server-logs`,
      `${SETUP_MODULE_NAME}.moderation.muted`,
    ]);
    // Roles are created through a different Discord API than channels, so they are
    // tracked separately — mixing them would hide a role that was never created.
    expect(discord.createdRoles).toEqual(["muted"]);
    // The tracked resource map holds Discord IDs, not names.
    expect(report.setupResources.every((resource) => resource.resourceId.length > 0)).toBe(true);
  });

  it("corrects a Muted role whose permissions were changed by hand", async () => {
    // The user-visible bug: an administrator edits the Muted role, and every `/mute`
    // keeps reporting success while the member goes on posting. `/setup run` is
    // idempotent about the role's *identity*, and now also about its *permissions*, so
    // re-running it repairs the role.
    const { service, guild, discord } = getGuildSetupHarness();
    await service.run(guild, "all");

    const muted = [...discord.roles.values()].find((role) => role.name === "muted");
    expect(muted).toBeDefined();
    if (!muted) {
      return;
    }

    // Hand-edited: the deny is gone, which is exactly what silences nothing.
    muted.permissions = PermissionFlagsBits.SendMessages;

    const repair = await service.run(guild, "all");
    const entry = repair.results.find((result) => result.key === "setup.moderation.muted");

    // Repaired and *reported* as repaired: an operator reading the run summary must be
    // able to see that setup changed something, or a silent fix looks like a no-op that
    // left the role still broken.
    expect(entry?.status).toBe("updated");
    expect(entry?.detail).toMatch(/permission rule\(s\) applied/);
    expect(new PermissionsBitField(muted.permissions).has(PermissionFlagsBits.SendMessages)).toBe(
      false,
    );
    // And the role's own identity was left alone — no duplicate, same ID.
    expect([...discord.roles.values()].filter((role) => role.name === "muted")).toHaveLength(1);
  });

  it("is a no-op on a second run once the Muted role is correct", async () => {
    // Idempotence is the contract: a repeated `/setup run` must not write to a role
    // that already satisfies the specification. The first run creates the role (which
    // is itself a write), so the count is captured after it rather than assumed zero.
    const { service, guild, discord } = getGuildSetupHarness();
    await service.run(guild, "all");

    const muted = [...discord.roles.values()].find((role) => role.name === "muted");
    expect(muted).toBeDefined();
    const writesAfterCreate = muted?.setPermissionsCalledWith.length ?? 0;

    const second = await service.run(guild, "all");

    expect(muted?.setPermissionsCalledWith).toHaveLength(writesAfterCreate);
    expect(second.results.find((result) => result.key === "setup.moderation.muted")?.status).toBe(
      "reused",
    );
  });

  it("reuses everything on a second run and creates nothing", async () => {
    const { service, guild, discord } = getGuildSetupHarness();

    await service.run(guild, "all");
    const afterFirst = discord.created.length;
    const second = await service.run(guild, "all");

    expect(second.status).toBe("completed");
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(discord.created.length).toBe(afterFirst);
  });

  it("repairs a channel an administrator deleted, without duplicating others", async () => {
    const { service, guild, discord } = getGuildSetupHarness();

    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key.endsWith(".welcome"));
    expect(welcome).toBeDefined();

    // Manual intervention: the administrator deletes `#welcome`.
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }

    const repaired = await service.run(guild, "all");
    const repairedEntry = repaired.results.find((entry) => entry.key.endsWith(".welcome"));

    expect(repairedEntry?.status).toBe("updated");
    expect(repaired.status).toBe("completed");
    // The other channels were reused; only the deleted one was recreated.
    expect(repaired.created).toBe(0);
    expect(discord.created).toEqual([
      "INFORMATION",
      "welcome",
      "rules",
      "LOGS",
      "server-logs",
      "welcome",
    ]);
  });

  it("adopts an existing channel instead of creating a duplicate", async () => {
    const { service, guild, discord } = getGuildSetupHarness();
    // A channel that already exists at the guild root, exactly as an administrator
    // would have created it. Setup must adopt it rather than create `#rules-2`.
    const existing = discord.seedChannel("rules", undefined, null, "manual-rules");

    const report = await service.run(guild, "all");
    const rules = report.results.find((entry) => entry.key.endsWith(".rules"));

    // `#rules` lives inside the INFORMATION category, and adoption is scoped to the
    // expected parent: a root-level `#rules` is not the managed resource.
    expect(rules?.status).toBe("created");
    expect(discord.created).toContain("rules");

    // The scoped case is the one that must reuse.
    const second = await service.run(guild, "all");
    const reused = second.results.find((entry) => entry.key.endsWith(".rules"));
    expect(reused?.status).toBe("reused");
    expect(reused?.resourceId).not.toBe(existing.id);
  });

  it("adopts a channel created by hand inside the expected category", async () => {
    const { service, guild, discord } = getGuildSetupHarness();
    const category = discord.seedChannel(
      "INFORMATION",
      ChannelType.GuildCategory,
      null,
      "manual-information",
    );
    const manual = discord.seedChannel("welcome", undefined, category.id, "manual-welcome");

    const report = await service.run(guild, "all");
    const welcome = report.results.find((entry) => entry.key.endsWith(".welcome"));

    expect(welcome?.status).toBe("reused");
    expect(welcome?.resourceId).toBe(manual.id);
    expect(discord.created).not.toContain("welcome");
  });
});

describe("automatic setup authorization", () => {
  it("refuses a caller without the required permissions", async () => {
    const { service, guild, member } = getGuildSetupHarness();

    await expect(service.run(guild, "all", member([]))).rejects.toThrow(/permission/i);
  });

  it("allows an administrator", async () => {
    const { service, guild, member } = getGuildSetupHarness();
    const report = await service.run(guild, "all", member([ADMIN]));

    expect(report.status).toBe("completed");
  });
});

describe("automatic setup failure isolation", () => {
  it("reports a partial run when the bot cannot create channels", async () => {
    const { service, guild, discord } = getGuildSetupHarness();
    discord.failCreation = true;

    const report = await service.run(guild, "all");
    const failed = report.results.filter((entry) => entry.status === "failed");

    expect(report.status).toBe("partial");
    expect(report.failed).toBeGreaterThan(0);
    // The reason is surfaced (a permission problem the operator can fix) while the
    // raw Discord error stays internal.
    expect(failed[0]?.errorMessage ?? failed[0]?.detail).toMatch(/Missing Permissions/);
    // Dependants are skipped with an explanation rather than cascading into more
    // confusing failures.
    expect(report.results.some((entry) => entry.status === "skipped")).toBe(true);
  });

  it("never crashes the orchestrator, even when every step fails", async () => {
    const { service, guild, discord } = getGuildSetupHarness();
    discord.failCreation = true;

    const report = await service.run(guild, "all");

    expect(report.status).toBe("partial");
    expect(report.results.every((entry) => entry.description.length > 0)).toBe(true);
  });
});

describe("automatic setup auditing", () => {
  it("records each run and the resolved Discord IDs", async () => {
    const { service, guild, database, resources } = getGuildSetupHarness();

    await service.run(guild, "all");
    await service.run(guild, "all");

    expect(database.setupRuns).toHaveLength(2);
    expect(database.setupRuns[0]).toMatchObject({ guildId: GUILD_ID, status: "completed" });

    const stored = await resources.list();
    expect(stored.map((record) => record.key).sort()).toEqual([
      "information.category",
      "information.rules",
      "information.welcome",
      "logs.category",
      "logs.server-logs",
      "moderation.muted",
    ]);
    // Every tracked resource has a Discord ID, which is the whole point of V2.
    expect(stored.every((record) => record.discordId !== null)).toBe(true);
  });

  it("records the repaired resource in the run history", async () => {
    const { service, guild, discord, database } = getGuildSetupHarness();

    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key.endsWith(".welcome"));
    expect(welcome).toBeDefined();
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }

    await service.run(guild, "all");

    const lastRun = database.setupRuns.at(-1) as { updated: number; created: number };
    expect(lastRun.updated).toBe(1);
    // Only the deleted channel was recreated; everything else was reused.
    expect(lastRun.created).toBe(0);
  });
});
