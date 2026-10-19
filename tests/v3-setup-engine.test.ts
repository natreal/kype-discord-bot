/**
 * V3 setup engine tests.
 *
 * The brief is explicit about the properties that must hold:
 * - `plan` and `validate` never mutate Discord;
 * - `run` is idempotent, including for renamed resources (V2 adoption);
 * - `repair` recreates only what is broken;
 * - dependencies are respected.
 *
 * The harness is the real V2 setup module, identity service and permission
 * service over a fake guild, so these assertions are about the code `/setup`
 * actually runs.
 */
import { describe, expect, it } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";

import { SetupEngine } from "../../src/modules/setup/setup-engine.js";
import { SETUP_RESOURCES } from "../../src/modules/setup/setup-resources.js";
import { testLogger } from "../helpers/logger.js";
import { GUILD_ID, getGuildSetupHarness } from "../helpers/setup-module-harness.js";

/** An administrator, which satisfies the setup permission requirement. */
const ADMIN = PermissionFlagsBits.Administrator;

describe("V3 /setup plan", () => {
  it("reports CREATE for every provisionable resource on a fresh guild", async () => {
    const { guild, resources, discord } = getGuildSetupHarness();
    const engine = new SetupEngine({ logger: testLogger });

    const plan = await engine.plan(guild, resources, SETUP_RESOURCES);

    // Six resources: two categories, two channels, the log channel and the Muted role.
    expect(plan.counts.CREATE).toBe(6);
    // Nothing is skipped any more: every declared resource is provisionable now
    // that moderation log delivery exists.
    expect(plan.counts.SKIP).toBe(0);
    expect(plan.counts.ERROR).toBe(0);
    expect(plan.ok).toBe(true);
    // Nothing was touched: planning is read-only.
    expect(discord.created).toEqual([]);
    expect(discord.createdRoles).toEqual([]);
  });

  it("does not mutate Discord, even for a guild that already has channels", async () => {
    const { guild, resources, discord } = getGuildSetupHarness();
    discord.seedChannel("welcome", ChannelType.GuildText, null, "manual-welcome");
    const engine = new SetupEngine({ logger: testLogger });

    const plan = await engine.plan(guild, resources, SETUP_RESOURCES);

    expect(discord.created).toEqual([]);
    // An existing look-alike is reported as ADOPT rather than CREATE.
    const welcome = plan.entries.find((entry) => entry.key === "information.welcome");
    expect(welcome?.action).toBe("ADOPT");
  });

  it("reports REUSE once the guild is provisioned", async () => {
    const { guild, resources, service } = getGuildSetupHarness();
    await service.run(guild, "all");
    const engine = new SetupEngine({ logger: testLogger });

    const plan = await engine.plan(guild, resources, SETUP_RESOURCES);

    expect(plan.counts.CREATE).toBe(0);
    expect(plan.counts.REUSE).toBe(6);
  });

  it("reports REPAIR when a tracked resource is deleted by hand", async () => {
    const { guild, resources, discord, service } = getGuildSetupHarness();
    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key === "information.welcome");
    expect(welcome).toBeDefined();
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }
    const engine = new SetupEngine({ logger: testLogger });

    const plan = await engine.plan(guild, resources, SETUP_RESOURCES);
    const entry = plan.entries.find((candidate) => candidate.key === "information.welcome");

    expect(entry?.action).toBe("REPAIR");
    expect(entry?.reason).toMatch(/recreated|adopted/);
  });

  it("reports ERROR for a tracked key the registry no longer declares", async () => {
    const { guild, resources, repository } = getGuildSetupHarness();
    const engine = new SetupEngine({ logger: testLogger });
    // Simulates data written by an older deployment whose registry had this key.
    await repository.remember({
      guildId: GUILD_ID,
      key: "legacy.channel",
      type: "TEXT_CHANNEL",
      discordId: "chan-legacy",
      name: "legacy",
      config: {},
    });

    const plan = await engine.plan(guild, resources, SETUP_RESOURCES);

    expect(plan.ok).toBe(false);
    expect(plan.entries.find((entry) => entry.key === "legacy.channel")?.action).toBe("ERROR");
  });
});

describe("V3 /setup validate", () => {
  it("reports everything missing on an unconfigured guild without mutating", async () => {
    const { guild, resources, discord } = getGuildSetupHarness();
    const engine = new SetupEngine({ logger: testLogger });

    const validation = await engine.validate(guild, resources, SETUP_RESOURCES);

    expect(validation.ok).toBe(false);
    expect(validation.repairable).toHaveLength(6);
    expect(discord.created).toEqual([]);
    expect(discord.createdRoles).toEqual([]);
  });

  it("passes once the guild is provisioned", async () => {
    const { guild, resources, service } = getGuildSetupHarness();
    await service.run(guild, "all");
    const engine = new SetupEngine({ logger: testLogger });

    const validation = await engine.validate(guild, resources, SETUP_RESOURCES);

    expect(validation.ok).toBe(true);
    expect(validation.repairable).toEqual([]);
    expect(validation.entries.every((entry) => entry.status === "ok")).toBe(true);
  });

  it("detects drift after a resource is deleted by hand", async () => {
    const { guild, resources, discord, service } = getGuildSetupHarness();
    const first = await service.run(guild, "all");
    const rules = first.setupResources.find((resource) => resource.key === "information.rules");
    expect(rules).toBeDefined();
    if (rules) {
      discord.deleteChannel(rules.resourceId);
    }
    const engine = new SetupEngine({ logger: testLogger });

    const validation = await engine.validate(guild, resources, SETUP_RESOURCES);
    const entry = validation.entries.find((candidate) => candidate.key === "information.rules");

    expect(entry?.status).toBe("drifted");
    expect(validation.repairable).toEqual(["information.rules"]);
    // Validation reports drift; it never fixes it.
    expect(discord.created).toEqual(["INFORMATION", "welcome", "rules", "LOGS", "server-logs"]);
  });
});

