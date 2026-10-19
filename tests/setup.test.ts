/**
 * Setup service tests.
 *
 * Setup must be idempotent, permission-aware and auditable. These tests use the
 * fake setuper, so running setup twice can be asserted to reuse resources
 * instead of duplicating them (`#logs`, `#logs-2`, ...).
 */
import { describe, expect, it } from "vitest";
import type { Guild } from "discord.js";

import { coreModule } from "../../src/modules/core/core.module.js";
import { loggingModule } from "../../src/modules/logging/logging.module.js";
import type { BotModule } from "../../src/modules/module.types.js";
import { PermissionError } from "../../src/utils/errors.js";
import { memberStub } from "../helpers/discord.js";
import { createSetupHarness, SETUP_GUILD_ID, setupGuild } from "../helpers/setup-harness.js";

const guild = setupGuild as Guild;

describe("SetupService sections and planning", () => {
  it("lists the configurable sections", () => {
    const { service } = createSetupHarness();

    expect(service.sections()).toContain("logging");
    expect(service.sections()).toContain("security");
    expect(service.sections()).toContain("ai");
  });

  it("plans actions without touching Discord", async () => {
    const { service, discord } = createSetupHarness();
    const actions = await service.plan(guild, "all");

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.map((action) => action.key)).toContain("core.category");
    expect(discord.created).toEqual([]);
  });

  it("runs registered modules and reports the outcome", async () => {
    const { service } = createSetupHarness();
    const report = await service.run(guild, "all");

    expect(report.status).toBe("completed");
    expect(report.guildId).toBe(SETUP_GUILD_ID);
    expect(report.failed).toBe(0);
    expect(report.created).toBeGreaterThan(0);
  });
});

describe("SetupService idempotency and auditing", () => {
  it("is idempotent: a second run creates nothing new", async () => {
    const { service, discord } = createSetupHarness();

    const first = await service.run(guild, "all");
    const afterFirstRun = discord.created.length;
    const second = await service.run(guild, "all");

    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    expect(discord.created.length).toBe(afterFirstRun);
    expect(second.status).toBe("completed");
  });

  it("records every run for auditing", async () => {
    const { service, database } = createSetupHarness();

    await service.run(guild, "logging");
    await service.run(guild, "logging");

    expect(database.setupRuns).toHaveLength(2);
    expect(database.setupRuns[0]).toMatchObject({ scope: "logging", status: "completed" });
  });

  it("persists completed sections", async () => {
    const { service, database } = createSetupHarness();
    await service.run(guild, "core");

    const stored = database.settings.get(SETUP_GUILD_ID) as {
      setup: { resources: Record<string, string>; completedSections: string[] };
    };
    expect(stored.setup.completedSections).toContain("core");
  });

  it("does not persist V1 module resources in the tracked resource map", async () => {
    const { service, database } = createSetupHarness();
    await service.run(guild, "core");

    const stored = database.settings.get(SETUP_GUILD_ID) as {
      setup: { resources: Record<string, string>; completedSections: string[] };
    };
    // V2 rule: only the automatic setup module owns tracked identifiers, because
    // resource identity lives in `setup_resources` and a flat name-keyed map would
    // go stale the moment an administrator renames a channel.
    expect(Object.keys(stored.setup.resources)).toEqual([]);
  });

  it("reuses resources that already exist on Discord", async () => {
    const { service, discord } = createSetupHarness();
    discord.seed("category", "Bot", "existing-category");

    const report = await service.run(guild, "core");
    const action = report.results.find((entry) => entry.key === "core.category");

    expect(action?.status).toBe("reused");
    expect(action?.resourceId).toBe("existing-category");
  });
});

describe("SetupService failure handling", () => {
  it("reports a partial run when one module keeps failing", async () => {
    const failing: BotModule = {
      name: "logging",
      description: "Always fails.",
      enabled: () => true,
      plan: () => [
        {
          key: "boom",
          description: "Always fails",
          run: () => Promise.reject(new Error("discord exploded")),
        },
      ],
    };

    const { service } = createSetupHarness([coreModule, failing]);
    const report = await service.run(guild, "all");

    expect(report.status).toBe("partial");
    expect(report.failed).toBe(1);
    expect(report.results.find((entry) => entry.status === "failed")?.errorMessage).toBe(
      "discord exploded",
    );
  });

  it("rejects an unknown section", async () => {
    const { service } = createSetupHarness();
    await expect(service.run(guild, "nonsense" as never)).rejects.toThrow(
      /No setup module registered/,
    );
  });

  it("enforces permissions when a caller is supplied", async () => {
    const { service } = createSetupHarness();
    await expect(service.run(guild, "all", memberStub({ permissions: [] }))).rejects.toThrow(
      PermissionError,
    );
  });

  it("skips disabled modules without creating resources", async () => {
    const { service, discord } = createSetupHarness([loggingModule]);
    const report = await service.run(guild, "logging");

    expect(report.created).toBe(0);
    expect(report.skipped).toBe(1);
    expect(discord.created).toEqual([]);
  });
});