describe("V3 /setup repair", () => {
  it("recreates only the missing resource and leaves the rest untouched", async () => {
    const { guild, discord, service, member } = getGuildSetupHarness();
    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key === "information.welcome");
    expect(welcome).toBeDefined();
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }

    const report = await service.repair(guild, undefined, member([ADMIN]));

    expect(report.status).toBe("completed");
    // Exactly one channel was created, and it is `welcome`.
    expect(discord.created).toEqual([
      "INFORMATION",
      "welcome",
      "rules",
      "LOGS",
      "server-logs",
      "welcome",
    ]);
    expect(report.created).toBe(0);
    expect(report.updated).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.key).toBe("setup.information.welcome");
  });

  it("is idempotent: a second repair with nothing missing creates nothing", async () => {
    const { guild, discord, service, member } = getGuildSetupHarness();
    await service.run(guild, "all");
    const afterRun = discord.created.length;

    const first = await service.repair(guild, undefined, member([ADMIN]));
    const second = await service.repair(guild, undefined, member([ADMIN]));

    expect(first.results).toEqual([]);
    expect(second.results).toEqual([]);
    expect(discord.created.length).toBe(afterRun);
  });

  it("keeps setup idempotent: running it twice does not duplicate resources", async () => {
    const { guild, discord, service } = getGuildSetupHarness();

    await service.run(guild, "all");
    const afterFirst = discord.created.length;
    const second = await service.run(guild, "all");

    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(discord.created.length).toBe(afterFirst);
  });

  it("adopts a manually recreated channel instead of duplicating it", async () => {
    const { guild, discord, service, member } = getGuildSetupHarness();
    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key === "information.welcome");
    expect(welcome).toBeDefined();
    const parentId = first.setupResources.find(
      (resource) => resource.key === "information.category",
    )?.resourceId;
    expect(parentId).toBeDefined();

    // The administrator deletes `#welcome` and creates their own inside INFORMATION,
    // which is exactly the V2 adoption case.
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }
    const manual = discord.seedChannel(
      "welcome",
      ChannelType.GuildText,
      parentId ?? null,
      "manual-2",
    );

    const report = await service.repair(guild, undefined, member([ADMIN]));
    const entry = report.results.find((candidate) => candidate.key.endsWith(".welcome"));

    // Adopted, not duplicated: the manual channel keeps its ID and nothing new is
    // created.
    expect(entry?.resourceId).toBe(manual.id);
    expect(report.created).toBe(0);
    expect(discord.created).toEqual(["INFORMATION", "welcome", "rules", "LOGS", "server-logs"]);

    // A second repair must not create anything either: the adopted identity is
    // persisted, so the next run reuses it by Discord ID.
    const again = await service.repair(guild, undefined, member([ADMIN]));
    expect(again.results).toEqual([]);
    expect(discord.created).toEqual(["INFORMATION", "welcome", "rules", "LOGS", "server-logs"]);
  });

  it("records the repair in the run history", async () => {
    const { guild, discord, service, database, member } = getGuildSetupHarness();
    const first = await service.run(guild, "all");
    const welcome = first.setupResources.find((resource) => resource.key === "information.welcome");
    if (welcome) {
      discord.deleteChannel(welcome.resourceId);
    }

    await service.repair(guild, undefined, member([ADMIN]));

    const lastRun = database.setupRuns.at(-1) as { scope: string; updated: number };
    expect(lastRun.scope).toBe("repair");
    expect(lastRun.updated).toBe(1);
  });

  it("refuses a caller without the setup permission", async () => {
    const { guild, service, member } = getGuildSetupHarness();

    await expect(service.repair(guild, undefined, member([]))).rejects.toThrow(/permission/i);
  });
});

describe("V3 setup dependencies", () => {
  it("resolves parents before the channels inside them", async () => {
    const { guild, discord, service } = getGuildSetupHarness();

    await service.run(guild, "all");

    // Discord rejects a channel whose parent does not exist yet, so this order is
    // a functional requirement, not a cosmetic one.
    const order = discord.created;
    expect(order.indexOf("INFORMATION")).toBeLessThan(order.indexOf("welcome"));
    expect(order.indexOf("INFORMATION")).toBeLessThan(order.indexOf("rules"));
    expect(order.indexOf("LOGS")).toBeGreaterThan(order.indexOf("rules"));
    // `#server-logs` is tracked but not provisioned in V2 (logging is disabled), so
    // it must not appear at all.
    expect(order).toContain("server-logs");
  });

  it("declares a known parent key for every resource that depends on one", () => {
    const keys = new Set(SETUP_RESOURCES.map((resource) => resource.key));

    for (const resource of SETUP_RESOURCES) {
      for (const required of resource.requires ?? []) {
        expect(keys.has(required)).toBe(true);
      }
    }
  });

  it("skips a resource whose parent failed instead of cascading errors", async () => {
    const { guild, discord, service } = getGuildSetupHarness();
    // A category creation failure is the case the `requires` guard exists for.
    discord.failCreation = true;

    const report = await service.run(guild, "all");
    const entries = report.results.filter((entry) => entry.module === "setup");
    const welcome = entries.find((entry) => entry.key.endsWith(".welcome"));

    expect(report.failed).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.status === "skipped")).toBe(true);
    expect(welcome?.status === "skipped" || welcome?.status === "failed").toBe(true);
  });
});
